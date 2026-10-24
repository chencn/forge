import { useState } from "react";
import { useI18n } from "../i18n";
import { editedInput, allowAndRemember, allowDirectory, allowEdited, allowOnce, denyPermission, permissionOffer } from "../lib/aiApprovals";
import type { AiPermissionAnswer } from "../lib/aiApprovals";
import type { AiRequest } from "../lib/aiRuntime";

interface AiApprovalCardProps {
  /** 一条仍然有效的授权请求。 */
  request: AiRequest;
  /** 本轮正在停止：停止中不再接受任何答复。 */
  stopping: boolean;
  /** 调用方自己的占用状态（答复请求还在路上、已经答过）；按钮禁用要把它算进来，否则能连点两次。 */
  busy?: boolean;
  /** 把答复交给运行时；失败由调用方呈现。 */
  onRespond: (answer: AiPermissionAnswer) => void;
}

/**
 * 授权卡片的操作区：允许一次、本轮不再询问、按目录允许、改完再允许。
 *
 * 出现哪些按钮由 `permissionOffer` 依据请求本身判断，而不是按工具名猜：
 * 认不出工具名就没有「不再询问」，拿不到绝对目录就没有「按目录」，
 * 后端没声明能改入参就没有「改完再允许」。宁可少给一个按钮。
 */
export default function AiApprovalCard({ request, stopping, busy = false, onRespond }: AiApprovalCardProps) {
  const { t } = useI18n();
  const { tool, root, canEdit } = permissionOffer(request);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const disabled = !request.active || stopping || busy;
  const submit = (answer: AiPermissionAnswer) => {
    setError(null);
    onRespond(answer);
  };
  const submitEdited = () => {
    const result = editedInput(draft ?? "", request.input);
    if (!result.value) {
      setError(t(result.error ?? "ai.runtime.editNotJson"));
      return;
    }
    submit(allowEdited(result.value));
  };
  return <>
    <div className="ai-cli-actions ai-approval-actions">
      <button type="button" className="button" disabled={disabled} onClick={() => submit(denyPermission())}>{t("ai.runtime.deny")}</button>
      <button type="button" className="button is-primary" disabled={disabled} onClick={() => submit(allowOnce())}>{t("ai.runtime.allowOnce")}</button>
      {tool ? <button type="button" className="button" disabled={disabled} onClick={() => submit(allowAndRemember(tool))}>{t("ai.runtime.allowAndRemember")}</button> : null}
      {tool && root ? <button type="button" className="button" disabled={disabled} onClick={() => submit(allowDirectory(tool, root))}>{t("ai.runtime.allowDirectoryNamed", { root })}</button> : null}
      {canEdit ? <button type="button" className="button" disabled={disabled} aria-expanded={draft !== null} onClick={() => {
        setError(null);
        setDraft(draft === null ? JSON.stringify(request.input ?? {}, null, 2) : null);
      }}>{t("ai.runtime.editBeforeAllow")}</button> : null}
    </div>
    {draft !== null ? <div className="ai-approval-edit">
      <textarea className="text-input" rows={8} spellCheck={false} aria-label={t("ai.runtime.editInput")} value={draft} disabled={disabled} onChange={(event) => setDraft(event.target.value)} />
      <button type="button" className="button is-primary" disabled={disabled} onClick={submitEdited}>{t("ai.runtime.submitEdit")}</button>
    </div> : null}
    {tool ? <p className="ai-muted">{t("ai.runtime.grantScopeNote")}</p> : null}
    {error ? <p className="ai-error" role="alert">{error}</p> : null}
  </>;
}
