import { useI18n } from "../i18n";
import { compareModels } from "../lib/aiModelMatch";

/**
 * 「请求的模型 ≠ 实际服务的模型」徽章。
 *
 * 一致时不出声：那没有信息；判定不了也不出声——没选模型时沿用 CLI 默认，而我们不知道
 * 默认是什么，标一个「已按请求服务」是假话。文案只说差异类别，具体 id 摆在标题里。
 */
export default function AiModelMatchBadge({ requested, served, aliases }: { requested?: string; served?: string; aliases?: Record<string, string> }) {
  const { t } = useI18n();
  const verdict = compareModels(requested, served, aliases);
  if (verdict !== "variant" && verdict !== "mismatch") return null;
  const label = t(verdict === "variant" ? "ai.chat.modelVariant" : "ai.chat.modelMismatch");
  const detail = `${label} · ${requested} → ${served}`;
  return <span className={`ai-model-match is-${verdict}`} title={detail} aria-label={detail}>{served}</span>;
}
