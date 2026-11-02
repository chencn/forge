import { useMemo, type ReactNode } from "react";
import { ChevronRight, File, Folder } from "lucide-react";
import "./ai-elements.css";

interface FileTreeEntry { path: string; content: ReactNode }
interface Branch { name: string; folders: Map<string, Branch>; files: FileTreeEntry[] }

/** Adapted from https://ui.shadcn.com/docs/ai-elements/base/file-tree (MIT).
 * Directory disclosure uses native keyboard-accessible details; leaves retain their real actions.
 */
export function FileTree({ files, label }: { files: FileTreeEntry[]; label: string }) {
  const root = useMemo(() => {
    const root: Branch = { name: "", folders: new Map(), files: [] };
    for (const file of files) {
      const parts = file.path.replace(/\\/g, "/").split("/").filter(Boolean);
      let parent = root;
      for (const part of parts.slice(0, -1)) {
        if (!parent.folders.has(part)) parent.folders.set(part, { name: part, folders: new Map(), files: [] });
        parent = parent.folders.get(part)!;
      }
      parent.files.push(file);
    }
    return root;
  }, [files]);
  const render = (branch: Branch): ReactNode => <ul>
    {[...branch.folders.values()].map((folder) => <li key={`dir:${folder.name}`}><details open>
      <summary><ChevronRight size={12} aria-hidden /><Folder size={13} aria-hidden /><span>{folder.name}</span></summary>
      {render(folder)}
    </details></li>)}
    {branch.files.map((file) => <li key={`file:${file.path}`} className="ai-element-file"><File size={13} aria-hidden />{file.content}</li>)}
  </ul>;
  return <nav data-slot="file-tree" className="ai-element-files" aria-label={label}>{render(root)}</nav>;
}
