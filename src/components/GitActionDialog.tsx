import { useEffect, useRef, useState } from "react";
import { Dialog } from "../ui/Dialog";
import { Checkbox } from "../ui/Checkbox";
import { Input } from "../ui/Input";
import { List } from "../ui/List";
import { Spinner } from "../ui/Feedback";
import { commitStamp } from "../lib/format";
import { gitLog, type GitCommit } from "../lib/git";
import { errorText } from "../lib/fs";
import type { GitState } from "../hooks/useGitState";
import type { RefTarget } from "../lib/refMenu";
import { useI18n } from "../i18n";
import "./GitActionDialog.css";

export interface GitActionRequest {
  kind: "update" | "push" | "newBranch" | "newTag" | "checkoutRev";
  from?: string;
  target?: RefTarget;
}
export interface GitActionValues {
  name: string;
  from: string;
  message: string;
  checkout: boolean;
  method: "ff-only" | "merge" | "rebase";
  setUpstream: boolean;
}

/** 对齐 OpenIDEA：先审阅选项，确认后关闭窗口，实际任务交给底栏持续报告。 */
export default function GitActionDialog({ request, git, onCancel, onSubmit }: {
  request: GitActionRequest;
  git: GitState;
  onCancel: () => void;
  onSubmit: (values: GitActionValues) => void;
}) {
  const { t, locale } = useI18n();
  const head = request.target?.name ?? git.status?.branch ?? "HEAD";
  const upstream = request.target ? git.branches.find((b) => !b.remote && b.name === head)?.upstream : git.status?.upstream;
  const [values, setValues] = useState<GitActionValues>({ name: "", from: request.from ?? "HEAD", message: "", checkout: true, method: "merge", setUpstream: !upstream });
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitted = useRef(false);
  const update = (patch: Partial<GitActionValues>) => setValues((current) => ({ ...current, ...patch }));
  useEffect(() => {
    if (request.kind !== "push" || !git.root) return;
    let alive = true;
    // 无上游时展示最近提交；有上游时只查询确实尚未推送的范围。
    void gitLog(git.root, { reference: upstream ? `${upstream}..${head}` : head, limit: upstream ? 1000 : 50 }).then(
      (result) => { if (alive) setCommits(result); },
      (cause) => { if (alive) setError(errorText(cause)); },
    );
    return () => { alive = false; };
  }, [request.kind, git.root, upstream, head]);
  const title = request.kind === "update" ? t("git.updateProject") : request.kind === "push" ? t("git.push")
    : request.kind === "newBranch" ? t("git.newBranch") : request.kind === "newTag" ? t("git.newTag") : t("git.checkoutRev");
  const named = request.kind === "newBranch" || request.kind === "newTag" || request.kind === "checkoutRev";
  const disabled = git.operation?.phase === "running" || named && !values.name.trim() || request.kind === "push" && !!error;
  const submit = () => {
    if (submitted.current || disabled) return;
    submitted.current = true;
    onSubmit({ ...values, name: values.name.trim(), from: values.from.trim() || "HEAD", message: values.message.trim() });
  };
  const field = (label: string, value: string, onChange: (value: string) => void, autofocus = false, list?: string) => (
    <label className="git-action-field"><span>{label}</span><Input mono value={value} data-autofocus={autofocus || undefined}
      spellCheck={false} list={list} onChange={(event) => onChange(event.target.value)} /></label>
  );
  const remote = upstream || `${git.probe?.remotes[0] ?? "origin"}/${head}`;
  return <Dialog open title={title} onClose={onCancel} width={request.kind === "push" ? 620 : request.kind === "newTag" ? 460 : 420} className="git-action-dialog"
    footerStart={request.kind === "push" && !request.target && !upstream ? <Checkbox checked disabled onChange={() => {}} label={t("git.setUpstream")} /> : undefined} buttons={[
    { role: "default", autoFocus: !named, label: request.kind === "push" ? t("git.push") : request.kind === "update" ? t("dialog.ok") : request.kind === "checkoutRev" ? t("git.checkoutShort") : t("dialog.create"), disabled, onClick: submit },
    { role: "cancel", label: t("dialog.cancel") },
  ]}>
    <div className={`git-action-form${request.kind === "push" ? " is-push" : ""}`}>
      {request.kind === "update" && <>
        <p className="git-action-route">{head} ← {upstream}</p>
        <div className="git-action-method" role="group" aria-label={t("git.updateMethod")}><span className="git-action-field-label">{t("git.updateMethod")}</span>
          {([ ["merge", "git.updateMerge"], ["rebase", "git.updateRebase"], ["ff-only", "git.updateFastForward"] ] as const).map(([method, label]) => (
            <label key={method}><input type="radio" name="update-method" checked={values.method === method} onChange={() => update({ method })} /><span>{t(label)}</span></label>
          ))}
        </div>
      </>}
      {request.kind === "push" && <>
        <p className="git-action-route">{head} → {remote}</p>
        <div className="git-action-commits" aria-label={t("git.outgoingCommits")} aria-busy={!commits && !error}>
          {error ? <p role="alert">{error}</p> : commits === null ? <p><Spinner size={14} label={t("common.loading")} /></p> : <List
            items={commits} getKey={(commit) => commit.hash} rowHeight={22} className="git-action-commit-list" aria-label={t("git.outgoingCommits")}
            empty={<span>{t("git.noOutgoingCommits")}</span>}
            renderItem={(commit) => <span className="git-action-commit" title={`${commit.subject}\n${commit.author}`}>
              <code>{commit.short}</code><span className="git-action-commit-subject">{commit.subject}</span><span className="git-action-commit-meta">{commit.author}</span>
              <span className="git-action-commit-time">{commitStamp(commit.authoredMs, locale, t("time.today"), t("time.yesterday"))}</span>
            </span>} />}
        </div>
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
