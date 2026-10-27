import DOMPurify from "dompurify";

/**
 * 聊天正文的清洗策略：只留排版标签。
 *
 * 聊天 markdown 出自模型输出，图片、表单、内联样式、`<svg>` 一律禁掉。全量路径与
 * 按块增量路径共用这一份，安全策略只在这里改。
 * `data-file-*` 不在禁列：核心层给本地文件链接打的标记要留下。
 */
const CHAT_SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["img", "picture", "source", "video", "audio", "iframe", "object", "embed", "style", "form", "input", "button", "svg", "math", "link", "meta", "base"],
  FORBID_ATTR: ["style", "src", "srcset", "autofocus", "background", "poster", "ping"],
};

export function sanitizeChatHtml(html: string): string {
  return DOMPurify.sanitize(html, CHAT_SANITIZE_CONFIG);
}
