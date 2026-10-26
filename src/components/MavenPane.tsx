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
import type { RunConfiguration } from "../lib/runConfigs";
import MavenIcon from "./MavenIcon";

const PHASES = ["clean", "validate", "compile", "test", "package", "verify", "install", "site", "deploy"] as const;

const ROOT_KIND: Record<MavenSourceRoot["kind"], TranslationKey> = {
  mainJava: "maven.kind.mainJava",
  mainResources: "maven.kind.mainResources",
  testJava: "maven.kind.testJava",
  testResources: "maven.kind.testResources",
};

interface Props {
  workspace: string;
  project: MavenProject | null;
  error: string | null;
  refreshing: boolean;
  running: boolean;
  onRun: (config: RunConfiguration) => void;
  onStop: () => void;
  onOpenFile: (path: string) => void;
}

export default function MavenPane({
  workspace,
  project,
  error,
  refreshing,
  running,
  onRun,
  onStop,
  onOpenFile,
}: Props) {
  const { t } = useI18n();
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
          title={running ? t("maven.stop") : t("maven.runSelected")}
          disabled={!project}
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
          <button type="submit" className="maven-goal-run" disabled={!goalText.trim() || running}>
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

function initialExpanded(project: MavenProject | null): Set<string> {
  if (!project) return new Set();
  const next = new Set<string>(["project"]);
  if (project.profiles.length > 0) next.add("profiles");
  return next;
}

function defaultProfiles(project: MavenProject | null): string[] {
  return project?.profiles.filter((item) => item.activeByDefault).map((item) => item.id) ?? [];
}

function findModule(modules: readonly MavenModule[], relativePath: string | null): MavenModule | null {
  if (!relativePath) return null;
  for (const module of modules) {
    if (module.relativePath === relativePath) return module;
    const nested = findModule(module.modules, relativePath);
    if (nested) return nested;
  }
  return null;
}

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
