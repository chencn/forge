import type { AiEntry } from "./aiRuntime";

/**
 * 时间线折叠。
 *
 * 一轮长任务里工具调用和想法能连着上百条，每条都是一个独立的展开块：滚动条变得没法
 * 用，真正要看的那句回复被挤出屏幕。这里把「过程」折成一段，把「说话」留在原地。
 *
 * 只折 `tool` 与 `reasoning`：审批卡片要单独可点，文件改动是结论的一部分，
 * 用户消息和回复正文更不该被藏进任何折叠里。
 */

/** 连着这么多条才值得折一段；两三条就折，等于让人多点一次才看到本来就在眼前的东西。 */
export const MIN_PROCESS = 3;
/** 折叠段先露出最近这么多条，剩下的按「更早」再展开。 */
export const PROCESS_PAGE = 8;
/** 一屏最多铺这么多时间线项。配合折叠段，需要渲染的块数才有上界。 */
export const TIMELINE_WINDOW = 120;

const PROCESS_KINDS: ReadonlyArray<AiEntry["kind"]> = ["tool", "reasoning"];

export type AiTimelineItem =
  | { kind: "entry"; key: string; entry: AiEntry }
  | { kind: "process"; key: string; runId: string; entries: AiEntry[]; active: boolean };

/**
 * 末尾那条还没有正文的思考，是不是「模型正在想」的凭证。
 *
 * 两家 CLI 都会送来没有可显示正文的思考块：Codex 的加密推理只给占位摘要，Claude 的
 * redacted thinking 只剩签名（实测两份 Claude 会话的 44 条思考事件里 32 条是空的）。
 * 逐条摆成一行「思考」、点开什么都没有，看着就像界面坏了。留着的唯一理由是在流式途中——
 * 空正文恰好是「还在想」的信号，而且不返回摘要的模型自始至终只有这一条空的。
 * 所以只认本轮末尾那一条（对照参考实现 codeg：历史路径丢掉，流式路径留着）。
 */
export function liveThinking(entries: readonly AiEntry[], running: boolean): AiEntry | null {
  if (!running) return null;
  const last = entries[entries.length - 1];
  return last && last.kind === "reasoning" ? last : null;
}

export function groupAiTimeline(entries: readonly AiEntry[], running = false): AiTimelineItem[] {
  const live = liveThinking(entries, running);
  const rows = entries.filter((entry) => entry.kind !== "reasoning" || entry.text.trim().length > 0 || entry === live);
  const items: AiTimelineItem[] = [];
  let run: AiEntry[] = [];
  // 攒满一段再落地：中途来一条回复正文，过程段就到此为止。
  const flush = () => {
    if (!run.length) return;
    if (run.length >= MIN_PROCESS) {
      items.push({ kind: "process", key: `process:${run[0].id}`, runId: run[0].runId, entries: run, active: run.some((entry) => entry.status === "running") });
    } else {
      for (const entry of run) items.push({ kind: "entry", key: entry.id, entry });
    }
    run = [];
  };
  for (const entry of rows) {
    const process = PROCESS_KINDS.includes(entry.kind);
    // 跨轮不并段：两段的归属轮次要唯一，否则「停止这一轮」之类的操作没有对象。
    if (process && (!run.length || run[0].runId === entry.runId)) run = [...run, entry];
    else { flush(); if (process) run = [entry]; else items.push({ kind: "entry", key: entry.id, entry }); }
  }
  flush();
  return items;
}

/**
 * 取一段时间线里该露出来的尾巴，整段一起算，不把折叠段劈成两半。
 *
 * `hidden` 是被挡住的项数，界面上说得出「还有多少更早的没显示」，而不是让人以为
 * 对话只有这么长。
 */
export function windowAiTimeline(items: readonly AiTimelineItem[], limit = TIMELINE_WINDOW): { items: AiTimelineItem[]; hidden: number } {
  const start = Math.max(0, items.length - Math.max(1, limit));
  return { items: items.slice(start), hidden: start };
}

/**
 * 折叠段露出的那几条：永远露最近的一组，因为「现在在干什么」比开头更重要。
 *
 * 正在跑的那一段应该整段展开而不是露 8 条——跑着的工具万一不在末尾，把它藏起来就等于
 * 把「它还在动」这个事实藏了。这条由界面决定，这里只保证 `hidden` 数得准。
 */
export function pageProcess(entries: readonly AiEntry[], shown = PROCESS_PAGE): { visible: AiEntry[]; hidden: number } {
  const count = Math.max(1, Math.min(shown, entries.length));
  return { visible: entries.slice(entries.length - count), hidden: entries.length - count };
}
