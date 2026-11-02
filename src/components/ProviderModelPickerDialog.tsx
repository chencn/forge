import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useI18n } from "../i18n";
import AiActionDialog from "./AiActionDialog";
import { listProviderModels } from "../lib/aiManage";
import type { AiProvider } from "../lib/aiCli";

interface ProviderModelPickerProps {
  kind: AiProvider;
  apiUrl: string;
  apiKey: string;
  onClose: () => void;
  /**
   * 每行尾部的动作（Claude 选槽位填值、Codex 追加为自定义条目），由调用方渲染。
   * 动作完成后对话框保持打开，方便一次拉取填多个位置。
   */
  renderAction: (modelId: string) => ReactNode;
}

/**
 * 端点模型选择器：打开即拉 `GET {base}/v1/models`，搜索过滤后逐行渲染调用方的动作。
 * 拉取失败给重试；列表为空要明说，别让人对着一张白纸猜端点坏了还是没模型。
 */
export default function ProviderModelPickerDialog({ kind, apiUrl, apiKey, onClose, renderAction }: ProviderModelPickerProps) {
  const { t } = useI18n();
  const [models, setModels] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  const fetchList = () => {
    setLoading(true);
    setError(null);
    listProviderModels(kind, apiUrl, apiKey)
      .then((items) => setModels(items))
      .catch((err) => setError(t("providers.fetchModelsFailed", { message: String(err) })))
      .finally(() => setLoading(false));
  };
  useEffect(() => { fetchList(); }, []);

  const keyword = query.trim().toLowerCase();
  const visible = (models ?? []).filter((id) => !keyword || id.toLowerCase().includes(keyword));

  return (
    <AiActionDialog title={t("providers.fetchModels")} confirm={t("dialog.close")}
      onCancel={onClose} onConfirm={() => onClose()}>
      {loading ? <p className="dialog-body" role="status"><Loader2 size={13} className="is-spinning" /> {t("ai.cfg.loading")}</p> : null}
      {!loading && error ? (
        <>
          <p className="ai-error" role="alert">{error}</p>
          <div className="dialog-actions">
            <button type="button" className="panel-action" onClick={fetchList}>
              <RefreshCw size={13} />{t("ai.catalog.reload")}
            </button>
          </div>
        </>
      ) : null}
      {!loading && !error && models !== null ? (
        <>
          <input className="text-input" spellCheck={false} placeholder={t("providers.fetchModelsSearch")}
            value={query}
            /* 对话框是 <form>，敲 Enter 会触发提交按钮把选择器关掉，这里拦掉。 */
            onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
            onChange={(event) => setQuery(event.target.value)} />
          <div className="provider-model-list">
            {visible.map((id) => (
              <div className="provider-model-row" key={id}>
                <code className="provider-model-id">{id}</code>
                {renderAction(id)}
              </div>
            ))}
            {visible.length === 0 ? <p className="ai-muted">{t("providers.fetchModelsEmpty")}</p> : null}
          </div>
        </>
      ) : null}
    </AiActionDialog>
  );
}
