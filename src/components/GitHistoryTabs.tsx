import { useState, type ComponentProps } from "react";
import { useI18n } from "../i18n";
import { basenameOf } from "../lib/format";
import { Tabs } from "../ui/Tabs";
import GitLogPane from "./GitLogPane";
import styles from "./GitHistoryTabs.module.css";

type LogProps = ComponentProps<typeof GitLogPane>;
interface Props extends LogProps {
  historyPaths: string[];
  activeHistory: string;
  onSelectHistory: (path: string) => void;
  onCloseHistory: (path: string) => void;
}

function FileHistory({ path, ...props }: Omit<LogProps, "reference" | "setReference" | "compareRef" | "setCompareRef" | "pathFilter" | "setPathFilter"> & { path: string }) {
  const [reference, setReference] = useState("");
  const [compareRef, setCompareRef] = useState<string | null>(null);
  const [pathFilter, setPathFilter] = useState(path);
  return <GitLogPane {...props} reference={reference} setReference={setReference} compareRef={compareRef} setCompareRef={setCompareRef} pathFilter={pathFilter} setPathFilter={setPathFilter} />;
}

/** 每个历史页签各持有日志状态；隐藏时保留实例，主 Log 的筛选与选区不受影响。 */
export default function GitHistoryTabs({ historyPaths, activeHistory, onSelectHistory, onCloseHistory, ...props }: Props) {
  const { t } = useI18n();
  return <div className={styles.root}>
    <Tabs variant="compact" activeId={activeHistory ? `history:${activeHistory}` : "log"} onSelect={(id) => onSelectHistory(id === "log" ? "" : id.slice(8))}
      onClose={(id) => { if (id.startsWith("history:")) onCloseHistory(id.slice(8)); }} aria-label={t("panel.log")} items={[
        { id: "log", label: t("panel.log"), closable: false },
        ...historyPaths.map((path) => ({ id: `history:${path}`, label: t("history.gitTitle", { name: basenameOf(path) }), tooltip: path, closable: true })),
      ]} />
    <div className={styles.panel} hidden={!!activeHistory}><GitLogPane {...props} /></div>
    {historyPaths.map((path) => <div key={path} className={styles.panel} hidden={activeHistory !== path}>
      <FileHistory git={props.git} reportError={props.reportError} onFileAction={props.onFileAction}
        onCompareWork={props.onCompareWork} onEditSource={props.onEditSource} onRefAction={props.onRefAction}
        onCommitAction={props.onCommitAction} onCompareCommits={props.onCompareCommits}
        options={props.options} onOptions={props.onOptions} repoName={props.repoName} path={path} />
    </div>)}
  </div>;
}
