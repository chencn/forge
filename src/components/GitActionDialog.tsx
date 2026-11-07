import { useEffect, useRef, useState } from "react";
import { Dialog } from "../ui/Dialog";
import { Checkbox } from "../ui/Checkbox";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { List } from "../ui/List";
import { Spinner } from "../ui/Feedback";
import { commitStamp } from "../lib/format";
import { gitLog, gitPushTarget, isProtectedBranch, type GitCommit, type GitPushOptions, type GitPushTarget } from "../lib/git";
import { errorText } from "../lib/fs";
import type { GitState } from "../hooks/useGitState";
import type { RefTarget } from "../lib/refMenu";
import { useI18n } from "../i18n";
import { useSettings } from "../hooks/useSettings";
import "./GitActionDialog.css";

/** 一次 Git 动作对话框的请求（更新/推送/建分支/建标签/签出修订）。 */
export interface GitActionRequest {
  kind: "update" | "push" | "newBranch" | "newTag" | "checkoutRev";
  from?: string;
  target?: RefTarget;
  revision?: string;
  root?: string;
}
/** 表单提交的值（名称、起点、说明、签出开关与更新策略）。 */
export interface GitActionValues {
  name: string;
  from: string;
  message: string;
  checkout: boolean;
  method: "ff-only" | "merge" | "rebase";
  push?: GitPushOptions;
}

/** {@link GitActionDialog} 的入参。 */
interface Props {
  request: GitActionRequest;
  git: GitState;
  onCancel: () => void;
  onSubmit: (values: GitActionValues) => void;
}

/** 推送有独立的目标和确认状态，避免与创建/签出表单交叉覆盖。 */
export default function GitActionDialog(props: Props) {
  return props.request.kind === "push" ? <PushDialog {...props} /> : <ActionDialog {...props} />;
}

/** 更新/建分支/建标签/签出的表单对话框。 */
function ActionDialog({ request, git, onCancel, onSubmit }: Props) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const head = request.target?.name ?? git.status?.branch ?? "HEAD";
  const upstream = request.target ? git.branches.find((b) => !b.remote && b.name === head)?.upstream : git.status?.upstream;
  const [values, setValues] = useState<GitActionValues>({ name: "", from: request.from ?? "HEAD", message: "", checkout: true, method: settings.vcs.updateMethod === "rebase" ? "rebase" : "merge" });
  const submitted = useRef(false);
  const update = (patch: Partial<GitActionValues>) => setValues((current) => ({ ...current, ...patch }));
  const title = request.kind === "update" ? t("git.updateProject")
    : request.kind === "newBranch" ? t("git.newBranch") : request.kind === "newTag" ? t("git.newTag") : t("git.checkoutRev");
  const named = request.kind === "newBranch" || request.kind === "newTag" || request.kind === "checkoutRev";
  const disabled = git.operation?.phase === "running" || named && !values.name.trim();
  const submit = () => {
    if (submitted.current || disabled) return;
    submitted.current = true;
    onSubmit({ ...values, name: values.name.trim(), from: values.from.trim() || "HEAD", message: values.message.trim() });
  };
  const field = (label: string, value: string, onChange: (value: string) => void, autofocus = false, list?: string) => (
    <label className="git-action-field"><span>{label}</span><Input mono value={value} data-autofocus={autofocus || undefined}
      spellCheck={false} list={list} onChange={(event) => onChange(event.target.value)} /></label>
  );
  return <Dialog open title={title} onClose={onCancel} width={request.kind === "newTag" ? 460 : 420} className="git-action-dialog" buttons={[
    { role: "default", autoFocus: !named, label: request.kind === "update" ? t("dialog.ok") : request.kind === "checkoutRev" ? t("git.checkoutShort") : t("dialog.create"), disabled, onClick: submit },
    { role: "cancel", label: t("dialog.cancel") },
  ]}>
    <div className="git-action-form">
      {request.kind === "update" && <>
        <p className="git-action-route">{head} ← {upstream}{!!git.status?.behind && ` (${t("git.behindN", { count: git.status.behind })})`}</p>
        <div className="git-action-method" role="radiogroup" aria-label={t("git.updateMethod")}><span className="git-action-field-label">{t("git.updateMethod")}</span>
          {([ ["merge", "git.updateMerge"], ["rebase", "git.updateRebase"] ] as const).map(([method, label]) => (
            <label key={method}><input type="radio" name="update-method" checked={values.method === method} onChange={() => update({ method })} /><span>{t(label)}<code>{method === "merge" ? "git pull --no-rebase --ff" : "git pull --rebase"}</code></span></label>
          ))}
        </div>
        <p className="git-action-route">{t("git.updateAutostash")}</p>
      </>}
      {named && field(request.kind === "checkoutRev" ? t("git.checkoutRev") : t("dialog.name"), values.name, (name) => update({ name }), true, request.kind === "checkoutRev" ? "git-action-refs" : undefined)}
      {(request.kind === "newBranch" || request.kind === "newTag") && field(t("git.branchStartPoint"), values.from, (from) => update({ from }), false, "git-action-refs")}
      {request.kind === "newBranch" && <Checkbox checked={values.checkout} onChange={(checkout) => update({ checkout })} label={t("git.checkoutAfterCreate")} />}
      {request.kind === "newTag" && <label className="git-action-field"><span>{t("git.tagMessage")}</span>
        <textarea className="git-action-message" rows={4} value={values.message} onChange={(event) => update({ message: event.target.value })} />
      </label>}
      <datalist id="git-action-refs"><option value="HEAD" />{git.branches.map((b) => <option key={`branch:${b.name}`} value={b.name} />)}{git.tags.map((tag) => <option key={`tag:${tag.name}`} value={tag.name} />)}</datalist>
    </div>
  </Dialog>;
}

