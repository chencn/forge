/** 项目目录的用户标记；路径按项目根保存，避免把机器绝对路径写进项目角色表。 */
export type ProjectDirectoryRole = "source" | "test" | "resources" | "testResources" | "excluded";

export type ProjectDirectoryRoles = Record<string, Record<string, ProjectDirectoryRole>>;

/** Windows 大小写与分隔符不可靠，设置键统一成稳定的小写正斜杠路径。 */
export function projectPathKey(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

/** 返回项目内相对路径；项目根自身用空串，越界路径返回 null。 */
export function projectRelativePath(root: string, path: string): string | null {
  const rootKey = projectPathKey(root);
  const pathKey = projectPathKey(path);
  if (pathKey === rootKey) return "";
  if (!pathKey.startsWith(`${rootKey}/`)) return null;
  const rawRoot = root.replaceAll("\\", "/").replace(/\/+$/u, "");
  const rawPath = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  return rawPath.slice(rawRoot.length + 1);
}

function relativePathKey(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "").toLowerCase();
}

export function roleAtPath(
  root: string,
  path: string,
  roles: Record<string, ProjectDirectoryRole> | undefined
): ProjectDirectoryRole | null {
  const relative = projectRelativePath(root, path);
  return relative === null ? null : roles?.[relativePathKey(relative)] ?? null;
}

/** 纯函数更新角色，便于 UI 持久化前先得到完整的新值，也避免留下空项目记录。 */
export function setProjectDirectoryRole(
  allRoles: ProjectDirectoryRoles,
  root: string,
  path: string,
  role: ProjectDirectoryRole | null
): ProjectDirectoryRoles {
  const relative = projectRelativePath(root, path);
  if (relative === null) return allRoles;
  const rootKey = projectPathKey(root);
  const nextForRoot = { ...(allRoles[rootKey] ?? {}) };
  const relativeKey = relativePathKey(relative);
  if (role) nextForRoot[relativeKey] = role;
  else delete nextForRoot[relativeKey];
  const next = { ...allRoles };
  if (Object.keys(nextForRoot).length === 0) delete next[rootKey];
  else next[rootKey] = nextForRoot;
  return next;
}

const VALID_ROLES: readonly ProjectDirectoryRole[] = ["source", "test", "resources", "testResources", "excluded"];

/** 读取旧/损坏设置时只保留可识别的项目目录角色。 */
export function normalizeProjectDirectoryRoles(raw: unknown): ProjectDirectoryRoles {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ProjectDirectoryRoles = {};
  for (const [root, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entries: Record<string, ProjectDirectoryRole> = {};
    for (const [relative, role] of Object.entries(value)) {
      if (typeof role === "string" && VALID_ROLES.includes(role as ProjectDirectoryRole)) {
        entries[relativePathKey(relative)] = role as ProjectDirectoryRole;
      }
    }
    if (Object.keys(entries).length > 0) out[projectPathKey(root)] = entries;
  }
  return out;
}
