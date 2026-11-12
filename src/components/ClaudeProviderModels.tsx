import { useEffect, useId, useRef, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { ChevronDown, Loader2 } from "lucide-react";
import { useI18n } from "../i18n";
import type { TranslationKey } from "../i18n/lang/zh";
import { CLAUDE_MODEL_SLOTS, listProviderModels, type ClaudeModelSlot } from "../lib/aiManage";
import { Checkbox } from "../ui/Checkbox";
import styles from "./ClaudeProviderModels.module.css";

/** 八个模型槽位的标签和手填示例，按供应商配置顺序展示。 */
const FIELDS: Record<ClaudeModelSlot, {
  /** 字段名称的翻译键。 */
  label: TranslationKey;
  /** 空值示例。 */
  placeholder: string;
}> = {
  main: { label: "providers.claudeMainModel", placeholder: "claude-sonnet-5-5" },
  reasoning: { label: "providers.claudeReasoningModel", placeholder: "claude-opus-5-5" },
  haiku: { label: "providers.claudeHaikuDefaultModel", placeholder: "claude-haiku-5-5" },
  sonnet: { label: "providers.claudeSonnetDefaultModel", placeholder: "claude-sonnet-5-5" },
  opus: { label: "providers.claudeOpusDefaultModel", placeholder: "claude-opus-5-5" },
  fable: { label: "providers.claudeFableDefaultModel", placeholder: "claude-fable-5-1" },
  autoMode: { label: "providers.claudeAutoModeModel", placeholder: "claude-haiku-5-5" },
  subagent: { label: "providers.claudeSubagentModel", placeholder: "claude-haiku-5-5" },
};

/** Claude CLI 的百万上下文标记；允许手填时使用大写 M。 */
const MILLION_CONTEXT = /(?:\[1m\])+\s*$/i;

/** 单个模型输入框的候选列表与持久化值。 */
interface ModelFieldProps {
  /** 字段的可访问名称。 */
  label: string;
  /** 未填写时显示的模型示例。 */
  placeholder: string;
  /** 原始模型 ID，包含可选的 [1m] 后缀。 */
  value: string;
  /** 同一端点提供的候选 ID。 */
  models: string[];
  /** 正在获取候选列表。 */
  loading: boolean;
  /** 当前请求失败时显示的错误；null 表示没有错误。 */
  error: string | null;
  /** 写回模型 ID；空值清除配置。 */
  onChange: (value: string) => void;
  /** 打开下拉时按需获取模型。 */
  onOpen: () => void;
}

/**
 * 编辑模型 ID，并将 1M 选择直接编码到 CLI 支持的后缀中。
 * @param props - 模型值、候选与编辑回调
 * @returns 可手填的模型下拉及独立的 1M 复选框
 */
function ModelField({ label, placeholder, value, models, loading, error, onChange, onOpen }: ModelFieldProps) {
  /** 加载和无匹配状态使用统一的模型文案。 */
  const { t } = useI18n();
  /** 标签绑定可编辑输入，而不是仅绑定下拉按钮。 */
  const inputId = useId();
  /** 下拉状态独立于其他槽位。 */
  const [open, setOpen] = useState(false);
  /** 1M 状态从持久化值派生，重新打开表单时无需额外同步。 */
  const million = MILLION_CONTEXT.test(value);
  /** 候选匹配使用不含上下文后缀的 ID，输入框保留完整配置值。 */
  const modelId = value.replace(MILLION_CONTEXT, "");
  /**
   * 规范模型后缀；仅选择候选时沿用当前的 1M 状态，手填以实际文本为准。
   * @param next - 手填或选中的模型 ID，可包含 [1m]
   * @param keepMillion - 选择候选时保留当前上下文设置
   * @returns 写回模型值；清空时同时清除上下文标记
   */
  const changeModel = (next: string, keepMillion: boolean) => {
    /** 带标记的模型只保留一个规范后缀。 */
    const base = next.replace(MILLION_CONTEXT, "");
    onChange(base.trim() ? (keepMillion && million) || MILLION_CONTEXT.test(next) ? `${base.trim()}[1m]` : base : "");
  };
  /**
   * 将候选映射为完整输入值，避免下拉把当前值的上下文后缀当成额外搜索条件。
   * @param id - 端点提供的模型 ID
   * @returns 保留候选或当前 1M 设置的模型字符串
   */
  const modelLabel = (id: string) => million ? `${id.replace(MILLION_CONTEXT, "")}[1m]` : id;

  return (
    <div className="ai-cli-field">
      <Combobox.Root items={models} value={modelId || null} inputValue={value} itemToStringLabel={modelLabel} open={open}
        onOpenChange={(next) => { setOpen(next); if (next) onOpen(); }}
        onInputValueChange={(next, details) => { if (details.reason === "input-change") changeModel(next, false); }}
        onValueChange={(next) => { if (next !== null) changeModel(next, true); }}>
        <label htmlFor={inputId} className={styles.label}>{label}</label>
        <div className={styles.row}>
          <Combobox.InputGroup className={styles.inputGroup}>
            <Combobox.Input id={inputId} className={`text-input ${styles.input}`} spellCheck={false} placeholder={placeholder} />
            <Combobox.Trigger className={styles.trigger} aria-label={label}>
              <ChevronDown size={13} />
            </Combobox.Trigger>
          </Combobox.InputGroup>
          <Checkbox label="1M" aria-label={`${label} 1M`} checked={million} disabled={!modelId.trim()}
            onChange={(checked) => onChange(`${modelId.trim()}${checked ? "[1m]" : ""}`)} />
        </div>
        <Combobox.Portal>
          <Combobox.Positioner className={styles.positioner} sideOffset={4}>
            <Combobox.Popup className={styles.popup}>
              {loading || error ? <Combobox.Status className={styles.status}>
                {loading ? <><Loader2 size={13} className="is-spinning" /> {t("aiCommit.fetchingModels")}</> : error}
              </Combobox.Status> : null}
              {!loading && !error ? <Combobox.Empty className={styles.status}>{t("aiCommit.noModelsFound")}</Combobox.Empty> : null}
              <Combobox.List className={styles.list}>
                {(id: string) => <Combobox.Item key={id} value={id} className={styles.item}>{id}</Combobox.Item>}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
    </div>
  );
}

/** Claude 模型组的编辑契约。 */
interface ClaudeProviderModelsProps {
  /** 获取候选的端点；为空时只允许手填。 */
  apiUrl: string;
  /** 八个槽位的完整模型值，缺省槽位显示为空。 */
  values: Partial<Record<ClaudeModelSlot, string>>;
  /** 已处理留空回退后的有效密钥。 */
  apiKey: string;
  /** 保存或应用中禁止发起新请求。 */
  busy: boolean;
  /** 写回指定槽位，主模型由父组件映射到 model 字段。 */
  onChange: (slot: ClaudeModelSlot, value: string) => void;
}

/**
 * 让八个 Claude 模型槽位共享端点候选，仍允许输入列表之外的模型。
 * @param props - 端点、有效密钥、模型值及草稿更新回调
 * @returns 八个打开下拉时自动获取候选的模型输入框
 */
export default function ClaudeProviderModels({ apiUrl, values, apiKey, busy, onChange }: ClaudeProviderModelsProps) {
  /** 界面文案随当前语言切换。 */
  const { t } = useI18n();
  /** null 表示尚未拉取，空数组表示端点确实没有模型。 */
  const [models, setModels] = useState<string[] | null>(null);
  /** 获取中的状态供所有字段共用。 */
  const [loading, setLoading] = useState(false);
  /** 拉取错误保留到重试或切换端点。 */
  const [error, setError] = useState<string | null>(null);
  /** 请求代次与锁：防止重复请求及旧端点结果覆盖当前候选。 */
  const request = useRef({ version: 0, pending: false });

  useEffect(() => {
    setModels(null);
    setError(null);
    setLoading(false);
    request.current.pending = false;
    return () => { request.current.version += 1; };
  }, [apiUrl, apiKey]);

  /**
   * 拉取当前端点的模型列表，失败时保留手填能力。
   * @returns 请求完成后更新候选或错误；无地址、保存中或已有请求时提前返回
   * @remarks 请求错误在组件内显示，不向调用方 reject；过期结果被丢弃。
   */
  const fetchModels = async () => {
    if (busy || !apiUrl.trim() || request.current.pending) return;
    /** 此请求所属的端点代次。 */
    const version = request.current.version;
    request.current.pending = true;
    setLoading(true);
    setError(null);
    try {
      /** 后端已完成 ID 去重和排序。 */
      const items = await listProviderModels("claude", apiUrl, apiKey);
      if (version === request.current.version) setModels(items);
    } catch (cause) {
      if (version === request.current.version) setError(t("providers.fetchModelsFailed", { message: String(cause) }));
    } finally {
      if (version === request.current.version) {
        request.current.pending = false;
        setLoading(false);
      }
    }
  };

  return (
    <div className="ai-cli-grid">
      {CLAUDE_MODEL_SLOTS.map((slot) => <ModelField key={slot}
        label={t(FIELDS[slot].label)} placeholder={FIELDS[slot].placeholder}
        value={values[slot] ?? ""}
        models={models ?? []} loading={loading} error={error}
        onChange={(value) => onChange(slot, value)}
        onOpen={() => { if (models === null) void fetchModels(); }} />)}
    </div>
  );
}
