import { useEffect, useSyncExternalStore } from "react";
import { File, Folder } from "lucide-react";
import { useSettings } from "../hooks/useSettings";
import {
  ensureFileIcons,
  fileIconsReady,
  iconSvg,
  resolveIconPath,
  subscribeFileIcons,
} from "../lib/fileIcons";

interface EntryIconProps {
  /** 文件名或目录名；带路径也行，内部只认最后一段。 */
  name: string;
  /** 是否目录，决定取文件夹图标还是文件图标。 */
  isDirectory?: boolean;
  /** 是否 JVM 包节点（目录链合并出的 `com.example`），用包图标而非文件夹图标。 */
  isPackage?: boolean;
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
  size = 18,
}: EntryIconProps) {
  const ready = useSyncExternalStore(subscribeFileIcons, fileIconsReady);
  const { applied } = useSettings();
  const className = isDirectory || isPackage ? "entry-icon is-folder" : "entry-icon";

  useEffect(() => {
    void ensureFileIcons();
  }, []);

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
