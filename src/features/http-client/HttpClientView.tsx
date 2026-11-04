/**
 * HTTP Client 工具窗口：左侧历史列表 + 右侧选中交换的详情。
 *
 * 移植自 openidea `features/http-client/HttpClientView.tsx`，按 forge 约定重写：
 * zustand → 外部 store，`@/ui` → forge `src/ui`，`tx` → `useI18n().t`。
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import clsx from "clsx";
import ContextMenu from "../../components/ContextMenu";
import { EmptyState, IconButton, Spinner, SplitGroup, SplitHandle, SplitPanel, Tabs } from "../../ui";
import { useI18n } from "../../i18n";
import { MOD_LABEL } from "../../lib/sys";
import { describeError } from "../../lib/errors";
import { errorText } from "../../lib/fs";
import { isHttpCancelled } from "../../lib/httpFile";
import { notificationCenter } from "../../lib/notifications";
import { bodyKind, formatMs, formatSize, prettyBody, type BodyKind } from "./format";
import {
  cancelRunning,
  clearHistory,
  httpClientSnapshot,
  refreshHistory,
  removeHistoryEntry,
  retryHistoryEntry,
  selectEntry,
  subscribeHttpClient,
  subscribeHttpHistoryError,
  type HttpExchange,
  type HttpHistoryEntry,
} from "./store";
import styles from "./HttpClient.module.css";

// 只有完整 PDF 正文才加载解析器；加载失败保留 HTTP 面板与其它页签。
const PdfPreview = lazy(() => import("./PdfPreview").catch(() => ({
  default: function PdfLoadError() {
    const { t } = useI18n();
    return <EmptyState title={t("http.pdfInvalid")} />;
  },
})));

function useHttpClient() {
  return useSyncExternalStore(subscribeHttpClient, httpClientSnapshot);
}

function useHttpProblem() {
  const { t } = useI18n();
  return useCallback((cause: unknown) => {
    // 停止重新请求是用户动作，不应弹出失败通知。
    if (isHttpCancelled(errorText(cause))) return;
    notificationCenter.notify({
      key: "http-client",
      groupId: "system",
      title: t("notifications.error"),
      content: describeError(errorText(cause), t),
      level: "error",
    });
  }, [t]);
}

/** 状态码的分档：2xx 正常、3xx 重定向、其余失败、无码是没跑成。 */
function statusTone(status: number | null): string {
  if (status === null) return styles.statusError;
  if (status < 300) return styles.statusOk;
  if (status < 400) return styles.statusRedirect;
  return styles.statusError;
}

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** 历史里存的是错误码。状态行和正文要显示翻译后的句子。 */
function shownError(error: string | null, fallback: string, t: Parameters<typeof describeError>[1]): string {
  if (!error) return fallback;
  return describeError(error, t) || fallback;
}

function EntryRow({
  entry,
  active,
  onClick,
  onContextMenu,
}: {
  entry: HttpHistoryEntry;
  active: boolean;
  onClick: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={clsx(styles.entry, active && styles.entryActive)}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={entry.error ? shownError(entry.error, entry.url, t) : entry.url}
    >
      <span className={clsx(styles.status, statusTone(entry.status))}>{entry.status ?? "ERR"}</span>
      <span className={styles.method}>{entry.method}</span>
      <span className={styles.url}>{entry.name ?? entry.url}</span>
      <span className={styles.when}>{time(entry.timeMs)}</span>
    </button>
  );
}

type DetailTab = "body" | "headers" | "request";

type HttpCodeKind = BodyKind | "http";

/** 语法按需加载；正文只经现有高亮器转义后生成 span，不能作为 HTML 执行。 */
function HighlightedBody({ text, kind }: { text: string; kind: HttpCodeKind }) {
  const [highlighted, setHighlighted] = useState<{ text: string; kind: HttpCodeKind; html: string } | null>(null);

  useEffect(() => {
    if (kind === "text") return;
    let alive = true;
    void import("../../lib/cm/grammars").then(async ({ prepareHighlight, highlightCodeHtml }) => {
      await prepareHighlight([kind]);
      if (!alive) return;
      const html = highlightCodeHtml(text, kind);
      if (html !== null) setHighlighted({ text, kind, html });
    }).catch(() => {
      // 语法包加载失败仍保留原文，不能把已有的响应变成错误页。
    });
    return () => { alive = false; };
  }, [text, kind]);

  // 切换记录或原文/美化模式时，旧的异步结果不能覆盖当前正文。
  return highlighted?.text === text && highlighted.kind === kind
    ? <code className="syntax-highlight" dangerouslySetInnerHTML={{ __html: highlighted.html }} />
    : <code>{text}</code>;
}

