import { describe, expect, it } from "vitest";
import { commandSuggestions, completeCommand, filterCommandSuggestions, localCommand, normalizeCommandCatalog, parseSlash, resolveNativeCommand } from "../../src/lib/aiCommands";

describe("slash command parsing and discovery", () => {
  it("preserves native arguments rather than shell-parsing quotes and newlines", () => {
    expect(parseSlash('  /plugin:check  "a b" --flag\n第二行')).toEqual({ name: "plugin:check", args: ' "a b" --flag\n第二行', text: '/plugin:check  "a b" --flag\n第二行' });
    expect(parseSlash("talk about /compact")).toBeNull();
    expect(parseSlash("//literal")).toBeNull();
    expect(parseSlash("/")?.name).toBe("");
  });
  it.each([
    ["/review", ""],
    ["/review  \"a b\"\n第二行  ", ' "a b"\n第二行  '],
    ["/review\t\t检查\r\n下一行", "\t检查\r\n下一行"],
    ["/review\u3000检查", "检查"],
    ["/review --base main --commit abc", "--base main --commit abc"],
    ["/review C:\\work\\file.ts; $(echo literal)", "C:\\work\\file.ts; $(echo literal)"],
  ])("preserves the exact argument payload for %j", (text, args) => {
    expect(parseSlash(text)).toEqual({ name: "review", args, text });
    expect(completeCommand(text, "review")).toBe(text === "/review" ? "/review " : text);
  });
  it("normalizes metadata without inventing parameters or retaining unrelated data", () => {
    const catalog = normalizeCommandCatalog({ commands: [{ name: "skill", argumentHint: "<file>", description: "test", aliases: ["s", "invalid name"], secret: "discard" }, { name: "/bad" }, null], terminal: ["exit", 1] });
    expect(catalog).toEqual({ commands: [{ name: "skill", argumentHint: "<file>", description: "test", aliases: ["s"], builtin: undefined }], terminal: ["exit"] });
    expect(normalizeCommandCatalog({ commands: null })).toBeUndefined();
  });
  it("gives builtins precedence over same-name skills and real names over aliases", () => {
    const catalog = normalizeCommandCatalog({ commands: [{ name: "compact", description: "skill" }, { name: "compact", builtin: true, description: "builtin", aliases: ["short"] }, { name: "short", description: "real" }] })!;
    expect(resolveNativeCommand(catalog, "compact")?.description).toBe("builtin");
    expect(resolveNativeCommand(catalog, "short")?.description).toBe("real");
    expect(commandSuggestions("claude", catalog).filter((c) => c.name === "compact")).toHaveLength(1);
  });
  it("hides terminal-only and unintegrated stateful builtins including aliases", () => {
    const catalog = normalizeCommandCatalog({ commands: [{ name: "exit", builtin: true, aliases: ["quit"] }, { name: "clear", builtin: true }, { name: "skill", aliases: ["s"] }, { name: "usage", builtin: true, aliases: ["cost"] }], terminal: ["exit", "skill"] })!;
    expect(resolveNativeCommand(catalog, "quit")).toBeUndefined();
    expect(resolveNativeCommand(catalog, "s")).toBeUndefined();
    expect(resolveNativeCommand(catalog, "cost")?.name).toBe("usage");
    for (const name of ["exit", "clear", "skill"]) expect(commandSuggestions("claude", catalog).map((c) => c.name)).not.toContain(name);
  });
  it("offers only actual local mappings for Codex and preserves parameters on completion", () => {
    const commands = commandSuggestions("codex");
    expect(filterCommandSuggestions(commands, "/mo").map((c) => c.name)).toEqual(["model"]);
    expect(filterCommandSuggestions(commands, "/model abc")).toEqual([]);
    expect(completeCommand('/mo  "a b"\nnext', "model")).toBe('/model  "a b"\nnext');
    expect(completeCommand("/mo", "model")).toBe("/model ");
    expect(localCommand("approvals")).toBe("permissions");
    expect(commandSuggestions("claude").some((c) => c.name === "fast")).toBe(false);
  });
});