/** 推送表单对话框：远端分支选择与 force push 确认。 */
function PushDialog({ request, git, onCancel, onSubmit }: Props) {
  const { t, locale } = useI18n();
  const { settings } = useSettings();
  const branch = request.target?.name ?? (git.status?.detached ? "" : git.status?.branch ?? "");
  const [destination, setDestination] = useState<GitPushTarget | null>(null);
  const [remote, setRemote] = useState("");
  const [target, setTarget] = useState("");
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [force, setForce] = useState(false);
  const [setUpstream, setSetUpstream] = useState(false);
  const [pushTags, setPushTags] = useState(false);
  const [tagsMode, setTagsMode] = useState<"all" | "currentBranch">("all");
  const [confirm, setConfirm] = useState(false);
  const [remember, setRemember] = useState(false);
  const submitted = useRef(false);
  const edited = target.trim();
  const protectedTarget = isProtectedBranch(edited, settings.vcs.protectedBranches);
  const forcing = force && !protectedTarget;
  const retarget = !!destination && (remote !== destination.remote || edited !== destination.target);
  // 当前分支的右键入口与提交后入口仍是普通推送，保留标签和上游选项。
  const explicit = branch !== git.status?.branch || !!request.revision;
  const targetLabel = `${remote}/${edited}`;
  const disabled = !branch || !destination || !remote || !edited || !!error || commits === null || git.operation?.phase === "running";

  useEffect(() => {
    if (!git.root || !branch) return;
    let alive = true;
    setError(null);
    void gitPushTarget(git.root, branch).then((result) => {
      if (!alive) return;
      setDestination(result); setRemote(result.remote); setTarget(result.target); setSetUpstream(!result.tracked);
    }, (cause) => { if (alive) setError(errorText(cause)); });
    return () => { alive = false; };
  }, [git.root, branch, attempt]);

  useEffect(() => {
    if (!git.root || !destination || !edited || !remote) return;
    let alive = true;
    setCommits(null); setError(null);
    const tip = request.revision ?? `refs/heads/${branch}`;
    // 编辑目标后重新计算实际出站范围；新目标没有跟踪引用时显示源历史。
    const reference = `${remote}/${edited}`;
    const tracked = (!retarget && destination.tracked) || git.branches.some((b) => b.remote && b.name === reference);
    void gitLog(git.root, { reference: tracked ? `refs/remotes/${reference}..${tip}` : tip, limit: tracked ? 1000 : 50 }).then(
      (result) => { if (alive) setCommits(result); },
      (cause) => { if (alive) setError(errorText(cause)); },
    );
    return () => { alive = false; };
  }, [git.root, destination, remote, edited, branch, request.revision, retarget, git.branches]);

  // 免确认仅作用于当前仓库的确切目标，不能跨工程或跨远端扩散。
  const warningKey = `forge:git:forcePush:${JSON.stringify([git.root, remote, edited])}`;
  const run = () => {
    if (submitted.current || disabled) return;
    submitted.current = true;
    onSubmit({ name: "", from: "HEAD", message: "", checkout: false, method: "merge", push: {
      branch, remote, target: edited, ...(request.revision ? { revision: request.revision } : {}),
      forceWithLease: forcing, setUpstream: !request.revision && (setUpstream || !destination?.tracked),
      ...(!explicit && !retarget && pushTags ? { tags: tagsMode } : {}),
    } });
  };
  const submit = () => {
    if (disabled || submitted.current || confirm) return;
    let silent = false;
    try { silent = localStorage.getItem(warningKey) === "true"; } catch { /* 存储不可用时每次确认。 */ }
    if (forcing && !silent) { setRemember(false); setConfirm(true); } else run();
  };

  return <>
    <Dialog open title={destination ? t("git.pushCommitsTo", { remote: targetLabel }) : t("git.push")} onClose={onCancel}
      width={620} className="git-action-dialog git-push-dialog" footerStart={<>
        <span title={protectedTarget ? t("git.forceProtected", { branch: edited }) : undefined}>
          <Checkbox checked={forcing} disabled={protectedTarget} onChange={setForce} label={t("git.forceWithLease")} />
        </span>
        {!explicit && !retarget && <>
          <Checkbox checked={setUpstream || !destination?.tracked} disabled={!destination?.tracked} onChange={setSetUpstream} label={t("git.setUpstream")} />
          <Checkbox checked={pushTags} onChange={setPushTags} label={t("git.pushTags")} />
          <Select value={tagsMode} disabled={!pushTags} onChange={setTagsMode} aria-label={t("git.tagsToPush")}
            options={[{ value: "all", label: t("git.allTags") }, { value: "currentBranch", label: t("git.currentBranchTags") }]} />
        </>}
      </>} buttons={[
        { role: "default", autoFocus: true, label: t(forcing ? "git.forcePush" : "git.push"), disabled, onClick: submit },
        { role: "cancel", label: t("dialog.cancel") },
      ]}>
      <div className="git-action-form is-push">
        <div className="git-action-route">
          {!branch ? t("git.detachedPush") : <>
            <span>{branch}{request.revision ? ` (${request.revision.slice(0, 8)})` : ""} →</span>
            <Select value={remote || null} disabled={!destination} onChange={setRemote} aria-label={t("git.pushRemote")}
              variant="ghost" options={(git.probe?.remotes ?? []).map((value) => ({ value, label: `${value}/` }))} />
            <Input mono aria-label={t("git.targetBranch")} value={target} disabled={!destination}
              onChange={(event) => setTarget(event.target.value)} className="git-push-target" />
            {retarget && <span>{t("git.newPushTarget")}</span>}
          </>}
        </div>
        <div className="git-action-commits" aria-label={t("git.outgoingCommits")} aria-busy={!!branch && !commits && !error}>
          {error ? <div className="git-push-error"><p role="alert">{error}</p><Button onClick={() => setAttempt((value) => value + 1)}>{t("git.retryPushPreview")}</Button></div>
            : !branch ? null : commits === null ? <p><Spinner size={14} label={t("common.loading")} /></p> : <List
              items={commits} getKey={(commit) => commit.hash} rowHeight={22} className="git-action-commit-list" aria-label={t("git.outgoingCommits")}
              empty={<span>{t("git.noOutgoingCommits")}</span>}
              renderItem={(commit) => <span className="git-action-commit" title={`${commit.subject}\n${commit.author}`}>
                <code>{commit.short}</code><span className="git-action-commit-subject">{commit.subject}</span><span className="git-action-commit-meta">{commit.author}</span>
                <span className="git-action-commit-time">{commitStamp(commit.authoredMs, locale, t("time.today"), t("time.yesterday"))}</span>
              </span>} />}
        </div>
      </div>
    </Dialog>
    {confirm && <Dialog open title={t("git.forcePush")} onClose={() => setConfirm(false)} width={460} className="git-action-dialog"
      buttons={[
        { role: "default", autoFocus: true, label: t("git.forcePush"), onClick: () => {
          if (remember) { try { localStorage.setItem(warningKey, "true"); } catch { /* 本次仍已确认，下次继续询问。 */ } }
          setConfirm(false); run();
        } },
        { role: "cancel", label: t("dialog.cancel") },
      ]}>
      <div className="git-action-form"><p className="git-force-warning">{t("git.forcePushWarning", { target: targetLabel })}</p>
        <Checkbox checked={remember} onChange={setRemember} label={t("git.dontWarnTarget")} />
      </div>
    </Dialog>}
  </>;
}
