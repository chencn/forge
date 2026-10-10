import { useCallback, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Copy, FolderOpen, Plus, Trash } from "lucide-react";
import Select from "./Select";
import { RUN_KIND_ORDER, RunKindIcon, runKindLabel } from "../lib/runIcons";
import { resolveCommand } from "../lib/runConfigs";
import type { EnvVar, RunConfiguration, RunKind } from "../lib/runConfigs";
import type { RunConfigController } from "../hooks/useRunConfigs";
import { basenameOf, joinPath } from "../lib/format";
import { useI18n } from "../i18n";

interface RunConfigsPageProps {
  configs: RunConfigController;
}

/** 新建配置时能挑的类型就用这一份权威次序，不另列一张表。 */
const KINDS: RunKind[] = RUN_KIND_ORDER;

/**
 * 「编辑程序配置」：整页开在编辑区页签里，和设置同一套形态。
 *
 * 左侧两节：自己建的那批可以改，识别出来的那批只读——构建文件一改它们就变，
 * 存成副本再改才不会和识别结果打架。改一处就写一次盘，不设「确定 / 取消」。
 */
export default function RunConfigsPage({ configs }: RunConfigsPageProps) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<string>(configs.custom[0]?.id ?? configs.configs[0]?.id ?? "");
  const current = useMemo(
    () => configs.configs.find((config) => config.id === picked) ?? configs.custom[0] ?? null,
    [configs.configs, configs.custom, picked]
  );

  const commit = useCallback(
    (next: RunConfiguration) => {
      if (!next.generated) configs.saveCustom(next);
    },
    [configs]
  );

  const addOne = () => {
    const draft: RunConfiguration = {
      id: crypto.randomUUID(),
      name: t("run.newConfigName"),
      kind: "shell",
      command: "",
      workingDir: "",
      env: [],
      generated: false,
      pinned: false,
      unavailable: null,
      helper: null,
    };
    configs.saveCustom(draft);
    setPicked(draft.id);
  };

  const copyOne = () => {
    if (!current) return;
    const clone = configs.saveAsCustom(current);
    setPicked(clone);
  };

  const removeOne = () => {
    if (!current || current.generated) return;
    configs.removeCustom(current.id);
    setPicked(configs.custom.find((item) => item.id !== current.id)?.id ?? "");
  };

  const browseDir = async () => {
    if (!current || current.generated || !configs.workspace) return;
    const pickedDir = await open({
      directory: true,
      title: t("run.workingDir"),
      defaultPath: current.workingDir ? joinPath(configs.workspace, current.workingDir) : configs.workspace,
    });
    if (typeof pickedDir !== "string") return;
    // 存的是相对工程根的写法：整棵目录挪盘子，配置不用跟着改。
    const relative = pickedDir.startsWith(configs.workspace)
      ? pickedDir.slice(configs.workspace.length).replace(/^[\\/]/, "")
      : pickedDir;
    commit({ ...current, workingDir: relative });
  };

  return (
    <div className="settings-page">
      <nav className="settings-nav" aria-label={t("run.editConfigs")}>
        <p className="settings-nav-title">{t("run.editConfigs")}</p>
        <RunConfigGroup
          title={t("run.sectionCustom")}
          items={configs.custom}
          picked={picked}
          onPick={setPicked}
        />
        <RunConfigGroup
          title={t("run.sectionDetected")}
          items={configs.detected}
          picked={picked}
          onPick={setPicked}
        />
      </nav>

      <div className="settings-body">
        <header className="settings-head">
          <span className="settings-head-title">
            {current ? current.name : t("run.editConfigs")}
          </span>
          <span className="settings-head-spacer" />
          <button type="button" className="icon-button is-inline" title={t("run.newConfig")} onClick={addOne}>
            <Plus size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button is-inline"
            title={current?.generated ? t("run.saveAsCustom") : t("run.copy")}
            disabled={!current}
            onClick={copyOne}
          >
            <Copy size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button is-inline"
            title={t("run.delete")}
            disabled={!current || current.generated}
            onClick={removeOne}
          >
            <Trash size={15} aria-hidden="true" />
          </button>
        </header>

        {!current ? (
          <p className="settings-note">{t("run.none")}</p>
        ) : (
          <div className="settings-rows">
            {current.generated ? (
              <p className="settings-note">{t("run.detectedNote", { name: current.name })}</p>
            ) : null}
            <div className="settings-row">
              <span className="settings-label">{t("run.fieldName")}</span>
              <input
                className="settings-input is-wide"
                value={current.name}
                disabled={current.generated}
                onChange={(event) => commit({ ...current, name: event.target.value })}
              />
            </div>
            <div className="settings-row">
              <span className="settings-label">{t("run.fieldKind")}</span>
              <Select
                value={current.kind}
                options={KINDS.map((kind) => ({ value: kind, label: t(runKindLabel(kind)) }))}
                onChange={(kind) => commit({ ...current, kind })}
                placeholder={t("run.fieldKind")}
                label={t("run.fieldKind")}
                disabled={current.generated}
              />
            </div>
            <div className="settings-row">
              <span className="settings-label">{t("run.fieldCommand")}</span>
              <textarea
                className="settings-input is-code"
                rows={2}
                spellCheck={false}
                value={current.command}
                disabled={current.generated}
                title={
                  current.generated
                    ? resolveCommand(current.command, configs.tools)
                    : undefined
                }
                onChange={(event) => commit({ ...current, command: event.target.value })}
              />
            </div>
            <div className="settings-row">
              <span className="settings-label">{t("run.workingDir")}</span>
              <span className="run-dir">
                <input
                  className="settings-input"
                  value={current.workingDir}
                  placeholder={basenameOf(configs.workspace ?? "")}
                  disabled={current.generated}
                  onChange={(event) => commit({ ...current, workingDir: event.target.value })}
                />
                <button
                  type="button"
                  className="icon-button is-inline"
                  title={t("run.pickDir")}
                  disabled={current.generated || !configs.workspace}
                  onClick={() => void browseDir()}
                >
                  <FolderOpen size={15} aria-hidden="true" />
                </button>
              </span>
            </div>
            <RunEnvRows
              env={current.env}
              disabled={current.generated}
              onChange={(next) => commit({ ...current, env: next })}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function RunConfigGroup({
  title,
  items,
  picked,
  onPick,
}: {
  title: string;
  items: RunConfiguration[];
  picked: string;
  onPick: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="run-config-group">
      <p className="settings-nav-title">{title}</p>
      {items.map((config) => (
        <button
          key={config.id}
          type="button"
          className={`settings-nav-item${config.id === picked ? " is-active" : ""}`}
          title={config.command}
          onClick={() => onPick(config.id)}
        >
          <RunKindIcon kind={config.kind} />
          <span className="run-config-name">{config.name}</span>
        </button>
      ))}
    </div>
  );
}

/** 环境变量：一行一条，名字空的行不算数。IDEA 那侧是「名字 = 值; 名字 = 值」一栏，这里拆成行更好改。 */
function RunEnvRows({
  env,
  disabled,
  onChange,
}: {
  env: EnvVar[];
  disabled: boolean;
  onChange: (next: EnvVar[]) => void;
}) {
  const { t } = useI18n();
  const rows: EnvVar[] = env.length > 0 ? env : [{ name: "", value: "" }];
  const write = (index: number, patch: Partial<EnvVar>) => {
    const next = rows.map((row, at) => (at === index ? { ...row, ...patch } : row));
    // 全空的尾巴不留：写盘的 env 数组里多一条空行是脏数据。
    onChange(next.filter((row, at) => at < env.length || row.name.trim() !== "" || row.value !== ""));
  };
  return (
    <div className="settings-row is-stack">
      <span className="settings-label">{t("run.env")}</span>
      <div className="run-env">
        {rows.map((row, index) => (
          <div key={index} className="run-env-row">
            <input
              className="settings-input"
              value={row.name}
              placeholder="PORT"
              disabled={disabled}
              onChange={(event) => write(index, { name: event.target.value })}
            />
            <input
              className="settings-input"
              value={row.value}
              placeholder="8080"
              disabled={disabled}
              onChange={(event) => write(index, { value: event.target.value })}
            />
            <button
              type="button"
              className="icon-button is-inline"
              title={t("run.envRemove")}
              disabled={disabled || (row.name === "" && row.value === "")}
              onClick={() => onChange(rows.filter((_, at) => at !== index))}
            >
              <Trash size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
        <button type="button" className="text-button" disabled={disabled} onClick={() => onChange([...rows, { name: "", value: "" }])}>
          <Plus size={13} aria-hidden="true" />
          {t("run.envAdd")}
        </button>
      </div>
    </div>
  );
}