function HeaderTable({ headers }: { headers: [string, string][] }) {
  if (!headers.length) return null;
  return (
    <table className={styles.headers}>
      <tbody>
        {headers.map(([name, value], i) => (
          <tr key={`${name}-${i}`}>
            <th scope="row">{name}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ExchangeView({ exchange }: { exchange: HttpExchange }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<DetailTab>("body");
  const [raw, setRaw] = useState(false);
  const response = exchange.response;
  // 新记录包含传输层补全的头；旧历史仍展示当时保存的请求头。
  const requestHeaders = exchange.request.sentHeaders ?? exchange.request.headers;
  // 请求行和全部头部集中展示，重复头按保存顺序保留；正文按自身类型单独高亮。
  const requestHead = [
    `${exchange.request.method} ${exchange.request.url}`,
    ...requestHeaders.map(([name, value]) => `${name}: ${value}`),
  ].join("\n");
  // 二进制正文是 null，不当成某种可美化的类型，美化按钮也不出现。
  const kind = useMemo(
    () => (response?.body == null ? "text" : bodyKind(response.contentType, response.body)),
    [response]
  );

  const shown = useMemo(() => {
    if (response?.body == null) return "";
    if (raw) return response.body;
    return prettyBody(kind, response.body);
  }, [response, raw, kind]);

  const requestBodyKind = useMemo(() => bodyKind(
    exchange.request.headers.find(([name]) => name.toLowerCase() === "content-type")?.[1],
    exchange.request.body ?? "",
  ), [exchange.request]);

  const labels: Record<DetailTab, string> = {
    body: t("http.tabBody"),
    headers: response ? `${t("http.tabHeaders")} (${response.headers.length})` : t("http.tabHeaders"),
    request: t("http.tabRequest"),
  };

  // 二进制正文没得展示：截断、部分响应、空正文和旧历史（没有保存字节）分开说明。
  const binaryHint = !response ? ""
    : response.truncated ? t("http.pdfTruncated")
    : response.size === 0 ? t("http.noBody")
    : response.status === 200 && response.contentType?.split(";")[0].trim().toLowerCase() === "application/pdf"
      ? t("http.pdfMissingBytes")
    : `${response.contentType ?? t("http.unknownType")} · ${formatSize(response.size)}`;

  return (
    <div className={styles.exchange}>
      <div className={styles.statusLine}>
        {response ? (
          <>
            <span className={clsx(styles.status, statusTone(response.status))}>
              {`${response.status} ${response.statusText}`.trim()}
            </span>
            <span className={styles.meta}>{response.version}</span>
            <span className={styles.meta} title={t("http.ttfb", { ms: formatMs(response.ttfbMs) })}>
              {formatMs(response.totalMs)}
            </span>
            <span className={styles.meta}>{formatSize(response.size)}</span>
          </>
        ) : (
          <span className={clsx(styles.status, styles.statusError)}>
            {shownError(exchange.entry.error, t("http.failed"), t)}
          </span>
        )}
        <span className={styles.requestLine}>
          {`${exchange.request.method} ${exchange.request.url}`}
        </span>
      </div>

      <Tabs
        variant="compact"
        activeId={tab}
        onSelect={(id) => setTab(id as DetailTab)}
        aria-label={t("http.title")}
        items={[
          { id: "body", label: labels.body },
          { id: "headers", label: labels.headers },
          { id: "request", label: labels.request },
        ]}
        trailing={
          tab === "body" && kind !== "text" ? (
            <IconButton
              icon="soft-wrap"
              title={raw ? t("http.showPretty") : t("http.showRaw")}
              pressed={raw}
              onClick={() => setRaw((value) => !value)}
            />
          ) : undefined
        }
      />

      <div className={styles.tabBody}>
        {tab === "body" ? (
          response ? (
            response.bodyBase64 ? (
              <Suspense fallback={<div className={styles.center}><Spinner /></div>}>
                <PdfPreview base64={response.bodyBase64} />
              </Suspense>
            ) : response.body === null ? (
              <EmptyState title={t("http.binaryBody")}>{binaryHint}</EmptyState>
            ) : (
              <pre className={styles.pre} aria-label={t("http.tabBody")}>
                <HighlightedBody text={shown} kind={kind} />
                {response.truncated ? (
                  <span className={styles.truncated}>
                    {`\n${t("http.truncatedBody", { size: formatSize(response.size) })}`}
                  </span>
                ) : null}
              </pre>
            )
          ) : (
            <pre className={styles.pre}>{shownError(exchange.entry.error, t("http.noResponse"), t)}</pre>
          )
        ) : tab === "headers" ? (
          <HeaderTable headers={response?.headers ?? []} />
        ) : (
          <pre className={styles.pre} aria-label={t("http.tabRequest")}>
            <HighlightedBody text={requestHead} kind="http" />
            {exchange.request.body ? (
              <>
                {"\n\n"}
                <HighlightedBody text={exchange.request.body} kind={requestBodyKind} />
              </>
            ) : null}
          </pre>
        )}
      </div>
    </div>
  );
}

export function HttpClientView() {
  const { t } = useI18n();
  const { history, exchanges, running, selected, rootEpoch } = useHttpClient();
  const exchange = selected ? exchanges[selected] : undefined;
  /** null 表示还没拖过，用 32%。拖过之后记像素。 */
  const [listWidth, setListWidth] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; rootEpoch: number } | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const report = useHttpProblem();
  const clampList = (next: number) => {
    const total = frameRef.current?.clientWidth ?? 0;
    // 右侧响应至少留 200px，和 openidea 的响应栏最小宽度一致。
    const cap = total > 360 ? total - 200 : next;
    return Math.min(cap, Math.max(160, next));
  };

  useEffect(() => subscribeHttpHistoryError(report), [report]);
  useEffect(() => {
    void refreshHistory().catch(report);
  }, [report]);

  return (
    <div ref={frameRef} className={styles.root}>
      <SplitGroup direction="horizontal" className={styles.split}>
        <SplitPanel size={listWidth ?? "32%"} minSize={160} className={styles.splitLeft}>
          <div className={styles.list} role="list" aria-label={t("http.history")}>
            {running ? (
              <div className={styles.runningRow}>
                <Spinner size={12} />
                <span>{t("http.sending", { name: running.label })}</span>
              </div>
            ) : null}
            {history.length === 0 && !running ? (
              <EmptyState title={t("http.noHistory")}>
                {t("http.hint", { shortcut: `${MOD_LABEL}+Enter` })}
              </EmptyState>
            ) : (
              history.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  active={selected === entry.id}
                  onClick={() => void selectEntry(entry.id).catch(report)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void selectEntry(entry.id).catch(report);
                    setMenu({ id: entry.id, x: event.clientX, y: event.clientY, rootEpoch });
                  }}
                />
              ))
            )}
          </div>
        </SplitPanel>
        <SplitHandle
          aria-label={t("http.resizeList")}
          onDelta={(delta) =>
            setListWidth((w) => {
              const base = w ?? Math.round((frameRef.current?.clientWidth ?? 0) * 0.32);
              return clampList(base + delta);
            })
          }
          onReset={() => setListWidth(null)}
        />
        <SplitPanel minSize={200} className={styles.splitRight}>
          {exchange ? (
            <ExchangeView key={exchange.entry.id} exchange={exchange} />
          ) : selected ? (
            <div className={styles.center}>
              <Spinner />
            </div>
          ) : (
            <EmptyState title={t("http.pickEntry")} />
          )}
        </SplitPanel>
      </SplitGroup>
      {/* 菜单绑定这一条历史；换工作区或记录消失后不能继续操作旧目标。 */}
      {menu && menu.rootEpoch === rootEpoch && history.some((entry) => entry.id === menu.id) ? (
        <ContextMenu
          anchor={{
            x: menu.x,
            y: menu.y,
            items: [
              { label: t("http.retryRequest"), icon: "refresh", onSelect: () => void retryHistoryEntry(menu.id).catch(report) },
              { label: t("http.deleteEntry"), icon: "trash", danger: true, onSelect: () => void removeHistoryEntry(menu.id).catch(report) },
            ],
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}

/** 工具窗口头部：停止、重载历史、清空。环境选择在 `.http` 编辑器工具栏上。 */
export function HttpClientHeaderActions() {
  const { t } = useI18n();
  const { running } = useHttpClient();
  const report = useHttpProblem();
  return (
    <>
      <IconButton icon="stop" title={t("http.stop")} disabled={!running} onClick={cancelRunning} />
      <IconButton
        icon="refresh"
        title={t("http.reloadHistory")}
        onClick={() => void refreshHistory().catch(report)}
      />
      <IconButton
        icon="trash"
        title={t("http.clearHistory")}
        onClick={() => void clearHistory().catch(report)}
      />
    </>
  );
}
