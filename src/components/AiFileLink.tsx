import { createContext, useContext, type ReactNode } from "react";

/** AI 回复里点开文件：路径是消息里写的原样，由上层按工程根还原。 */
export type AiOpenFile = (path: string, line?: number, column?: number) => void;

const AiOpenFileContext = createContext<AiOpenFile | null>(null);

export function AiOpenFileProvider({ onOpen, children }: { onOpen?: AiOpenFile; children: ReactNode }) {
  return <AiOpenFileContext.Provider value={onOpen ?? null}>{children}</AiOpenFileContext.Provider>;
}

export function useAiOpenFile(): AiOpenFile | null {
  return useContext(AiOpenFileContext);
}

/**
 * 工具卡片里的文件路径。没有上层回调时退化成普通文字，审批卡等离屏位置
 * 也不会因为缺上下文而变成点不动的按钮。
 */
export function AiFilePath({ path, line, column, className, children }: {
  path: string;
  line?: number;
  column?: number;
  className?: string;
  children: ReactNode;
}) {
  const open = useAiOpenFile();
  if (!open || !path) return <span className={className}>{children}</span>;
  const position = line !== undefined ? `:${line}${column !== undefined ? `:${column}` : ""}` : "";
  return <button
    type="button"
    className={`ai-file-target${className ? ` ${className}` : ""}`}
    title={`${path}${position}`}
    onClick={(event) => {
      // 摘要行外面还有一层 <summary>：不拦默认行为会顺带折叠/展开工具卡片。
      event.preventDefault();
      event.stopPropagation();
      open(path, line, column);
    }}
  >{children}</button>;
}
