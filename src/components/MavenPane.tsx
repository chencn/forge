import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Cog,
  Folder,
  ListTree,
  Package,
  Play,
  Plus,
  Square,
  SquareTerminal,
} from "lucide-react";
import { useI18n } from "../i18n";
import type { TranslationKey } from "../i18n/lang/zh";
import {
  mavenPomPath,
  mavenRunConfig,
  mavenWorkingDir,
} from "../lib/maven";
import type { MavenDependency, MavenModule, MavenProject, MavenSourceRoot } from "../lib/maven";
import type { RunConfiguration, RunTools } from "../lib/runConfigs";
import MavenIcon from "./MavenIcon";

/** 生命周期目标快捷列表（面板里的 phase 按钮）。 */
const PHASES = ["clean", "validate", "compile", "test", "package", "verify", "install", "site", "deploy"] as const;

/** 源码根 kind 的展示文案键。 */
const ROOT_KIND: Record<MavenSourceRoot["kind"], TranslationKey> = {
  mainJava: "maven.kind.mainJava",
  mainResources: "maven.kind.mainResources",
  testJava: "maven.kind.testJava",
  testResources: "maven.kind.testResources",
};

/** Maven 工具窗口的入参。 */
interface Props {
  workspace: string;
  project: MavenProject | null;
  error: string | null;
  refreshing: boolean;
  running: boolean;
  /** 本机探测到的构建工具；mvn 为空串时运行/执行目标置灰。 */
  tools: RunTools;
  onRun: (config: RunConfiguration) => void;
  onStop: () => void;
  onOpenFile: (path: string) => void;
}

