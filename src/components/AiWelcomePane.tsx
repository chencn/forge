import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Lightbulb, Plus, Send, Settings, X } from "lucide-react";
import { useI18n } from "../i18n";
import { availableAiProviders, cliDesktopAvailable, orderedAiProviders, useAiCli, useAiCliSettings } from "../lib/aiCli";
import type { AiProvider } from "../lib/aiCli";
import { assetUrl } from "../lib/fs";
import { useAiChatWidth } from "../lib/aiChatWidth";
import { aiDraftOptionsKey, loadAiDraftProvider, saveAiDraftProvider } from "../lib/aiDraftSession";
import { collectPastedImages } from "../lib/aiClipboard";
import { clearDraft, loadDraft, saveDraft, updateDraftImages, useDraftImages, type DraftImageAttachment } from "../lib/aiDrafts";
import { loadAiOptions, saveAiOptions } from "../lib/aiOptions";
import { commandSuggestions, completeCommand, filterCommandSuggestions, localCommand, parseSlash } from "../lib/aiCommands";
import type { AiRunOptions } from "../lib/aiRuntime";
import AiAgentPills from "./AiAgentPills";
import AiCommandMenu from "./AiCommandMenu";
import AiComposerShell from "./AiComposerShell";
import AiComposerOptions, { type AiComposerHandle } from "./AiComposerOptions";
import AiImageDialog from "./AiImageDialog";
import { watchAiInputDelivery } from "../lib/aiInputBridge";

/** 选择器里的筛选提示；真正认格式的是后端的文件头嗅探，扩展名写错也骗不过去。 */
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];

interface PastedImage { path: string; preview: string; name: string }

/** 底部小提示的键集；挂载时随机挑一条，不随重渲染换样。 */
const WELCOME_TIP_KEYS = ["ai.welcome.tip1", "ai.welcome.tip2", "ai.welcome.tip3", "ai.welcome.tip4", "ai.welcome.tip5", "ai.welcome.tip6"] as const;

/** 提示文案里 `⟦…⟧` 包住的部分渲染成键帽（对照参考实现的 kbd 标签）。 */
function WelcomeTipText({ text }: { text: string }) {
  const parts = text.split(/(⟦[^⟧]*⟧)/);
  return <>{parts.map((part, index) => part.startsWith("⟦") && part.endsWith("⟧")
    ? <kbd key={index} className="ai-kbd">{part.slice(1, -1)}</kbd>
    : <span key={index}>{part}</span>)}</>;
}

interface AiWelcomePaneProps {
  /** 当前项目根；为 null（非桌面端/未开项目）时只能看不能发。 */
  workspace: string | null;
  /** 发送前的最后检查；返回 false 则中止（例如项目里还有未保存文件）。 */
  beforeSend?: () => boolean | Promise<boolean>;
  /** 首条消息就绪：由上层创建会话、切换标签并交给会话页自动发出。 */
  onLaunch: (provider: AiProvider, text: string, images: string[]) => Promise<void>;
  /** 打开设置页的 AI 助手模块。 */
  onSettings: () => void;
}

/**
 * 「新建会话」草稿页。对照参考实现的欢迎屏：垂直居中一列——渐变大标题、
 * 工具胶囊选择器（滑块随选中项滑动）、输入框——底部钉一条随机小提示。
 * 参考实现里标题下方的「代码开发 / 日常办公 / 科学研究」快捷卡与技能栏按需求不移植。
 *
 * 会话在这一页并不存在：第一条消息发出时才由上层真正创建（`onLaunch`），
 * 输入框草稿按工作区落在本地，重开应用还能找回。输入框本身沿用会话页的
 * 结构与样式（附件、自动增高、选项行），保证两页看起来是一体的。
 */
