import { useState } from "react";
import { Check, ChevronDown, ChevronRight, CircleAlert, Loader2, MessageCircleQuestionMark } from "lucide-react";
import { useI18n } from "../i18n";
import { seedQuestionAnswers } from "../lib/aiApprovals";
import type { AiRequestAnswer } from "../lib/aiApprovals";
import type { AiRequest } from "../lib/aiRuntime";

type Question = AiRequest["questions"][number];

/** 一题的选择：命中的选项原文、「其他」有没有点亮、以及当时手打的那句。 */
type Seed = { chosen: string[]; other: boolean; text: string };

/**
 * 选项尾部写着「(recommended)」的，把推荐拆成徽标，正文只留选项本身。
 * 提交与回显仍按原样那份 label 走：改的是显示，不是答案的内容。
 */
const RECOMMENDED = /\s*[（(](recommended|推荐)[)）]\s*$/i;
function optionText(label: string) {
  const stripped = label.replace(RECOMMENDED, "").trim();
  return { text: stripped || label, recommended: stripped.length > 0 && stripped !== label };
}

/** 一题算不算答完：选中了真选项，或「其他」点亮且写了字。 */
function isAnswered(seed: Seed | undefined) {
  if (!seed) return false;
  return seed.chosen.length > 0 || (seed.other && seed.text.trim().length > 0);
}

/** 这题最终交给后端的那几项：选中的原文在前，「其他」手打的在后。 */
function labelsOf(seed: Seed | undefined) {
  if (!seed) return [];
  return [...seed.chosen, ...(seed.other && seed.text.trim() ? [seed.text.trim()] : [])];
}

/** 把后端带回来的答案摊回界面用的那份选择；只读留档全靠它，免得把已结束的卡摆成空白。 */
function seedState(questions: Question[], answer?: AiRequestAnswer): Record<string, Seed> {
  const seeded = seedQuestionAnswers(questions, answer);
  return Object.fromEntries(questions.map((question) => {
    const text = seeded.other[question.id] ?? "";
    return [question.id, { chosen: seeded.answers[question.id] ?? [], other: text.length > 0, text }];
  }));
}

/** 整行都是点击区：只有那颗小圆圈能点，等于让人对着 16px 的目标瞄。 */
function OptionRow({ type, name, checked, text, detail, recommended, tag, onPick, onClear }: {
  type: "radio" | "checkbox";
  name: string;
  checked: boolean;
  text: string;
  detail?: string;
  recommended: boolean;
  tag: string;
  onPick: () => void;
  /** 单选再点一次取消；复选框自己会勾回来，没有这个动作。 */
  onClear?: () => void;
}) {
  return <label className={`ai-question-option${checked ? " is-chosen" : ""}`}>
    {/* radio 在「已经选中还被点」时不触发 change，只有 click 到得了：那一刻 props 里的 checked
        还是点之前的那份，所以拿它判「本来就已选中」不会和 change 撞车、不会一次点击走两遍。 */}
    <input type={type} name={name} checked={checked} onChange={onPick} onClick={() => { if (type === "radio" && checked) onClear?.(); }} />
    <span className="ai-question-option-body">
      <span className="ai-question-option-label">{text}{recommended ? <em className="ai-question-tag">{tag}</em> : null}</span>
      {detail ? <small>{detail}</small> : null}
    </span>
  </label>;
}

/**
 * 提问卡：一次一题、页签切换、进度条摊在顶上，答完才让提交。版式对齐参考实现 codeg 的
 * ask-question-card —— 选项做成整行的卡片、点「其他」就地长出一个输入框、单选点完自动跳下一题。
 *
 * 这里没有「跳过」：后端要求每题都给一个非空答案（Claude 侧 answers 的数量必须和问题数相等），
 * 给一颗兑不了现的按钮比少画一个更糟。
 */
