import type { Ref } from "react";
import { useI18n } from "../i18n";
import type { CommandSuggestion } from "../lib/aiCommands";

interface AiCommandMenuProps {
  id: string;
  suggestions: CommandSuggestion[];
  selected: number;
  onChoose: (name: string) => void;
  menuRef?: Ref<HTMLDivElement>;
  showDiscovery?: boolean;
}

/** 输入框共用的斜杠命令列表；筛选和键盘状态仍由各自输入页持有。 */
export default function AiCommandMenu({ id, suggestions, selected, onChoose, menuRef, showDiscovery = false }: AiCommandMenuProps) {
  const { t } = useI18n();
  return <div className="ai-command-menu" ref={menuRef}>
    <p className="ai-popover-note">{t("ai.commands.hint")}</p>
    <div id={id} role="listbox" aria-label={t("ai.commands.title")}>
      {suggestions.map((command, index) => <button type="button" role="option" id={`${id}-${index}`} key={command.name}
        aria-selected={index === selected} tabIndex={-1} onMouseDown={(event) => event.preventDefault()} onClick={() => onChoose(command.name)}>
        <span><strong>/{command.name}</strong> <code>{command.argumentHint}</code></span>
        <small>{command.hintKey ? t(command.hintKey as Parameters<typeof t>[0]) : command.description}</small>
      </button>)}
    </div>
    {showDiscovery ? <p className="ai-popover-note">{t("ai.commands.discovery")}</p> : null}
  </div>;
}
