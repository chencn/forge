import {
  Bird,
  Braces,
  CircleDot,
  Cog,
  Coffee,
  Cpu,
  Droplets,
  FileCode,
  Flame,
  Gem,
  Hexagon,
  LineChart,
  Monitor,
  Moon,
  Package,
  Scroll,
  Sigma,
  Smartphone,
  SquareCode,
  Terminal,
  Waves,
  Zap,
} from "lucide-react";
import { basenameOf, nativeSeparators, resolvePath } from "./format";
import { javaKindSvg, useJavaFileIcon } from "./javaKindIcons";
import type { RunConfiguration, RunKind } from "./runConfigs";
import { useSettings } from "../hooks/useSettings";
import type { TranslationKey } from "../i18n/lang/zh";
import MavenIcon from "../components/MavenIcon";
import SpringIcon from "../components/SpringIcon";

type KindIcon = React.ComponentType<{ size?: number; className?: string }>;

/**
 * 每种运行配置的图标与分组名。
 *
 * IDEA 的运行配置下拉里，图标就是「这条是什么类型」的第一层信息：Spring 一片叶、
 * Java 一杯咖啡、Maven 那枚 M、Gradle 一团火。这里用形状接近的矢量图标顶替，
 * 分组名照 IDEA 的类型显示名。色只有六档，长尾那十几族靠形状分：Ruby 一颗宝石、
 * Swift 一只鸟、Lua 一弯月、Zig 一道电、Deno 一层浪、Haskell 一卷轴、C/C++ 一枚芯片。
 */
const ICONS: Record<RunKind, { icon: KindIcon; label: TranslationKey }> = {
  spring: { icon: SpringIcon, label: "run.kind.spring" },
  npm: { icon: Package, label: "run.kind.npm" },
  java: { icon: Coffee, label: "run.kind.java" },
  maven: { icon: MavenIcon, label: "run.kind.maven" },
  gradle: { icon: Flame, label: "run.kind.gradle" },
  go: { icon: CircleDot, label: "run.kind.go" },
  wails: { icon: Monitor, label: "run.kind.wails" },
  rust: { icon: Cog, label: "run.kind.rust" },
  python: { icon: FileCode, label: "run.kind.python" },
  dotnet: { icon: Hexagon, label: "run.kind.dotnet" },
  clojure: { icon: Braces, label: "run.kind.clojure" },
  cpp: { icon: Cpu, label: "run.kind.cpp" },
  dart: { icon: Smartphone, label: "run.kind.dart" },
  deno: { icon: Waves, label: "run.kind.deno" },
  elixir: { icon: Droplets, label: "run.kind.elixir" },
  haskell: { icon: Scroll, label: "run.kind.haskell" },
  julia: { icon: LineChart, label: "run.kind.julia" },
  lua: { icon: Moon, label: "run.kind.lua" },
  php: { icon: SquareCode, label: "run.kind.php" },
  ruby: { icon: Gem, label: "run.kind.ruby" },
  scala: { icon: Sigma, label: "run.kind.scala" },
  swift: { icon: Bird, label: "run.kind.swift" },
  zig: { icon: Zap, label: "run.kind.zig" },
  shell: { icon: Terminal, label: "run.kind.shell" },
};

/** 分组与行图标都用这一份次序，和后端 `kind_rank` 同序；命令行垫底。 */
export const RUN_KIND_ORDER: RunKind[] = [
  "spring",
  "npm",
  "java",
  "maven",
  "gradle",
  "go",
  "wails",
  "rust",
  "python",
  "dotnet",
  "clojure",
  "cpp",
  "dart",
  "deno",
  "elixir",
  "haskell",
  "julia",
  "lua",
  "php",
  "ruby",
  "scala",
  "swift",
  "zig",
  "shell",
];

export function RunKindIcon({ kind, size = 13 }: { kind: RunKind; size?: number }) {
  const entry = ICONS[kind];
  const Icon = entry.icon;
  return <Icon size={size} className={`run-kind is-${kind}`} aria-hidden="true" />;
}

/** Java 运行配置用源文件那套图标：类、接口、枚举、注解、record、异常。还没读出来时先用咖啡杯。 */
function javaSourcePath(root: string | null, config: RunConfiguration): string | undefined {
  if (config.kind !== "java" || !root) return undefined;
  const file = config.markers?.find((marker) => marker.file.toLowerCase().endsWith(".java"))?.file;
  if (!file) return undefined;
  return nativeSeparators(resolvePath(root, file));
}

export function RunConfigIcon({
  config,
  root,
  size = 13,
}: {
  config: RunConfiguration;
  root: string | null;
  size?: number;
}) {
  const { applied } = useSettings();
  const path = javaSourcePath(root, config);
  const kind = useJavaFileIcon(path, path ? basenameOf(path) : "");
  if (kind) {
    return (
      <span
        className="run-kind is-java-file"
        style={{ width: size, height: size }}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: javaKindSvg(kind, applied === "dark") }}
      />
    );
  }
  return <RunKindIcon kind={config.kind} size={size} />;
}

export function runKindLabel(kind: RunKind): TranslationKey {
  return ICONS[kind].label;
}
