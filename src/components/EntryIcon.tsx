import { useEffect, useSyncExternalStore } from "react";
import { File } from "lucide-react";
import MavenIcon from "./MavenIcon";
import SpringIcon from "./SpringIcon";
import { useMavenProject } from "../hooks/useMavenProject";
import { useSettings } from "../hooks/useSettings";
import { javaKindSvg, useJavaFileIcon } from "../lib/javaKindIcons";
import {
  folderKindSvg,
  resolveFolderKind,
  type FolderKind,
} from "../features/project-tree/folderKind";
import {
  ensureFileIcons,
  fileIconsReady,
  iconSvg,
  resolveIconPath,
  subscribeFileIcons,
} from "../lib/fileIcons";

// ---------------------------------------------------------------------------
// EntryIcon 属性定义
// ---------------------------------------------------------------------------

interface EntryIconProps {
  /** 文件名或目录名；带路径也行，内部只认最后一段。 */
  name: string;
  /** 是否目录，决定取文件夹图标还是文件图标。 */
  isDirectory?: boolean;
  /** 是否 JVM 包节点（目录链合并出的 `com.example`），用包图标而非文件夹图标。 */
  isPackage?: boolean;
  /**
   * 排除目录（IDEA 的 ExcludeRoot）。被 git 忽略、又不是点开头的目录用这枚橙色文件夹，
   * 不再按名字去取普通文件夹图标。
   */
  excluded?: boolean;
  /** 显式指定文件夹角色 (1:1 对标 openidea) */
  folderKind?: FolderKind;
  /** 绝对路径。`.java` 靠它读源码，按顶层声明换成类 / 接口 / 枚举 / 注解 / record / 异常图标。 */
  path?: string;
  /** 字节数。超过 256KB 的不读，继续用普通 Java 图标。 */
  byteSize?: number;
  size?: number;
}

/**
 * 文件 / 目录图标。图标数据懒加载，未就绪时先给一枚单色占位，
 * 数据到位后订阅回调触发重渲染，换成 IDEA 彩色图标；深浅主题各取一套 SVG。
 *
 * 铁律契约：文件图标绝对不改动（Java 类/接口/枚举/注解、pom.xml、Spring 等）；
 * 文件夹图标 1:1 对齐 openidea 的 JetBrains 官方 expui 矢量图标体系。
 */
export default function EntryIcon({
  name,
  isDirectory = false,
  isPackage = false,
  excluded = false,
  folderKind: explicitFolderKind,
  path,
  byteSize,
  size = 18,
}: EntryIconProps) {
  const ready = useSyncExternalStore(subscribeFileIcons, fileIconsReady);
  const { applied } = useSettings();
  const maven = useMavenProject();
  const className = isDirectory || isPackage ? "entry-icon is-folder" : "entry-icon";
  const baseName = name.split(/[\\/]/).pop() ?? name;
  const javaKind = useJavaFileIcon(
    isDirectory || isPackage || excluded ? undefined : path,
    baseName,
    byteSize,
  );

  useEffect(() => {
    void ensureFileIcons();
  }, []);

  if (javaKind) {
    return (
      <span
        className={className}
        style={{ width: size, height: size }}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: javaKindSvg(javaKind, applied === "dark") }}
      />
    );
  }

  // pom.xml 用侧边栏那枚 Maven 的 M，不走通用文件图标。
  if (!isDirectory && !isPackage && !excluded && baseName.toLowerCase() === "pom.xml") {
    return <MavenIcon size={size} className="entry-icon is-maven" />;
  }

  // Java（Maven）工程里的 Spring 配置：application.yml / application-dev.yaml 这一族。
  if (
    !isDirectory &&
    !isPackage &&
    !excluded &&
    maven.project &&
    /^application(?:-[^.]+)?\.ya?ml$/i.test(baseName)
  ) {
    return <SpringIcon size={size} className="entry-icon is-spring" />;
  }

  // ---------------------------------------------------------------------------
  // 文件夹与包图标分支：1:1 对齐 openidea JetBrains 官方矢量图标体系
  if (isDirectory || isPackage) {
    const kind: FolderKind =
      explicitFolderKind ?? resolveFolderKind(path, baseName, isPackage, excluded);

    // 如果是 source / test / resources / testResources / excluded / library / github / module / package
    if (kind !== "plain") {
      const svg = folderKindSvg(kind, applied === "dark");
      if (svg) {
        return (
          <span
            className={className}
            style={{ width: size, height: size }}
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        );
      }
    }

    // 常规目录 (plain)：如果 fileIcons 数据表里有特殊匹配（如 .idea 等专属图标）则优先呈现
    if (ready) {
      const svg = iconSvg(resolveIconPath(name, true, false), applied === "dark");
      if (svg) {
        return (
          <span
            className={className}
            style={{ width: size, height: size }}
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        );
      }
    }

    // 默认标准文件夹 SVG
    return (
      <span
        className={className}
        style={{ width: size, height: size }}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: folderKindSvg("plain", applied === "dark") }}
      />
    );
  }

  // ---------------------------------------------------------------------------
  // 普通文件图标分支：严格 100% 保持原有解析契约不变
  if (ready) {
    const svg = iconSvg(resolveIconPath(name, false, false), applied === "dark");
    if (svg) {
      return (
        <span
          className={className}
          style={{ width: size, height: size }}
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      );
    }
  }

  const Placeholder = File;
  return <Placeholder size={size} className={className} aria-hidden="true" />;
}