export function AiQuestionCard({ request, readOnly = false, disabled = false, busy = false, answer, onRespond }: {
  request: AiRequest;
  /** 只读的留档形态：控件全暗、去掉页脚，选择从答案回填。 */
  readOnly?: boolean;
  /** 请求已结束、正在停止、答复在途——任何一种都不该还能改选择。 */
  disabled?: boolean;
  busy?: boolean;
  /** 只读形态用它在重开会话时还原当时选的那几项。 */
  answer?: AiRequestAnswer;
  onRespond?: (answers: Record<string, string[]>) => void;
}) {
  const { t } = useI18n();
  const questions = request.questions;
  const [local, setLocal] = useState<Record<string, Seed>>({});
  const [activeId, setActiveId] = useState(questions[0]?.id ?? "");
  /** 整卡可收成一行（对照参考实现）：题先挂着、晚点再答的场合不该一直占半屏。 */
  const [collapsed, setCollapsed] = useState(false);
  // 只读那份没有任何可改的状态，直接照着答案算，不必再养一份会和它打架的本地状态。
  const state = readOnly ? seedState(questions, answer) : local;
  const locked = readOnly || disabled || busy;
  const multi = questions.length > 1;
  const answeredCount = questions.filter((question) => isAnswered(state[question.id])).length;
  const found = questions.findIndex((question) => question.id === activeId);
  const index = found >= 0 ? found : 0;
  const question = questions[Math.min(index, questions.length - 1)];
  const nextQuestion = index < questions.length - 1 ? questions[index + 1] : null;
  const put = (id: string, seed: Seed) => setLocal((prev) => ({ ...prev, [id]: seed }));
  const pick = (item: Question, label: string) => {
    const seed = state[item.id] ?? { chosen: [], other: false, text: "" };
    // 多选是累加，单选是替换并顺手熄掉「其他」——两者互斥，不能让一张卡亮两处。
    put(item.id, item.multiSelect
      ? { ...seed, chosen: seed.chosen.includes(label) ? seed.chosen.filter((l) => l !== label) : [...seed.chosen, label] }
      : { chosen: [label], other: false, text: "" });
    // 单选点完就往下走：多题时读起来像被带着走完一遍，省掉每次手点「下一题」。
    // 多选和点「其他」都不跳——前者还要再勾，后者还要打字。
    if (!item.multiSelect) {
      const at = questions.findIndex((x) => x.id === item.id);
      const nxt = questions[at + 1];
      if (nxt) setActiveId(nxt.id);
    }
  };
  const toggleOther = (item: Question) => {
    const seed = state[item.id] ?? { chosen: [], other: false, text: "" };
    const on = !seed.other;
    put(item.id, { ...seed, other: on, chosen: item.multiSelect || !on ? seed.chosen : [], text: on ? seed.text : "" });
  };
  const writeOther = (item: Question, text: string) => {
    const seed = state[item.id] ?? { chosen: [], other: false, text: "" };
    put(item.id, { ...seed, other: true, text });
  };
  const clear = (item: Question) => {
    const seed = state[item.id] ?? { chosen: [], other: false, text: "" };
    put(item.id, { ...seed, chosen: [], other: false, text: "" });
  };
  const submit = () => onRespond?.(Object.fromEntries(questions.map((item) => [item.id, labelsOf(state[item.id])])));
  // 正文定高：页签从「三个选项」切到「六个选项」时卡片不该跟着抽风式变高。
  const maxRows = questions.reduce((max, item) => Math.max(max, (item.options ?? []).length + 1), 1);
  const input = (item: Question) => <input type="text" className="text-input ai-question-input" aria-label={item.options?.length ? t("ai.runtime.otherAnswer") : item.question}
    placeholder={t("ai.runtime.otherAnswer")} autoFocus={!readOnly && !disabled} value={state[item.id]?.text ?? ""} maxLength={4000}
    onChange={(event) => writeOther(item, event.target.value)} />;
  if (!question) return null;
  const body = (item: Question) => <>
    <div className="ai-question-heading">
      <span className="ai-question-badge">{t(item.multiSelect ? "ai.runtime.multiChoice" : "ai.runtime.singleChoice")}</span>
      <p>{item.question}</p>
    </div>
    {(item.options ?? []).length === 0
      ? input(item)
      : <div className="ai-question-options">
        {(item.options ?? []).map((option) => {
          const label = optionText(option.label);
          return <OptionRow key={option.label} type={item.multiSelect ? "checkbox" : "radio"} name={`${request.requestId}:${item.id}`}
            checked={(state[item.id]?.chosen ?? []).includes(option.label)} text={label.text} detail={option.description}
            recommended={label.recommended} tag={t("ai.runtime.recommended")} onPick={() => pick(item, option.label)} onClear={() => clear(item)} />;
        })}
        <OptionRow type={item.multiSelect ? "checkbox" : "radio"} name={`${request.requestId}:${item.id}`}
          checked={!!state[item.id]?.other} text={t("ai.runtime.otherAnswer")} recommended={false} tag={t("ai.runtime.recommended")}
          onPick={() => toggleOther(item)} onClear={() => clear(item)} />
        {/* 输入框跟着「其他」的点亮状态长在原地：写了字就必定点亮，所以不会出现「有字没框」。 */}
        {state[item.id]?.other ? input(item) : null}
      </div>}
  </>;
  return <div className={`ai-question${readOnly ? " is-read-only" : ""}${busy ? " is-busy" : ""}${collapsed ? " is-collapsed" : ""}`} role="group" aria-label={t("ai.runtime.question")}>
    {multi && !readOnly && !collapsed ? <div className="ai-question-progress" aria-hidden="true"><span style={{ width: `${Math.round((answeredCount / questions.length) * 100)}%` }} /></div> : null}
    <header className="ai-question-head">
      <span className="ai-question-icon" aria-hidden="true"><MessageCircleQuestionMark size={15} /></span>
      <div className="ai-question-headline">
        <p>{t("ai.runtime.question")}</p>
        <small>{request.title || t("ai.runtime.questionHint")}</small>
      </div>
      {multi ? <span className="ai-question-count">{answeredCount}/{questions.length}</span> : null}
      {readOnly ? null : <button type="button" className="ai-question-collapse" aria-label={collapsed ? t("ai.sidebar.expandAll") : t("ai.sidebar.collapseAll")}
        title={collapsed ? t("ai.sidebar.expandAll") : t("ai.sidebar.collapseAll")} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
        <ChevronDown size={14} className={collapsed ? "" : " is-open"} aria-hidden="true" />
      </button>}
    </header>
    {collapsed ? null : <>
    {/* 页签在 fieldset 之外才不会跟着控件一起被禁：答复在途或已成留档时仍要能翻看别的题。 */}
    {multi ? <div className="ai-question-tabs">
      {questions.map((item, step) => <button key={item.id} type="button" className={item.id === question.id ? "is-current" : ""}
        data-answered={isAnswered(state[item.id]) ? "true" : "false"} onClick={() => setActiveId(item.id)}>
        {isAnswered(state[item.id]) ? <Check size={13} aria-hidden="true" /> : <span className="ai-question-step">{step + 1}</span>}
        <span>{item.header?.trim() || item.question}</span>
      </button>)}
    </div> : null}
    <fieldset disabled={locked}>
      {multi ? <div className="ai-question-panel" style={{ height: `min(${(maxRows * 3.25 + 0.75).toFixed(2)}rem, 50vh)` }}>{body(question)}</div> : body(question)}
    </fieldset>
    {readOnly ? null : <footer className="ai-question-foot">
      {nextQuestion ? <button type="button" className="button" onClick={() => setActiveId(nextQuestion.id)}>{t("ai.runtime.nextQuestion")}<ChevronRight size={13} aria-hidden="true" /></button> : null}
      <button type="button" className="button is-primary" disabled={locked || answeredCount < questions.length} onClick={submit}>
        {busy ? <Loader2 size={13} className="is-spinning" aria-hidden="true" /> : null}{t("ai.runtime.answer")}
        {multi ? <span className="ai-question-tally">({answeredCount})</span> : null}
      </button>
    </footer>}
    </>}
  </div>;
}

