import type { AiEntry } from "./aiRuntime";
import { toolObject } from "./aiTools";

/** 一条联网搜索结果的来源。 */
export interface AiSource { url: string; title: string }
/** 一个测试用例的执行结果。 */
export interface AiTestCase { name: string; status: "passed" | "failed" | "pending" | "skipped" | "todo"; errors: string[] }
/** 一个测试套件及其用例。 */
export interface AiTestSuite { name: string; tests: AiTestCase[] }

/** Only structured web-search results are sources; ordinary response links establish no citation relationship. */
export function aiToolSources(entry: AiEntry): AiSource[] {
  if (entry.name !== "webSearch") return [];
  const result = toolObject(entry.result);
  if (!Array.isArray(result.results)) return [];
  const seen = new Set<string>();
  return result.results.flatMap((raw) => {
    const source = toolObject(raw);
    if (typeof source.url !== "string") return [];
    try {
      const url = new URL(source.url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || seen.has(url.href)) return [];
      seen.add(url.href);
      return [{ url: url.href, title: typeof source.title === "string" && source.title.trim() ? source.title : url.hostname }];
    } catch { return []; }
  });
}

/** Accept the documented Jest/Vitest JSON reporter shape, never infer test counts from shell prose or exit codes. */
export function aiToolTestSuites(entry: AiEntry): AiTestSuite[] {
  const result = toolObject(entry.result);
  const nested = toolObject(result.result);
  const output = toolObject(entry.output);
  // Codex 把 MCP 输出包在 result.result 里；Claude 可能直接放在 output。
  const candidates = [result, toolObject(result.structuredContent), nested, toolObject(nested.structuredContent), output, toolObject(output.structuredContent)];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate.testResults)) continue;
    const suites: AiTestSuite[] = [];
    for (const raw of candidate.testResults) {
      const suite = toolObject(raw);
      if (typeof suite.name !== "string" || !suite.name.trim() || !Array.isArray(suite.assertionResults)) return [];
      const tests: AiTestCase[] = [];
      for (const rawTest of suite.assertionResults) {
        const test = toolObject(rawTest);
        const name = typeof test.fullName === "string" ? test.fullName : test.title;
        if (typeof name !== "string" || !name.trim() || typeof test.status !== "string" || !["passed", "failed", "pending", "skipped", "todo"].includes(test.status)) return [];
        tests.push({ name, status: test.status as AiTestCase["status"], errors: Array.isArray(test.failureMessages) ? test.failureMessages.filter((value): value is string => typeof value === "string") : [] });
      }
      suites.push({ name: suite.name, tests });
    }
    return suites;
  }
  return [];
}

/** Error text is kept verbatim. No guessed file/line frames or invented links. */
export function aiToolError(entry: AiEntry): { message: string; stack?: string } | null {
  const result = toolObject(entry.result);
  const error = result.error;
  if (typeof error === "string" && error) return { message: error };
  const record = toolObject(error);
  if (typeof record.message === "string" && record.message) return { message: record.message, stack: typeof record.stack === "string" ? record.stack : undefined };
  if (entry.status === "failed" && typeof entry.output === "string" && entry.output) return { message: entry.output };
  return null;
}