export default function AiWelcomePane({ workspace, beforeSend, onLaunch, onSettings }: AiWelcomePaneProps) {
  const { t } = useI18n();
  const cli = useAiCli();
  const store = useAiCliSettings();
  const desktop = cliDesktopAvailable();
  const allProviders = orderedAiProviders(store.settings);
  const available = useMemo(() => desktop ? availableAiProviders(cli.statuses, store.settings) : [], [desktop, cli.statuses, store.settings]);
  const disabledProvider = (provider: AiProvider) => store.settings.agents[provider].enabled === false;
  /** 选中的工具按工作区记忆；记住的已不可用时回落到第一个可用项。 */
  const [preferred, setPreferred] = useState<AiProvider | null>(() => loadAiDraftProvider(workspace));
  const provider = preferred && available.includes(preferred) ? preferred : available[0] ?? null;
  const optionsKey = aiDraftOptionsKey(provider ?? "claude");
  const [options, setOptions] = useState<AiRunOptions>(() => loadAiOptions(optionsKey, provider ?? "claude"));
  // 两个引擎的档位不相同（Codex 只读、Fast、模型 id）；切工具必须换成那份配置，
  // 否则 Codex 的只读会被带进 Claude 并变成 plan 权限。
  useEffect(() => { if (provider) setOptions(loadAiOptions(optionsKey, provider)); }, [optionsKey, provider]);
  const [draft, setDraft] = useState(() => loadDraft(workspace, "draft"));
  const attachments = useDraftImages(workspace, "draft");
  const images = useMemo(() => attachments.map((image) => ({ ...image, preview: assetUrl(image.path, 0) })), [attachments]);
  /** 异步保存尚未回填 state 时也要占名额，防止连续粘贴越过上限。 */
  const pendingImages = useRef(0);
  /** 每条消息的附件上限；真实数字来自后端。 */
  const [imageLimit, setImageLimit] = useState(8);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const composer = useRef<AiComposerHandle>(null);
  const commandMenu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandsDismissed, setCommandsDismissed] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const chatWidth = useAiChatWidth();
  /** 图片放大预览：存沙箱里的副本路径；null 表示关着。 */
  const [lightbox, setLightbox] = useState<string | null>(null);
  const tipKey = useMemo(() => WELCOME_TIP_KEYS[Math.floor(Math.random() * WELCOME_TIP_KEYS.length)], []);
  const tip = t(tipKey);
  // 新建页还没有 CLI 会话，只列本地命令与可安全映射的 Codex 命令；Claude 原生命令创建会话后再发现。
  const commandList = provider ? commandSuggestions(provider).filter((command) => command.local !== "context") : [];
  const suggestions = commandsDismissed ? [] : showHelp ? commandList : filterCommandSuggestions(commandList, draft);
  const selectedCommand = Math.min(commandIndex, Math.max(0, suggestions.length - 1));
  const menuVisible = suggestions.length > 0 && !sending;

  useEffect(() => {
    setDraft(loadDraft(workspace, "draft"));
  }, [workspace]);
  // 浏览器标记复用普通草稿投递，不触发创建会话或自动发送。
  useEffect(() => watchAiInputDelivery(workspace, "draft", (delivery) => {
    setDraft(delivery.text);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(delivery.text.length, delivery.text.length);
    });
  }), [workspace]);
  useEffect(() => {
    if (!menuVisible) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target !== input.current && !commandMenu.current?.contains(event.target as Node)) {
        setCommandsDismissed(true); setShowHelp(false);
      }
    };
    window.addEventListener("pointerdown", dismiss, true);
    return () => window.removeEventListener("pointerdown", dismiss, true);
  }, [menuVisible]);
  useEffect(() => { document.getElementById(`${menuId}-${selectedCommand}`)?.scrollIntoView?.({ block: "nearest" }); }, [menuId, selectedCommand]);
  useEffect(() => {
    if (!cliDesktopAvailable()) return;
    void invoke<{ maxImages: number }>("ai_runtime_image_limits").then(({ maxImages }) => setImageLimit(maxImages)).catch(() => {});
  }, []);
  // 输入框高度随内容走，与会话页同一套上下限。
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(240, Math.max(52, element.scrollHeight))}px`;
  }, [draft]);
  // 草稿随打字落盘：欢迎页关掉或应用重启都不丢。命令执行清空草稿时不一定要关闭帮助菜单。
  const commitDraft = (text: string) => {
    setDraft(text);
    if (text) saveDraft(workspace, "draft", text); else clearDraft(workspace, "draft");
  };
  const updateDraft = (text: string) => {
    commitDraft(text);
    setCommandsDismissed(false); setShowHelp(false); setCommandIndex(0); setError(null);
  };
  /** 新建页也会在切标签时卸载；每次附件变更都要和正文一样进入工作区草稿。 */
  const updateImages = (change: (current: DraftImageAttachment[]) => DraftImageAttachment[]) => updateDraftImages(workspace, "draft", change);
  const chooseCommand = (name: string) => { updateDraft(completeCommand(draft, name)); input.current?.focus(); };
  const changeOptions = (next: AiRunOptions) => {
    setOptions(next);
    try { saveAiOptions(optionsKey, provider ?? "claude", next); } catch { setError(t("ai.storageError")); }
  };
  /** 剪贴板里的图片由前端读成 data URL，后端只按文件头复核；回显直接用同一份 data URL。 */
  const pasteImage = (file: File) => new Promise<PastedImage>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t("ai.chat.imageReadFailed")));
    reader.onload = () => {
      const preview = typeof reader.result === "string" ? reader.result : "";
      if (!preview) { reject(new Error(t("ai.chat.imageReadFailed"))); return; }
      invoke<{ path: string }>("ai_runtime_save_pasted_image", { dataUrl: preview })
        .then(({ path }) => resolve({ path, preview, name: file.name || t("ai.chat.pastedImage") }), reject);
    };
    reader.readAsDataURL(file);
  });
  /** 已落进附件区的图片统一走这份结算：超上限报错、失败的报第一句原因。 */
  const settle = (tasks: Promise<PastedImage>[]) => {
    if (!tasks.length) return;
    if (images.length + pendingImages.current + tasks.length > imageLimit) { setError(t("ai.chat.tooManyImages", { count: imageLimit })); return; }
    pendingImages.current += tasks.length;
    void Promise.allSettled(tasks).then((results) => {
      const saved = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      const failed = results.find((result) => result.status === "rejected");
      if (saved.length) updateImages((current) => [...current, ...saved]);
      setError(failed ? String((failed as PromiseRejectedResult).reason) : null);
    }).finally(() => { pendingImages.current = Math.max(0, pendingImages.current - tasks.length); });
  };
  /** 本机绝对路径（选择器给的是）：复制进沙箱后 CLI 只读副本，原文件既不动也不授权。 */
  const attachPaths = (paths: readonly string[]) => settle(paths.map((path) => invoke<{ path: string; name?: string }>("ai_runtime_save_image_file", { path })
    .then(({ path: saved, name }) => ({ path: saved, preview: assetUrl(saved, 0), name: name || t("ai.chat.pastedImage") }))));
  const pickImages = async () => {
    try {
      const picked = await open({ multiple: true, filters: [{ name: t("ai.chat.imageFilter"), extensions: IMAGE_EXTENSIONS }] });
      if (picked) attachPaths(Array.isArray(picked) ? picked : [picked]);
    } catch (cause) { setError(String(cause)); }
  };
  /** 首条消息：创建交给上层，这里的草稿与附件随交接清空。 */
  const launch = async () => {
    if (!provider || !workspace || sending) return;
    if (!draft.trim() && !images.length) return;
    setSending(true);
    try {
      const slash = parseSlash(draft);
      const local = slash && localCommand(slash.name);
      if (slash && images.length) throw new Error(t("ai.chat.imageCommandConflict"));
      if (slash && !slash.name) {
        setShowHelp(true); setCommandsDismissed(false); setCommandIndex(0);
        return;
      }
      // 新建页能直接完成不依赖会话历史的命令；/context 留给创建后的会话处理。
      if (slash && local && local !== "context") {
        if (local === "help") {
          if (slash.args.trim()) throw new Error(t("ai.commands.invalidArgs"));
          commitDraft("");
          setShowHelp(true); setCommandsDismissed(false); setCommandIndex(0);
        } else {
          if (!composer.current) return;
          await composer.current.execute(local, slash.args);
          updateDraft("");
        }
        return;
      }
      if (beforeSend && !await beforeSend()) return;
      // 创建会话与草稿清理是一笔事务：上层确认创建成功后，才允许丢掉正文和附件。
      await onLaunch(provider, draft, images.map((image) => image.path));
      // 创建期间新输入的正文和文件引用留给下一条消息。
      if (loadDraft(workspace, "draft") === draft) updateDraft("");
      // 发送期间新加入的附件不属于这条消息，继续留在草稿。
      updateImages((current) => current.filter((image) => !images.some((sent) => sent.path === image.path)));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSending(false);
    }
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (menuVisible && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setCommandIndex((selectedCommand + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Tab" && !event.shiftKey || event.key === "Enter" && !event.shiftKey) {
        event.preventDefault(); chooseCommand(suggestions[selectedCommand].name); return;
      }
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); setCommandsDismissed(true); setShowHelp(false); return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void launch();
    }
  };

  const pills = allProviders.map((item) => ({
    provider: item,
    usable: available.includes(item),
    unavailableHint: disabledProvider(item) ? t("ai.allDisabled") : t("ai.installFirst"),
  }));

  return (
    <section className="ai-welcome" aria-label={t("ai.newSession")}
      style={{ "--ai-content-width": `${chatWidth.width}px` } as CSSProperties}>
      <div className="ai-welcome-scroll">
        <div className="ai-welcome-spacer" />
        <div className="ai-welcome-column">
          <h1 className="ai-welcome-title">
            {t("ai.welcome.titleBefore")}<span className="ai-welcome-accent">{t("ai.welcome.titleAccent")}</span>{t("ai.welcome.titleAfter")}
          </h1>
          {available.length ? (
            <AiAgentPills className="ai-agent-row" pills={pills} selected={provider}
              onSelect={(next) => { setPreferred(next); saveAiDraftProvider(workspace, next); }} />
          ) : (
            <div className="ai-agent-empty">
              <p>{t("ai.installFirst")}</p>
              <button type="button" className="button" onClick={onSettings}><Settings size={14} aria-hidden />{t("ai.manageCli")}</button>
            </div>
          )}
          <div className="ai-composer-wrap">
            <AiComposerShell
              tall
              overlay={menuVisible ? <AiCommandMenu id={menuId} suggestions={suggestions} selected={selectedCommand}
                onChoose={chooseCommand} menuRef={commandMenu} showDiscovery={provider === "claude"} /> : null}
              attachments={images.length ? <div className="ai-image-attachments" aria-label={t("ai.chat.images")}>
                {images.map((image) => <figure key={image.path}><button type="button" className="ai-msg-image" aria-label={t("ai.chat.previewImage")} title={t("ai.chat.previewImage")} onClick={() => setLightbox(image.path)}><img src={image.preview} alt={image.name} /></button><button type="button" className="ai-image-remove" aria-label={`${t("ai.chat.removeImage")} ${image.name}`} title={t("ai.chat.removeImage")}
                  onClick={() => { updateImages((current) => current.filter((item) => item.path !== image.path)); void invoke("ai_runtime_delete_image", { path: image.path }).catch(() => {}); }}><X size={12} /></button></figure>)}
              </div> : null}
              editor={<textarea
                ref={input}
                rows={2}
                aria-label={t("ai.message")}
                placeholder={t("ai.runtime.placeholder")}
                value={draft}
                maxLength={16000}
                spellCheck={false}
                disabled={!desktop}
                aria-autocomplete="list"
                aria-controls={menuVisible ? menuId : undefined}
                aria-expanded={menuVisible}
                aria-activedescendant={menuVisible ? `${menuId}-${selectedCommand}` : undefined}
                onChange={(event) => updateDraft(event.target.value)}
                onKeyDown={onKeyDown}
                onPaste={(event) => {
                  const files = collectPastedImages(event.clipboardData);
                  if (!files.length) return;
                  event.preventDefault();
                  settle(files.map(pasteImage));
                }}
              />}
              footer={error ? <div className="ai-composer-notices"><p className="ai-error" role="alert">{error}</p></div> : null}
              toolbarLeft={<>
                <button type="button" className="ai-add-button" aria-label={t("ai.chat.attach")} title={t("ai.chat.attach")}
                  disabled={!desktop || !provider || images.length + pendingImages.current >= imageLimit}
                  onClick={() => void pickImages()}><Plus size={16} /></button>
                <AiComposerOptions commandRef={composer} key={provider ?? "none"} provider={provider ?? "claude"} workspace={workspace}
                  value={options} onChange={changeOptions} disabled={!provider} />
              </>}
              toolbarRight={<button type="button" className="ai-send-button" aria-label={t("ai.send")} title={t("ai.send")}
                disabled={!provider || !workspace || !desktop || !draft.trim() && !images.length || sending} onClick={() => void launch()}>
                <Send size={16} />
              </button>}
            />
          </div>
        </div>
        <div className="ai-welcome-spacer" />
      </div>
      <div className="ai-welcome-tip">
        <span className="ai-welcome-tip-pill"><Lightbulb size={14} aria-hidden /><WelcomeTipText text={tip} /></span>
      </div>
      <AiImageDialog path={lightbox} onClose={() => setLightbox(null)} />
    </section>
  );
}
