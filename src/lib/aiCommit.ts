import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { GitChange, GitCommitSelection } from "./git";
import { gitDiffText } from "./git";
import { readFile } from "./fs";
import { describeError, errorCodeOf } from "./errors";

/** 提交说明的写作风格档位（设置下拉的取值）。 */
export const COMMIT_FORMATS = [
  "conventional",
  "concise",
  "imperative",
  "descriptive",
  "releaseNote",
  "custom",
] as const;
/** {@link COMMIT_FORMATS} 的成员类型。 */
export type CommitFormat = (typeof COMMIT_FORMATS)[number];

/** 供应商 API 协议档位。 */
export const COMMIT_PROTOCOLS = ["chatCompletions", "anthropicMessages", "responses"] as const;
/** {@link COMMIT_PROTOCOLS} 的成员类型。 */
export type CommitProtocol = (typeof COMMIT_PROTOCOLS)[number];

/** 推理力度档位（透传 reasoning_effort）。 */
export const COMMIT_EFFORTS = ["default", "none", "minimal", "low", "medium", "high"] as const;
/** {@link COMMIT_EFFORTS} 的成员类型。 */
export type CommitEffort = (typeof COMMIT_EFFORTS)[number];

/** chat 协议下发 token 上限用的字段名。 */
export const CHAT_TOKEN_LIMIT_FIELDS = ["max_completion_tokens", "max_tokens"] as const;
/** {@link CHAT_TOKEN_LIMIT_FIELDS} 的成员类型。 */
export type ChatTokenLimitField = (typeof CHAT_TOKEN_LIMIT_FIELDS)[number];

/** 一个 AI 提交说明的供应商：OpenAI 兼容端点的地址、模型与密钥。 */
export interface AiCommitProvider {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  apiKey: string;
  apiProtocol: CommitProtocol;
  chatTokenLimitField: ChatTokenLimitField;
  allowsInsecureHttp: boolean;
}

/** AI 提交说明的完整配置（持久化在 ai-commit.json）。 */
export interface AiCommitConfig {
  enabled: boolean;
  activeProviderId: string | null;
  providers: AiCommitProvider[];
  language: "simplifiedChinese" | "english";
  format: CommitFormat;
  customInstructions: string;
  includeBody: boolean;
  subjectMaximumLength: number;
  maximumDiffCharacters: number;
  maximumOutputTokens: number;
  reasoningEffort: CommitEffort;
}

/** 喂给 AI 的一个文件改动：路径、变更类型与差异文本。 */
export interface AiCommitFileInput {
  path: string;
  changeKind: string;
  diff: string;
}

/** 配置缺省值：启用、中文、conventional、无字符/Token 限制。 */
export const DEFAULT_AI_COMMIT_CONFIG: AiCommitConfig = {
  enabled: true,
  activeProviderId: null,
  providers: [],
  language: "simplifiedChinese",
  format: "conventional",
  customInstructions: "",
  includeBody: true,
  // 0 表示不施加字符限制；输出预算交给服务商默认值。
  subjectMaximumLength: 0,
  maximumDiffCharacters: 0,
  maximumOutputTokens: 0,
  reasoningEffort: "default",
};

