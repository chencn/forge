import { useEffect, useSyncExternalStore } from "react";
import { File, Folder } from "lucide-react";
import MavenIcon from "./MavenIcon";
import SpringIcon from "./SpringIcon";
import { useMavenProject } from "../hooks/useMavenProject";
import { useSettings } from "../hooks/useSettings";
import { javaKindSvg, useJavaFileIcon } from "../lib/javaKindIcons";
import { jvmSourceRootLanguage, resourcesRootKind, type JvmSourceLanguage, type ResourcesRootKind } from "../lib/jvm";
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

/** IDEA 源码根文件夹外形（sourceRoot.svg）。颜色跟对应源文件走。 */
const SOURCE_FOLDER_PATH =
  "M8.15132 4.35836L8.29689 4.5H8.5H13C13.8284 4.5 14.5 5.17157 14.5 6V12.1333C14.5 12.919 13.9104 13.5 13.25 13.5H2.75C2.08955 13.5 1.5 12.919 1.5 12.1333V3.86667C1.5 3.08099 2.08955 2.5 2.75 2.5H6.03823C6.16847 2.5 6.29357 2.55082 6.38691 2.64164L8.15132 4.35836Z";

/** java 跟类图标同色；kotlin 跟 .kt 图标同色。 */
const SOURCE_FOLDER_COLORS: Record<
  "java" | "kotlin",
  { light: [string, string]; dark: [string, string] }
> = {
  java: { light: ["#E7EFFD", "#3574F0"], dark: ["#25324D", "#548AF7"] },
  kotlin: { light: ["#FAF5FF", "#834DF0"], dark: ["#2F2936", "#A571E6"] },
};

