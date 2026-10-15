import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { ChevronDown, MoreVertical, Pencil, Play, Plus, RefreshCw, Square, Wrench } from "lucide-react";
import ContextMenu from "./ContextMenu";
import type { MenuItem } from "./ContextMenu";
import Popover from "./Popover";
import { RerunIcon, RunIcon, StopIcon } from "./RunIcons";
import { RunKindIcon, RUN_KIND_ORDER, runKindLabel } from "../lib/runIcons";
import { codedError, describeError } from "../lib/errors";
import { missingTool, newShellConfig, resolveCommand } from "../lib/runConfigs";
import type { RunConfiguration } from "../lib/runConfigs";
import type { RunConfigController } from "../hooks/useRunConfigs";
import type { RunController } from "../hooks/useRunSessions";
import { useI18n } from "../i18n";

interface RunControlsProps {
  configs: RunConfigController;
  run: RunController;
  /** 工作区没打开时整条禁用。 */
  enabled: boolean;
  /** 递增即把下拉打开，`Alt+Shift+F10` 走这一条。 */
  chooserSignal: number;
  /** 点运行后要把输出面板带出来。 */
  onStarted: () => void;
  /** 「编辑程序配置…」开的是编辑区那一页，不是弹窗。 */
  onEditConfigs: () => void;
}

/** 行上那颗 `⋯` 与右键用的菜单，先记住是哪一条再开。 */
type PendingRow = { config: RunConfiguration; x: number; y: number } | null;

/**
 * IDEA 把「跑什么」当成和工程同级的上下文，所以这颗下拉和这几颗按钮住在主工具栏。
 *
 * 控件既不持有会话也不持有配置：两份状态都挂在 App 上（`useRunConfigs` 与
 * `useRunSessions`），这里只画与转。工具窗口关着也能跑，输出监听跟着 App 注册。
 */