/** 答完之后的样子：先收一行「提问回答：…」，点开才把整张卡按只读摆出来——版式和刚才答的那张一模一样。 */
export function AiQuestionResult({ request, answer }: { request: AiRequest; answer?: AiRequestAnswer }) {
  const { t } = useI18n();
  // 没有答案就是没等到答复：**问了什么照样显示**——一行失效说明 + 问题摘要，点开是
  // 无选择的只读卡。只画一句「已失效」等于把「问了什么」也藏掉，用户连自己错过了什么都不知道。
  if (!answer) {
    const first = request.questions[0]?.question ?? "";
    return <div className="ai-question-record">
      <details>
        <summary>
          <CircleAlert size={13} className="ai-question-record-check" aria-hidden="true" />
          <span className="ai-question-record-prefix">{t("ai.runtime.requestExpired")}</span>
          <span className="ai-question-record-summary">{first}</span>
          <ChevronRight className="ai-detail-chevron" size={13} aria-hidden="true" />
        </summary>
        {request.questions.length ? <AiQuestionCard request={request} readOnly /> : null}
      </details>
    </div>;
  }
  const seeded = seedState(request.questions, answer);
  const summary = request.questions
    .map((question) => labelsOf(seeded[question.id]).map((label) => optionText(label).text).join("、"))
    .filter((line) => line.length)
    .join(", ");
  return <div className="ai-question-record">
    <details>
      <summary>
        <Check size={13} className="ai-question-record-check" aria-hidden="true" />
        <span className="ai-question-record-prefix">{t("ai.runtime.questionAnswered")}</span>
        <span className="ai-question-record-summary">{summary || t("ai.runtime.noChoice")}</span>
        <ChevronRight className="ai-detail-chevron" size={13} aria-hidden="true" />
      </summary>
      <AiQuestionCard request={request} readOnly answer={answer} />
    </details>
  </div>;
}