function sourceFolderSvg(language: "java" | "kotlin", dark: boolean): string {
  const [fill, stroke] = SOURCE_FOLDER_COLORS[language][dark ? "dark" : "light"];
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="${SOURCE_FOLDER_PATH}" fill="${fill}" stroke="${stroke}"/></svg>`;
}

function sourceFolderLanguage(path: string | undefined): "java" | "kotlin" | null {
  if (!path) return null;
  const language: JvmSourceLanguage | null = jvmSourceRootLanguage(path);
  return language === "java" || language === "kotlin" ? language : null;
}

/** Lithe idea 主题的 resourcesRoot / testResourcesRoot，浅色与深色各一套。 */
const RESOURCES_ROOT_SVG: Record<ResourcesRootKind, { light: string; dark: string }> = {
  main: {
    light:
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 3.86667C1 2.83574 1.7835 2 2.75 2H6.03823C6.29871 2 6.5489 2.10163 6.73559 2.28327L8.5 4L13 4C14.1046 4 15 4.89543 15 6V9H9C8.44772 9 8 9.44772 8 10V14H2.75C1.7835 14 1 13.1643 1 12.1333V3.86667Z" fill="#EBECF0"/><path d="M8.09379 5H13C13.5523 5 14 5.44772 14 6V9H15V6C15 4.89543 14.1046 4 13 4L8.5 4L6.73559 2.28327C6.5489 2.10163 6.29871 2 6.03823 2H2.75C1.7835 2 1 2.83574 1 3.86667V12.1333C1 13.1643 1.7835 14 2.75 14H8V13H2.75C2.3956 13 2 12.6738 2 12.1333V3.86667C2 3.32624 2.3956 3 2.75 3H6.03823L8.09379 5Z" fill="#6C707E"/><rect x="9" y="10" width="7" height="1" rx="0.5" fill="#E66D17"/><rect x="9" y="12" width="7" height="1" rx="0.5" fill="#E66D17"/><rect x="9" y="14" width="7" height="1" rx="0.5" fill="#E66D17"/></svg>',
    dark:
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 3.86667C1 2.83574 1.7835 2 2.75 2H6.03823C6.29871 2 6.5489 2.10163 6.73559 2.28327L8.5 4L13 4C14.1046 4 15 4.89543 15 6V9H9C8.44772 9 8 9.44772 8 10V14H2.75C1.7835 14 1 13.1643 1 12.1333V3.86667Z" fill="#43454A"/><path d="M8.09379 5H13C13.5523 5 14 5.44772 14 6V9H15V6C15 4.89543 14.1046 4 13 4L8.5 4L6.73559 2.28327C6.5489 2.10163 6.29871 2 6.03823 2H2.75C1.7835 2 1 2.83574 1 3.86667V12.1333C1 13.1643 1.7835 14 2.75 14H8V13H2.75C2.3956 13 2 12.6738 2 12.1333V3.86667C2 3.32624 2.3956 3 2.75 3H6.03823L8.09379 5Z" fill="#CED0D6"/><rect x="9" y="10" width="7" height="1" rx="0.5" fill="#F2C55C"/><rect x="9" y="12" width="7" height="1" rx="0.5" fill="#F2C55C"/><rect x="9" y="14" width="7" height="1" rx="0.5" fill="#F2C55C"/></svg>',
  },
  test: {
    light:
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2.75 2C1.7835 2 1 2.83574 1 3.86667V10.9616L2.6284 9.39554C3.1899 8.85552 3.98741 8.90755 4.49904 9.33004C5.01043 8.90704 5.80814 8.85449 6.37001 9.39427L8.07452 11.0318C8.2712 10.4326 8.83507 10 9.5 10H15V6C15 4.89543 14.1046 4 13 4L8.5 4L6.73559 2.28327C6.5489 2.10163 6.29871 2 6.03823 2H2.75Z" fill="#F2FCF3"/><path fill-rule="evenodd" clip-rule="evenodd" d="M8.37978 12.7117C8.54354 12.8691 8.54362 13.131 8.37994 13.2884L5.67736 15.8876C5.4232 16.132 5 15.9519 5 15.5993L5.00002 10.4038C5.00002 10.0513 5.423 9.87118 5.67722 10.1154L8.37978 12.7117Z" fill="#55A76A"/><path fill-rule="evenodd" clip-rule="evenodd" d="M0.622553 13.2883C0.459087 13.1309 0.459159 12.8692 0.622712 12.7119L3.32158 10.1163C3.57574 9.87185 3.99894 10.0519 3.99894 10.4045V15.5986C3.99894 15.9514 3.57553 16.1314 3.32142 15.8868L0.622553 13.2883Z" fill="#E55765"/><path fill-rule="evenodd" clip-rule="evenodd" d="M9 11.5C9 11.2239 9.22386 11 9.5 11H15.5C15.7761 11 16 11.2239 16 11.5C16 11.7761 15.7761 12 15.5 12H9.5C9.22386 12 9 11.7761 9 11.5ZM9 13.5C9 13.2239 9.22386 13 9.5 13H15.5C15.7761 13 16 13.2239 16 13.5C16 13.7761 15.7761 14 15.5 14H9.5C9.22386 14 9 13.7761 9 13.5ZM9 15.5C9 15.2239 9.22386 15 9.5 15H15.5C15.7761 15 16 15.2239 16 15.5C16 15.7761 15.7761 16 15.5 16H9.5C9.22386 16 9 15.7761 9 15.5Z" fill="#E66D17"/><path d="M8.09379 5H13C13.5523 5 14 5.44772 14 6V10H15V6C15 4.89543 14.1046 4 13 4L8.5 4L6.73559 2.28327C6.5489 2.10163 6.29871 2 6.03823 2H2.75C1.7835 2 1 2.83574 1 3.86667V10.9616L2 9.99989V3.86667C2 3.32624 2.3956 3 2.75 3H6.03823L8.09379 5Z" fill="#208A3C"/></svg>',
    dark:
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2.75 2C1.7835 2 1 2.83574 1 3.86667V10.9616L2.6284 9.39554C3.1899 8.85552 3.98741 8.90755 4.49904 9.33004C5.01043 8.90704 5.80814 8.85449 6.37001 9.39427L8.07452 11.0318C8.2712 10.4326 8.83507 10 9.5 10H15V6C15 4.89543 14.1046 4 13 4L8.5 4L6.73559 2.28327C6.5489 2.10163 6.29871 2 6.03823 2H2.75Z" fill="#253627"/><path fill-rule="evenodd" clip-rule="evenodd" d="M8.37978 12.7117C8.54354 12.8691 8.54362 13.131 8.37994 13.2884L5.67736 15.8876C5.4232 16.132 5 15.9519 5 15.5993L5.00002 10.4038C5.00002 10.0513 5.423 9.87118 5.67722 10.1154L8.37978 12.7117Z" fill="#57965C"/><path fill-rule="evenodd" clip-rule="evenodd" d="M0.622553 13.2883C0.459087 13.1309 0.459159 12.8692 0.622712 12.7119L3.32158 10.1163C3.57574 9.87185 3.99894 10.0519 3.99894 10.4045V15.5986C3.99894 15.9514 3.57553 16.1314 3.32142 15.8868L0.622553 13.2883Z" fill="#DB5C5C"/><path fill-rule="evenodd" clip-rule="evenodd" d="M9 11.5C9 11.2239 9.22386 11 9.5 11H15.5C15.7761 11 16 11.2239 16 11.5C16 11.7761 15.7761 12 15.5 12H9.5C9.22386 12 9 11.7761 9 11.5ZM9 13.5C9 13.2239 9.22386 13 9.5 13H15.5C15.7761 13 16 13.2239 16 13.5C16 13.7761 15.7761 14 15.5 14H9.5C9.22386 14 9 13.7761 9 13.5ZM9 15.5C9 15.2239 9.22386 15 9.5 15H15.5C15.7761 15 16 15.2239 16 15.5C16 15.7761 15.7761 16 15.5 16H9.5C9.22386 16 9 15.7761 9 15.5Z" fill="#F2C55C"/><path d="M8.09379 5H13C13.5523 5 14 5.44772 14 6V10H15V6C15 4.89543 14.1046 4 13 4L8.5 4L6.73559 2.28327C6.5489 2.10163 6.29871 2 6.03823 2H2.75C1.7835 2 1 2.83574 1 3.86667V10.9616L2 9.99989V3.86667C2 3.32624 2.3956 3 2.75 3H6.03823L8.09379 5Z" fill="#57965C"/></svg>',
  },
};

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

  const sourceLanguage =
    isDirectory && !isPackage && !excluded ? sourceFolderLanguage(path) : null;
  if (sourceLanguage) {
    return (
      <span
        className={className}
        style={{ width: size, height: size }}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: sourceFolderSvg(sourceLanguage, applied === "dark") }}
      />
    );
  }

  const resourcesKind = isDirectory && !isPackage && !excluded && path ? resourcesRootKind(path) : null;
  if (resourcesKind) {
    const svg = RESOURCES_ROOT_SVG[resourcesKind][applied === "dark" ? "dark" : "light"];
    return (
      <span
        className={className}
        style={{ width: size, height: size }}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
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
