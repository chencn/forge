import { useEffect, useSyncExternalStore } from "react";
import { File, Folder } from "lucide-react";
import MavenIcon from "./MavenIcon";
import SpringIcon from "./SpringIcon";
import { useMavenProject } from "../hooks/useMavenProject";
import { useSettings } from "../hooks/useSettings";
import { javaKindSvg, useJavaFileIcon } from "../lib/javaKindIcons";
import {
  ensureFileIcons,
  fileIconsReady,
  iconSvg,
  resolveIconPath,
  subscribeFileIcons,
} from "../lib/fileIcons";

/** IDEA 的排除目录图标（expui/nodes/excludeRoot.svg），浅色：奶油底、橙色描边。 */
const EXCLUDE_ROOT_LIGHT =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8.15132 4.35836L8.29689 4.5H8.5H13C13.8284 4.5 14.5 5.17157 14.5 6V12.1333C14.5 12.919 13.9104 13.5 13.25 13.5H2.75C2.08955 13.5 1.5 12.919 1.5 12.1333V3.86667C1.5 3.08099 2.08955 2.5 2.75 2.5H6.03823C6.16847 2.5 6.29357 2.55082 6.38691 2.64164L8.15132 4.35836Z" fill="#FCE9D9" stroke="#F28C35"/></svg>';

/** 同一枚图标的深色档（excludeRoot_dark.svg）。 */
const EXCLUDE_ROOT_DARK =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8.15132 4.35836L8.29689 4.5H8.5H13C13.8284 4.5 14.5 5.17157 14.5 6V12.1333C14.5 12.919 13.9104 13.5 13.25 13.5H2.75C2.08955 13.5 1.5 12.919 1.5 12.1333V3.86667C1.5 3.08099 2.08955 2.5 2.75 2.5H6.03823C6.16847 2.5 6.29357 2.55082 6.38691 2.64164L8.15132 4.35836Z" fill="#45322B" stroke="#C77D55"/></svg>';

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
 * 只按名字、「是不是目录」「是不是包」工作，不绑定 FsEntry：资源管理器手里有完整条目，
 * Git 的变更树 / 日志文件树只有路径，两边都往这里喂名字，图标才是一致的。
 */
export default function EntryIcon({
  name,
  isDirectory = false,
  isPackage = false,
  excluded = false,
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

  if (excluded) {
    return (
      <span
        className={className}
        style={{ width: size, height: size }}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: applied === "dark" ? EXCLUDE_ROOT_DARK : EXCLUDE_ROOT_LIGHT }}
      />
    );
  }

  if (ready) {
    const svg = iconSvg(resolveIconPath(name, isDirectory, isPackage), applied === "dark");
    if (svg) {
      // 图标是本仓库生成的可信静态资源，直接注入；<span> 承载尺寸，SVG 撑满。
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

  const Placeholder = isDirectory ? Folder : File;
  return <Placeholder size={size} className={className} aria-hidden="true" />;
}