export default function RunControls({
  configs,
  run,
  enabled,
  chooserSignal,
  onStarted,
  onEditConfigs,
}: RunControlsProps) {
  const { t } = useI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [pending, setPending] = useState<PendingRow>(null);
  /** 多条在跑时，停止那颗先开一层列表（每条一项 + 停止全部），照 IDEA 的做法。 */
  const [stopOpen, setStopOpen] = useState(false);
  const selected = configs.selected;

  /** 一条配置现在能不能跑：本机缺工具就说不清它跑什么，那种条目只列不点。 */
  const blockedOf = useCallback(
    (config: RunConfiguration) => {
      if (config.unavailable) {
        return describeError(codedError(config.unavailable.code, config.unavailable.detail), t);
      }
      const missing = missingTool(config.command, configs.tools);
      if (missing) {
        return describeError(codedError("NO_TOOL", missing.replace(/[${}]/g, "")), t);
      }
      return null;
    },
    [configs.tools, t]
  );

  /** 这条配置有没有正在跑的会话。IDEA 的按钮状态是跟着「这一条」走的，不是跟着面板走的。 */
  const runningOf = useCallback(
    (config: RunConfiguration | null) =>
      config !== null &&
      run.sessions.some(
        (session) => session.status === "running" && session.config.id === config.id
      ),
    [run.sessions]
  );

  const sections = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matches = (config: RunConfiguration) =>
      !needle ||
      config.name.toLowerCase().includes(needle) ||
      config.command.toLowerCase().includes(needle);
    const pool = configs.configs.filter(matches);
    const pinned = pool.filter((config) => config.pinned);
    const rest = pool.filter((config) => !config.pinned);
    return [
      { label: t("run.sectionPinned"), items: pinned },
      ...RUN_KIND_ORDER.map((kind) => ({
        label: t(runKindLabel(kind)),
        items: rest.filter((config) => config.kind === kind),
      })),
    ].filter((section) => section.items.length > 0);
  }, [configs.configs, filter, t]);

  useEffect(() => {
    if (!open) setFilter("");
  }, [open]);

  // 信号每递增一次把下拉打开一次；挂载时那个 0 不算。工作区可用时即响应打开下拉。
  useEffect(() => {
    if (chooserSignal > 0 && enabled) setOpen(true);
  }, [chooserSignal, enabled]);

  const addAndEditCustom = useCallback(() => {
    const draft = newShellConfig(crypto.randomUUID(), t("run.newConfigName"));
    configs.saveCustom(draft);
    configs.select(draft.id);
    setOpen(false);
    onEditConfigs();
  }, [configs, onEditConfigs, t]);

  const launch = useCallback(
    (config: RunConfiguration) => {
      configs.select(config.id);
      run.start(config);
      onStarted();
      setOpen(false);
    },
    [configs, onStarted, run]
  );

  const stopOf = useCallback(
    (config: RunConfiguration) => {
      // 认 id 不认名字：两条配置同名是允许的，名字撞车会停错那一台。
      for (const session of run.sessions) {
        if (session.status === "running" && session.config.id === config.id) run.stop(session.id);
      }
    },
    [run]
  );

  /** 重开选中配置在跑的那几条：就地重启，复用原标签页，不新开。 */
  const restartOf = useCallback(
    (config: RunConfiguration) => {
      const running = run.sessions.filter(
        (session) => session.status === "running" && session.config.id === config.id
      );
      if (running.length === 0) {
        launch(config);
        return;
      }
      for (const session of running) run.restartSession(session.id);
    },
    [launch, run]
  );

  const rowMenu = (event: ReactMouseEvent, config: RunConfiguration) => {
    event.preventDefault();
    event.stopPropagation();
    setPending({ config, x: event.clientX, y: event.clientY });
  };

  const menuFor = (config: RunConfiguration): MenuItem[] => [
    {
      label: t("run.edit"),
      icon: Pencil,
      // 识别出来的那条改不了本体：先存成自己的，再改那一份。
      hint: config.generated ? t("run.editGeneratedHint") : undefined,
      onSelect: () => {
        setOpen(false);
        onEditConfigs();
      },
    },
    {
      label: config.pinned ? t("run.unpin") : t("run.pin"),
      onSelect: () => configs.togglePin(config.id),
    },
    {
      label: t("run.saveAsCustom"),
      disabled: !config.generated,
      hint: config.generated ? undefined : t("run.saveAsCustomHint"),
      onSelect: () => configs.saveAsCustom(config),
    },
  ];

  /** 选中配置正在跑的实例；IDEA 的按钮状态跟着「这一条配置」走。 */
  const selectedRunCount = selected
    ? run.sessions.filter(
        (session) => session.status === "running" && session.config.id === selected.id
      ).length
    : 0;
  const canRun = enabled && (selected ? blockedOf(selected) === null : true);
  /** 停止那颗管的是「现在还在跑的那几台」，多条时先弹列表再停。 */
  const runningSessions = run.sessions.filter((session) => session.status === "running");
  const stopAll = () => {
    for (const session of runningSessions) run.stop(session.id);
  };
  const firstMatch = sections[0]?.items[0] ?? null;

  return (
    <div className="run-controls" role="group" aria-label={t("run.config")}>
      <button
        ref={triggerRef}
        type="button"
        className="run-selector"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!enabled}
        title={t("run.chooseConfig")}
        onClick={() => setOpen((state) => !state)}
      >
        {selected ? <RunKindIcon kind={selected.kind} /> : null}
        {selectedRunCount > 0 ? <span className="run-dot is-running" aria-hidden="true" /> : null}
        <span className={`run-selector-name${selected ? "" : " is-empty"}`}>
          {selected ? selected.name : t("run.none")}
        </span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>

      {open ? (
        <Popover anchor={triggerRef.current} onClose={() => setOpen(false)} minWidth={280}>
          {configs.configs.length > 0 ? (
            <div className="run-filter">
              <input
                // 弹层一开就要能打字：键位选完配置直接输入名字，是 IDEA 的手感。
                autoFocus
                className="run-filter-input"
                placeholder={t("run.filter")}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && firstMatch && !blockedOf(firstMatch)) launch(firstMatch);
                }}
              />
            </div>
          ) : null}

          {configs.configs.length === 0 ? (
            <div className="run-empty-wrapper">
              <p className="run-empty">{t("run.detectEmpty")}</p>
              <button
                type="button"
                className="button is-primary is-tiny run-empty-action"
                onClick={addAndEditCustom}
              >
                <Plus size={12} aria-hidden="true" />
                {t("run.addCustom")}
              </button>
            </div>
          ) : (
            <div className="run-list" role="menu">
              {sections.map((section) => (
                <div key={section.label} className="run-section">
                  <p className="run-section-label">{section.label}</p>
                  {section.items.map((config) => {
                    const blocked = blockedOf(config);
                    const running = runningOf(config);
                    return (
                      <div key={config.id} className="run-row">
                        <button
                          type="button"
                          role="menuitem"
                          className={`run-row-main${config.id === selected?.id ? " is-selected" : ""}${blocked ? " is-blocked" : ""}`}
                          // 名字到上限就省略号，完整名字和命令行都收在这条悬停里。
                          title={`${config.name}\n${blocked ?? resolveCommand(config.command, configs.tools)}`}
                          onClick={() => {
                            if (blocked) return;
                            // 点条目本身选中该配置并收起下拉面板；要直接跑就点右边那颗三角，和 IDEA 一样分两件事。
                            configs.select(config.id);
                            setOpen(false);
                          }}
                          onDoubleClick={() => {
                            if (!blocked) launch(config);
                          }}
                          onContextMenu={(event) => rowMenu(event, config)}
                        >
                          <RunKindIcon kind={config.kind} />
                          <span className="run-row-name">{config.name}</span>
                          {running ? (
                            <span className="run-dot is-running" aria-hidden="true" />
                          ) : null}
                          {blocked ? <span className="run-row-blocked">{blocked}</span> : null}
                        </button>
                        {running ? (
                          <button
                            type="button"
                            className="icon-button is-inline run-row-action is-stop"
                            title={t("run.stopNamed", { name: config.name })}
                            onClick={() => stopOf(config)}
                          >
                            <Square size={10} aria-hidden="true" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="icon-button is-inline run-row-action is-run"
                            title={t("run.startNamed", { name: config.name })}
                            disabled={blocked !== null}
                            onClick={() => {
                              if (blocked) return;
                              launch(config);
                            }}
                          >
                            <Play size={11} aria-hidden="true" />
                          </button>
                        )}
                        <button
                          type="button"
                          className="icon-button is-inline run-row-action"
                          title={t("run.moreActions")}
                          onClick={(event) => rowMenu(event, config)}
                        >
                          <MoreVertical size={12} aria-hidden="true" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
              {sections.length === 0 ? <p className="run-empty">{t("run.noMatch")}</p> : null}
            </div>
          )}

          <div className="run-popover-foot">
            {configs.configs.length > 0 ? (
              <button
                type="button"
                className="text-button"
                onClick={addAndEditCustom}
              >
                <Plus size={13} aria-hidden="true" />
                {t("run.addCustom")}
              </button>
            ) : null}
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setOpen(false);
                onEditConfigs();
              }}
            >
              <Wrench size={13} aria-hidden="true" />
              {t("run.editConfigs")}
            </button>
            <button
              type="button"
              className="text-button"
              title={t("run.rescanHint")}
              onClick={() => configs.rescan()}
            >
              <RefreshCw size={13} aria-hidden="true" />
              {t("run.rescan")}
            </button>
          </div>
        </Popover>
      ) : null}

      {/* 运行与重跑是同一颗：选中配置没在跑时显示「运行」，在跑时换成绿底「重跑」，
          和 IDEA 的 ExecutorAction 一套（按有无运行实例切图标与底色）。 */}
      <button
        type="button"
        className={`icon-button is-toolbar is-run${selectedRunCount > 0 ? " is-running" : ""}`}
        title={
          selected
            ? blockedOf(selected) ??
              (selectedRunCount > 0
                ? t("run.rerunNamed", { name: selected.name })
                : t("run.startNamed", { name: selected.name }))
            : t("run.addCustom")
        }
        onClick={() => {
          if (!selected) {
            addAndEditCustom();
            return;
          }
          if (blockedOf(selected)) return;
          if (selectedRunCount > 0) restartOf(selected);
          else launch(selected);
        }}
        disabled={!canRun}
      >
        {selectedRunCount > 0 ? <RerunIcon size={14} /> : <RunIcon size={14} />}
        {/* 该配置有多个运行实例时在右下角叠数字，与 IDEA 的 `IconUtil.addText` 一致。 */}
        {selectedRunCount >= 2 ? (
          <span className="run-badge" aria-hidden="true">
            {selectedRunCount > 9 ? "9+" : selectedRunCount}
          </span>
        ) : null}
      </button>
      {/* 没有实例在跑时停止按钮不出现，与 IDEA 的 StopAction 一致（`isEnabledAndVisible`）。 */}
      {runningSessions.length > 0 ? (
        <button
          ref={stopRef}
          type="button"
          className="icon-button is-toolbar is-stop"
          title={
            runningSessions.length > 1
              ? t("run.stopCount", { count: runningSessions.length })
              : run.activeSession
                ? t("run.stopNamed", { name: run.activeSession.name })
                : t("run.stop")
          }
          onClick={() => {
            // 只有一条时直接停；多条先弹列表挑，和 IDEA 一样。
            if (runningSessions.length === 1) run.stop(runningSessions[0].id);
            else setStopOpen((value) => !value);
          }}
        >
          <StopIcon size={12} />
          {/* 多个实例在跑时红按钮右下角显示总数，与 IDEA 的 RunWidget 一致。 */}
          {runningSessions.length >= 2 ? (
            <span className="run-badge is-on-solid" aria-hidden="true">
              {runningSessions.length > 9 ? "9+" : runningSessions.length}
            </span>
          ) : null}
        </button>
      ) : null}

      {stopOpen ? (
        <Popover anchor={stopRef.current} onClose={() => setStopOpen(false)}>
          <div className="run-list" role="menu">
            {runningSessions.map((session) => (
              <button
                key={session.id}
                type="button"
                role="menuitem"
                className="popover-item"
                onClick={() => {
                  run.stop(session.id);
                  setStopOpen(false);
                }}
              >
                <Square size={12} className="run-stop-glyph" aria-hidden="true" />
                <span className="popover-item-label">
                  {t("run.stopNamed", { name: session.name })}
                </span>
              </button>
            ))}
            <div className="popover-sep" />
            <button
              type="button"
              role="menuitem"
              className="popover-item"
              onClick={() => {
                stopAll();
                setStopOpen(false);
              }}
            >
              <span className="popover-item-label">
                {t("run.stopCount", { count: runningSessions.length })}
              </span>
              <span className="menu-accel">Ctrl+F2</span>
            </button>
          </div>
        </Popover>
      ) : null}

      {pending ? (
        <ContextMenu
          anchor={{ x: pending.x, y: pending.y, items: menuFor(pending.config) }}
          onClose={() => setPending(null)}
        />
      ) : null}
    </div>
  );
}
