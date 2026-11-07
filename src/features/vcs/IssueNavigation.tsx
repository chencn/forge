import React from "react";
import { openExternal } from "../../lib/fs";
import type { IssueNavigationPattern } from "../../lib/settings";

/**
 * 将 $0, $1 等变量安全替换为匹配结果
 */
function replacePlaceholders(template: string, match: RegExpExecArray): string {
  let result = template;
  for (let i = 0; i < match.length; i++) {
    result = result.split(`$${i}`).join(match[i] ?? "");
  }
  return result;
}

/** 工单文本的一个片段：普通文本或带 URL 的链接。 */
export interface IssueToken {
  type: "text" | "link";
  value: string;
  url?: string;
}

/**
 * 将文本按工单正则规则分词并生成超链接（纯函数）。
 */
export function parseIssueTokens(
  text: string,
  patterns: IssueNavigationPattern[] = []
): IssueToken[] {
  if (!text || patterns.length === 0) {
    return [{ type: "text", value: text }];
  }

  const validPatterns = patterns.filter((p) => {
    try {
      new RegExp(p.issueId);
      return Boolean(p.issueId && p.issueLink);
    } catch {
      return false;
    }
  });

  if (validPatterns.length === 0) {
    return [{ type: "text", value: text }];
  }

  let tokens: IssueToken[] = [{ type: "text", value: text }];

  for (const pat of validPatterns) {
    const nextTokens: IssueToken[] = [];
    let regex: RegExp;
    try {
      regex = new RegExp(pat.issueId, "g");
    } catch {
      continue;
    }

    for (const token of tokens) {
      if (token.type === "link") {
        nextTokens.push(token);
        continue;
      }

      const str = token.value;
      let lastIndex = 0;
      let match: RegExpExecArray | null;

      regex.lastIndex = 0;
      while ((match = regex.exec(str)) !== null) {
        const start = match.index;
        const end = regex.lastIndex;

        if (start > lastIndex) {
          nextTokens.push({ type: "text", value: str.slice(lastIndex, start) });
        }

        const url = replacePlaceholders(pat.issueLink, match);
        nextTokens.push({ type: "link", value: match[0], url });
        lastIndex = end;

        if (!regex.global) break;
      }

      if (lastIndex < str.length) {
        nextTokens.push({ type: "text", value: str.slice(lastIndex) });
      }
    }
    tokens = nextTokens;
  }

  return tokens;
}

/** 工单链接化文本组件的入参。 */
export interface IssueTextProps {
  text: string;
  patterns?: IssueNavigationPattern[];
  className?: string;
  style?: React.CSSProperties;
}

/**
 * 带有工单超链接的文本组件。
 */
export function IssueText({ text, patterns = [], className, style }: IssueTextProps) {
  const tokens = parseIssueTokens(text, patterns);

  if (tokens.length === 1 && tokens[0]?.type === "text") {
    return <span className={className} style={style}>{text}</span>;
  }

  const handleClick = (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      // 优先走后端 Tauri openExternal 命令，失败退回 window.open
      openExternal(url).catch(() => {
        window.open(url, "_blank", "noopener,noreferrer");
      });
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <span className={className} style={style}>
      {tokens.map((token, idx) => {
        if (token.type === "link" && token.url) {
          return (
            <a
              key={idx}
              href={token.url}
              onClick={(e) => handleClick(e, token.url!)}
              style={{
                color: "var(--accent, #3871e1)",
                textDecoration: "underline",
                cursor: "pointer",
              }}
              title={token.url}
            >
              {token.value}
            </a>
          );
        }
        return <React.Fragment key={idx}>{token.value}</React.Fragment>;
      })}
    </span>
  );
}
