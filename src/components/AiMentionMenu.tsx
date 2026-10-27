interface AiMentionMenuProps {
  id: string;
  /** 相对路径建议（已按工作区归一）。 */
  items: string[];
  selected: number;
  onChoose: (path: string) => void;
}

/**
 * 输入框的 @ 文件建议列表。样式沿用斜杠命令菜单的外壳，但语义是路径：
 * 主文案是文件名，副文案是相对路径——同名文件靠它区分。
 */
export default function AiMentionMenu({ id, items, selected, onChoose }: AiMentionMenuProps) {
  return <div className="ai-command-menu ai-mention-menu">
    <div id={id} role="listbox">
      {items.map((path, index) => <button type="button" role="option" id={`${id}-${index}`} key={path}
        aria-selected={index === selected} tabIndex={-1} onMouseDown={(event) => event.preventDefault()} onClick={() => onChoose(path)}>
        <span><strong>@{path.split("/").pop()}</strong> <code>{path}</code></span>
      </button>)}
    </div>
  </div>;
}