/** 造一个 OpenAI 兼容的默认供应商条目（id 用时间戳+随机串保证唯一）。 */
export function newAiCommitProvider(name = "OpenAI Compatible"): AiCommitProvider {
  const id = `provider-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    name,
    endpoint: "https://api.openai.com/v1",
    model: "",
    apiKey: "",
    apiProtocol: "chatCompletions",
    chatTokenLimitField: "max_completion_tokens",
    allowsInsecureHttp: false,
  };
}

/** 配置保存后广播的自定义事件名（设置页与其他面板同步用）。 */
export const AI_COMMIT_CONFIG_CHANGED_EVENT = "forge:ai-commit-config-changed";

/** 最近一次读到的配置缓存（同步读取入口 {@link useAiCommitEnabled} 用）。 */
let cachedAiCommitConfig: AiCommitConfig | null = null;

/** 读取保存在 ai-commit.json 的配置 */
export async function loadAiCommitConfig(): Promise<AiCommitConfig> {
  const loaded = await invoke<AiCommitConfig>("ai_commit_config_load");
  // 过滤掉旧版遗留的未配置密钥的 default-deepseek
  const filteredProviders = (loaded.providers ?? []).filter(
    (p) => !(p.id === "default-deepseek" && !p.apiKey?.trim())
  );
  let activeId = loaded.activeProviderId;
  if (activeId && !filteredProviders.some((p) => p.id === activeId)) {
    activeId = filteredProviders[0]?.id ?? null;
  } else if (!activeId && filteredProviders.length > 0) {
    activeId = filteredProviders[0].id;
  }
  const config: AiCommitConfig = {
    ...DEFAULT_AI_COMMIT_CONFIG,
    ...loaded,
    providers: filteredProviders,
    activeProviderId: activeId,
  };
  cachedAiCommitConfig = config;
  return config;
}

/** 保存配置到单独的 ai-commit.json 并触发变更事件 */
export async function saveAiCommitConfig(config: AiCommitConfig): Promise<void> {
  cachedAiCommitConfig = config;
  await invoke<void>("ai_commit_config_save", { config });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AI_COMMIT_CONFIG_CHANGED_EVENT, { detail: config }));
  }
}

/** 监听 AI 提交说明是否启用的 hook */
export function useAiCommitEnabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(() => cachedAiCommitConfig?.enabled ?? true);

  useEffect(() => {
    let alive = true;
    loadAiCommitConfig()
      .then((cfg) => {
        if (alive) setEnabled(cfg.enabled);
      })
      .catch(() => {});

    const handler = (e: Event) => {
      const customEvent = e as CustomEvent<AiCommitConfig>;
      if (customEvent.detail && typeof customEvent.detail.enabled === "boolean") {
        setEnabled(customEvent.detail.enabled);
      } else {
        loadAiCommitConfig()
          .then((cfg) => {
            if (alive) setEnabled(cfg.enabled);
          })
          .catch(() => {});
      }
    };

    window.addEventListener(AI_COMMIT_CONFIG_CHANGED_EVENT, handler);
    return () => {
      alive = false;
      window.removeEventListener(AI_COMMIT_CONFIG_CHANGED_EVENT, handler);
    };
  }, []);

  return enabled;
}

/** 取消某次生成 */
export function cancelAiCommit(operationId: string): Promise<void> {
  return invoke<void>("ai_commit_cancel", { operationId });
}

/** 获取指定服务商的可用模型列表（请求 /v1/models 等端点） */
export function listAiCommitModels(params: {
  endpoint: string;
  apiKey?: string;
  allowsInsecureHttp?: boolean;
}): Promise<string[]> {
  return invoke<string[]>("ai_commit_list_models", {
    endpoint: params.endpoint,
    apiKey: params.apiKey ?? "",
    allowsInsecureHttp: !!params.allowsInsecureHttp,
  });
}

/** 提交格式预览信息接口 */
export interface CommitFormatPreviewInfo {
  badge: string;
  description: string;
  sample: string;
}

/** 获取对应格式的实时预览示例 */
export function getCommitFormatPreview(
  format: CommitFormat,
  language: "simplifiedChinese" | "english",
  includeBody: boolean,
  customInstructions?: string
): CommitFormatPreviewInfo {
  const isZh = language === "simplifiedChinese";

  switch (format) {
    case "conventional": {
      const sample = isZh
        ? includeBody
          ? `feat(auth): 支持第三方账号授权登录\n\n- 新增 OAuth2 回调接口处理与令牌解析\n- 支持登录会话持久化与用户上下文刷新`
          : `feat(auth): 支持第三方账号授权登录`
        : includeBody
          ? `feat(auth): add third-party OAuth2 login support\n\n- Implement OAuth2 callback handler and token exchange\n- Persist user session state and refresh context`
          : `feat(auth): add third-party OAuth2 login support`;
      return {
        badge: "Conventional Commits",
        description: isZh
          ? "格式: <type>(<scope>): <subject>，符合业界主流提交规范"
          : "Format: <type>(<scope>): <subject>, standard conventional format",
        sample,
      };
    }
    case "concise": {
      const sample = isZh
        ? includeBody
          ? `修复快速切换文件时光标位置偶发丢失的问题\n\n在视图挂载前校验模型状态，防止未完成的渲染重置光标。`
          : `修复快速切换文件时光标位置偶发丢失的问题`
        : includeBody
          ? `Fix cursor position reset when switching files rapidly\n\nValidate model state before mount to avoid resetting selection.`
          : `Fix cursor position reset when switching files rapidly`;
      return {
        badge: isZh ? "简明一句话" : "Concise Sentence",
        description: isZh ? "单句概括核心改动，直奔重点" : "A concise sentence describing the most important change",
        sample,
      };
    }
    case "imperative": {
      const sample = isZh
        ? includeBody
          ? `优化文件监听事件的防抖与分发策略\n\n批量合并高频文件系统变动通知，降低大型工程的 CPU 占用。`
          : `优化文件监听事件的防抖与分发策略`
        : includeBody
          ? `Debounce file watcher events to reduce cpu overhead\n\nBatch high-frequency file notifications to avoid repeated tree reloads.`
          : `Debounce file watcher events to reduce cpu overhead`;
      return {
        badge: isZh ? "祈使语态" : "Imperative Mood",
        description: isZh ? "动词原形开头的祈使语态，无类型前缀" : "Imperative subject line without type prefixes",
        sample,
      };
    }
    case "descriptive": {
      const sample = isZh
        ? includeBody
          ? `重构网络请求重试与离线降级策略\n\n引入指数退避重试机制，并在网络不可用时自动启用本地缓存，提高离线使用体验。`
          : `重构网络请求重试与离线降级策略`
        : includeBody
          ? `Refactor network retry strategy with exponential backoff\n\nIntroduce exponential backoff and automatic local cache fallback to improve stability.`
          : `Refactor network retry strategy with exponential backoff`;
      return {
        badge: isZh ? "详尽说明" : "Descriptive",
        description: isZh ? "清晰的主题标题，附带补充解释正文" : "Clear subject header with an explanatory body",
        sample,
      };
    }
    case "releaseNote": {
      const sample = isZh
        ? includeBody
          ? `新增多语言界面切换与常用全局快捷键自定义功能\n\n支持即时切换界面语言，并在设置中根据个人习惯自定义热键。`
          : `新增多语言界面切换与常用全局快捷键自定义功能`
        : includeBody
          ? `Add real-time language switching and customizable global shortcuts\n\nAllows switching interface languages on the fly and custom hotkey bindings.`
          : `Add real-time language switching and customizable global shortcuts`;
      return {
        badge: isZh ? "发行说明" : "Release Note",
        description: isZh ? "面向终端用户的发布通告风格，无开发前缀" : "User-facing release note style without developer prefixes",
        sample,
      };
    }
    case "custom": {
      const customTrimmed = customInstructions?.trim();
      const sample = customTrimmed
        ? (isZh
            ? `[自定义指令]: 遵循您设定的提示词规则进行生成\n\n规则摘录: "${customTrimmed.slice(0, 80)}${customTrimmed.length > 80 ? "..." : ""}"`
            : `[Custom format]: Output follows your custom instructions\n\nRules: "${customTrimmed.slice(0, 80)}${customTrimmed.length > 80 ? "..." : ""}"`)
        : (isZh
            ? `feat: 遵循 Conventional Commits (未填写自定义指令)`
            : `feat: following Conventional Commits (custom instructions empty)`);
      return {
        badge: isZh ? "自定义指令" : "Custom Instructions",
        description: isZh ? "完全由用户自定义提示词指导生成" : "Guided completely by your custom instructions",
        sample,
      };
    }
  }
}

/** 发起 AI 提交说明生成 */
export async function generateAiCommitMessage(params: {
  operationId: string;
  files: AiCommitFileInput[];
  overrideProviderId?: string;
}): Promise<string> {
  return invoke<string>("ai_commit_generate", {
    operationId: params.operationId,
    files: params.files,
    overrideProviderId: params.overrideProviderId ?? null,
  });
}

/**
 * 敏感文件检测，前端先做一层快速校验与过滤。
 */
export function isSensitiveCommitFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const name = normalized.split("/").pop() ?? "";
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name === "credentials.json" ||
    name === ".credentials.json" ||
    name === "auth.json" ||
    name === "id_rsa" ||
    name === "id_ed25519" ||
    name.endsWith(".pem") ||
    name.endsWith(".key") ||
    name.endsWith(".p12") ||
    name.endsWith(".pfx")
  );
}

/**
 * 为一组 GitChange 文件收集 diff 内容以供大模型分析。
 * 按提交计划读取 HEAD 到索引或工作区的真实差异，保留分散的修改块。
 */
export async function collectFilesDiff(
  root: string,
  changes: GitChange[],
  selections: readonly GitCommitSelection[]
): Promise<AiCommitFileInput[]> {
  const results: AiCommitFileInput[] = [];

  for (const change of changes) {
    if (isSensitiveCommitFile(change.path) || (change.oldPath && isSensitiveCommitFile(change.oldPath))) {
      continue;
    }
    const absolute = `${root.replace(/[\\/]+$/, "")}/${change.path}`;
    const source = selections.find((selection) => selection.path === change.path)?.source;
    if (!source) continue;
    const worktree = source !== "index";
    let diff: string;
    if (source === "worktreeOnly") {
      // 使用与实际提交相同的补丁重放；不能把原暂存修改混进生成输入。
      diff = await gitDiffText(root, "HEAD", "", absolute, change.oldPath ?? undefined, false, true);
    } else if (worktree && (change.untracked || change.indexStatus === "A")) {
      // Git diff 不包含未跟踪文件；新增文件以空内容为基线，也适用于首个提交。
      if (change.workStatus === "D") {
        diff = "";
      } else {
        const contents = (await readFile(absolute)).contents;
        const lines = contents ? contents.split(/\r?\n/) : [];
        if (lines.at(-1) === "") lines.pop();
        diff = `--- /dev/null\n+++ ${JSON.stringify(`b/${change.path}`)}\n`;
        if (lines.length > 0) {
          diff += `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`;
        }
      }
    } else {
      diff = await gitDiffText(root, worktree ? "HEAD" : "", "", absolute, change.oldPath ?? undefined, !worktree);
    }
    // 读取失败必须中止生成，不能悄悄漏文件后返回一条貌似完整的说明。
    if (diff.trim()) {
      results.push({
        path: change.path,
        changeKind: worktree ? change.workStatus.trim() || change.indexStatus : change.indexStatus,
        diff,
      });
    }
  }

  return results;
}

/**
 * 将 AI 生成提交说明时的错误代码转化为国际化友好的错误提示。
 */
export function formatAiCommitError(
  error: unknown,
  t: (key: any, values?: Record<string, string | number>) => string
): string {
  const code = error instanceof Error ? error.message : String(error);
  if (errorCodeOf(code) === "PARTIAL_COMMIT_CONFLICT") return describeError(code, t);

  const httpMatch = /^AI_COMMIT_HTTP_(\d{3})$/.exec(code);
  if (httpMatch) {
    return t("aiCommit.httpError", { status: httpMatch[1] });
  }

  const key = `aiCommit.${code}`;
  const translated = t(key);
  return translated === key ? t("aiCommit.failed") : translated;
}