/** Maven 工具窗口：项目结构树、生命周期 phase 执行与 profiles/依赖视图。 */
export default function MavenPane({
  workspace,
  project,
  error,
  refreshing,
  running,
  tools,
  onRun,
  onStop,
  onOpenFile,
}: Props) {
  const { t } = useI18n();
  // 本机没有 mvn 就不该让「运行/执行目标」可点——状态已知，与 RunControls 的 unavailable 门禁同源。
  const mvnMissing = !tools.maven;
  const [expanded, setExpanded] = useState<Set<string>>(() => initialExpanded(project));
  const [selectedModule, setSelectedModule] = useState<string | null>(null);
  const [selectedPhase, setSelectedPhase] = useState<string>("compile");
  const [skipTests, setSkipTests] = useState(false);
  const [profiles, setProfiles] = useState<string[]>(() => defaultProfiles(project));
  const [extraProfiles, setExtraProfiles] = useState<string[]>([]);
  const [goalOpen, setGoalOpen] = useState(false);
  const [goalText, setGoalText] = useState("");
  const [profileText, setProfileText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const profileIds = useMemo(() => {
    const ids = new Set<string>([...(project?.profiles.map((item) => item.id) ?? []), ...extraProfiles]);
    return [...ids];
  }, [extraProfiles, project]);

  const toggle = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runGoals = (goals: string[], module: string | null, title: string) => {
    if (!project || running) return;
    const config = mavenRunConfig(
      project,
      module,
      goals,
      profiles,
      skipTests,
      title,
      mavenWorkingDir(workspace, project),
    );
    if (!config) {
      setNotice(t("maven.goalInvalid"));
      return;
    }
    setNotice(null);
    onRun(config);
  };

  const runPhase = (phase: string, module: MavenModule | null) => {
    if (!project) return;
    setSelectedModule(module?.relativePath ?? null);
    setSelectedPhase(phase);
    const target = module?.artifactId ?? project.artifactId;
    runGoals([phase], module?.relativePath ?? null, `${phase} · ${target}`);
  };

  const runCustom = () => {
    const goals = goalText.trim().split(/\s+/).filter(Boolean);
    if (!project || goals.length === 0) return;
    const module = findModule(project.modules, selectedModule);
    const target = module?.artifactId ?? project.artifactId;
    setGoalOpen(false);
    runGoals(goals, module?.relativePath ?? null, `${goals.join(" ")} · ${target}`);
  };

  const openPom = (module: string | null) => {
    if (!project) return;
    onOpenFile(mavenPomPath(workspace, project, module));
  };

  return (
    <section className="maven-pane" aria-label={t("maven.title")}>
      <div className="maven-toolbar">
        <button
          type="button"
          className="icon-button is-inline"
          disabled={!project || mvnMissing || running}
          title={!project ? t("maven.goalInvalid") : mvnMissing ? t("maven.mvnMissing") : running ? t("maven.stop") : t("maven.runSelected")}
          onClick={() => {
            if (running) {
              onStop();
              return;
            }
            const module = findModule(project?.modules ?? [], selectedModule);
            runPhase(selectedPhase, module);
          }}
        >
          {running ? <Square size={14} className="maven-icon-warning" /> : <Play size={14} className="maven-icon-success" />}
        </button>
        <button
          type="button"
          className="icon-button is-inline"
          title={t("maven.executeGoal")}
          disabled={!project || running}
          onClick={() => {
            setGoalText("");
            setNotice(null);
            setGoalOpen((open) => !open);
          }}
        >
          <SquareTerminal size={14} />
        </button>
        <button
          type="button"
          className="icon-button is-inline"
          title={t("maven.collapseAll")}
          onClick={() => setExpanded(new Set())}
        >
          <ListTree size={14} />
        </button>
        <label className="maven-skip" title={t("maven.skipTests")}>
          <input
            type="checkbox"
            checked={skipTests}
            disabled={!project}
            aria-label={t("maven.skipTests")}
            onChange={(event) => setSkipTests(event.target.checked)}
          />
        </label>
      </div>
      {goalOpen ? (
        <form
          className="maven-goal-form"
          onSubmit={(event) => {
            event.preventDefault();
            runCustom();
          }}
        >
          <input
            className="text-input"
            autoFocus
            value={goalText}
            placeholder={t("maven.goalPlaceholder")}
            onChange={(event) => setGoalText(event.target.value)}
          />
          <button type="submit" className="maven-goal-run" disabled={!goalText.trim() || running || mvnMissing}>
            {t("maven.run")}
          </button>
        </form>
      ) : null}
      {notice || error ? (
        <p className={`maven-banner${notice ? "" : " is-error"}`}>{notice ?? t("maven.loadFailed")}</p>
      ) : null}
      {!project ? (
        <p className="maven-empty">{refreshing ? t("maven.scanning") : t("maven.loadFailed")}</p>
      ) : (
        <div className="maven-tree">
          {profileIds.length > 0 ? (
            <Branch
              id="profiles"
              title={t("maven.profiles")}
              icon={<Folder size={14} />}
              expanded={expanded.has("profiles")}
              onToggle={toggle}
            >
              <div className="maven-profile-add">
                <input
                  className="text-input"
                  value={profileText}
                  placeholder={t("maven.addProfile")}
                  onChange={(event) => setProfileText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    const id = profileText.trim();
                    if (!id || profileIds.includes(id)) return;
                    setExtraProfiles((current) => [...current, id]);
                    setProfiles((current) => [...current, id]);
                    setProfileText("");
                  }}
                />
                <button
                  type="button"
                  className="icon-button is-inline"
                  title={t("maven.addProfile")}
                  onClick={() => {
                    const id = profileText.trim();
                    if (!id || profileIds.includes(id)) return;
                    setExtraProfiles((current) => [...current, id]);
                    setProfiles((current) => [...current, id]);
                    setProfileText("");
                  }}
                >
                  <Plus size={14} />
                </button>
              </div>
              {profileIds.map((id) => (
                <label key={id} className="maven-profile">
                  <input
                    type="checkbox"
                    checked={profiles.includes(id)}
                    onChange={(event) => {
                      setProfiles((current) =>
                        event.target.checked ? [...current, id] : current.filter((item) => item !== id),
                      );
                    }}
                  />
                  <span className="maven-label">{id}</span>
                </label>
              ))}
            </Branch>
          ) : null}
          <ModuleNode
            node={project}
            reactor
            expanded={expanded}
            selectedModule={selectedModule}
            selectedPhase={selectedPhase}
            onToggle={toggle}
            onSelectModule={setSelectedModule}
            onSelectPhase={(module, phase) => {
              setSelectedModule(module);
              setSelectedPhase(phase);
            }}
            onRunPhase={runPhase}
            onOpenPom={openPom}
          />
        </div>
      )}
    </section>
  );
}

/** 初始展开集：默认展开 project 节点，有 profiles 再展开 profiles。 */
function initialExpanded(project: MavenProject | null): Set<string> {
  if (!project) return new Set();
  const next = new Set<string>(["project"]);
  if (project.profiles.length > 0) next.add("profiles");
  return next;
}

/** POM 里 activeByDefault 的 profile id。 */
function defaultProfiles(project: MavenProject | null): string[] {
  return project?.profiles.filter((item) => item.activeByDefault).map((item) => item.id) ?? [];
}

/** 按 relativePath 在模块树（含嵌套）里找模块；没有返回 null。 */
function findModule(modules: readonly MavenModule[], relativePath: string | null): MavenModule | null {
  if (!relativePath) return null;
  for (const module of modules) {
    if (module.relativePath === relativePath) return module;
    const nested = findModule(module.modules, relativePath);
    if (nested) return nested;
  }
  return null;
}

/** 模块树节点：reactor 表示工程根本身。 */
function ModuleNode({
  node,
  reactor,
  expanded,
  selectedModule,
  selectedPhase,
  onToggle,
  onSelectModule,
  onSelectPhase,
  onRunPhase,
  onOpenPom,
}: {
  node: MavenModule;
  reactor: boolean;
  expanded: Set<string>;
  selectedModule: string | null;
  selectedPhase: string;
  onToggle: (id: string) => void;
  onSelectModule: (module: string | null) => void;
  onSelectPhase: (module: string | null, phase: string) => void;
  onRunPhase: (phase: string, module: MavenModule | null) => void;
  onOpenPom: (module: string | null) => void;
}) {
  const { t } = useI18n();
  const id = reactor ? "project" : `module:${node.relativePath}`;
  const modulePath = reactor ? null : node.relativePath;
  const open = expanded.has(id);
  const selected = selectedModule === modulePath;
  return (
    <div>
      <Row
        expanded={open}
        hasChildren
        selected={selected}
        title={node.artifactId}
        subtitle={reactor ? node.packaging : node.relativePath}
        icon={reactor ? <MavenIcon size={14} /> : <Package size={14} />}
        onToggle={() => onToggle(id)}
        onSelect={() => onSelectModule(modulePath)}
        onOpen={() => onOpenPom(modulePath)}
      />
      {open ? (
        <div className="maven-children">
          {node.sourceRoots.length > 0 ? (
            <Branch
              id={`${id}:sources`}
              title={t("maven.sourceRoots")}
              icon={<Folder size={14} />}
              expanded={expanded.has(`${id}:sources`)}
              onToggle={onToggle}
            >
              {node.sourceRoots.map((root) => (
                <Row
                  key={root.kind}
                  plain
                  spread
                  title={root.path}
                  subtitle={t(ROOT_KIND[root.kind])}
                  icon={<Folder size={14} />}
                  tone={root.kind.startsWith("test") ? "success" : "primary"}
                />
              ))}
            </Branch>
          ) : null}
          <Branch
            id={`${id}:lifecycle`}
            title={t("maven.lifecycle")}
              icon={<Cog size={14} />}
            expanded={expanded.has(`${id}:lifecycle`)}
            onToggle={onToggle}
          >
            {PHASES.map((phase) => {
              const phaseSelected = selected && selectedPhase === phase;
              return (
                <Row
                  key={phase}
                  plain
                  hoverable={!phaseSelected}
                  muted={!phaseSelected}
                  selected={phaseSelected}
                  title={phase}
                  icon={<Play size={12} />}
                  tone={phaseSelected ? "success" : "subtle"}
                  onSelect={() => onSelectPhase(modulePath, phase)}
                  onOpen={() => onRunPhase(phase, reactor ? null : node)}
                />
              );
            })}
          </Branch>
          <Branch
            id={`${id}:deps`}
            title={t("maven.dependencies")}
            icon={<Package size={14} />}
            expanded={expanded.has(`${id}:deps`)}
            onToggle={onToggle}
          >
            {node.dependencies.length === 0 ? (
              <p className="maven-muted">{t("maven.noDependencies")}</p>
            ) : (
              node.dependencies.map((dep, index) => (
                <DependencyRow key={`${dep.groupId}:${dep.artifactId}:${index}`} dep={dep} />
              ))
            )}
          </Branch>
          {node.modules.map((child) => (
            <ModuleNode
              key={child.relativePath}
              node={child}
              reactor={false}
              expanded={expanded}
              selectedModule={selectedModule}
              selectedPhase={selectedPhase}
              onToggle={onToggle}
              onSelectModule={onSelectModule}
              onSelectPhase={onSelectPhase}
              onRunPhase={onRunPhase}
              onOpenPom={onOpenPom}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 依赖列表里的一行。 */
function DependencyRow({ dep }: { dep: MavenDependency }) {
  const subtitle = [dep.groupId, dep.version, dep.scope].filter(Boolean).join(" · ");
  return (
    <Row
      title={dep.artifactId}
      subtitle={subtitle}
      icon={<Package size={14} />}
    />
  );
}

/** 可折叠的分组容器行（Profiles / Dependencies / Source Roots 等）。 */
function Branch({
  id,
  title,
  icon,
  expanded,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  icon: ReactNode;
  expanded: boolean;
  onToggle: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <div>
      <Row
        expanded={expanded}
        hasChildren
        title={title}
        icon={icon}
        onToggle={() => onToggle(id)}
        onSelect={() => onToggle(id)}
      />
      {expanded ? <div className="maven-children">{children}</div> : null}
    </div>
  );
}

/** 树的通用一行：折叠箭头 + 图标 + 标题/副标题。 */
function Row({
  title,
  subtitle,
  icon,
  tone = "primary",
  expanded,
  hasChildren,
  selected,
  muted,
  plain,
  spread,
  hoverable,
  onToggle,
  onSelect,
  onOpen,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  tone?: "primary" | "success" | "warning" | "subtle";
  expanded?: boolean;
  hasChildren?: boolean;
  selected?: boolean;
  muted?: boolean;
  plain?: boolean;
  spread?: boolean;
  hoverable?: boolean;
  onToggle?: () => void;
  onSelect?: () => void;
  onOpen?: () => void;
}) {
  const rowClass = [
    "maven-row",
    selected ? "is-selected" : "",
    muted ? "is-muted" : "",
    plain ? "is-plain" : "",
    hoverable ? "is-hoverable" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={rowClass}>
      {plain ? null : hasChildren ? (
        <button type="button" className="maven-twist" onClick={onToggle} aria-label={expanded ? "collapse" : "expand"}>
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      ) : (
        <span className="maven-twist" />
      )}
      <button
        type="button"
        className={`maven-main${spread ? " is-spread" : ""}`}
        onClick={onSelect ?? onToggle}
        onDoubleClick={onOpen}
      >
        {icon ? <span className={`maven-icon is-${tone}`}>{icon}</span> : null}
        <span className="maven-label">{title}</span>
        {subtitle ? <span className="maven-sub">{subtitle}</span> : null}
      </button>
    </div>
  );
}
