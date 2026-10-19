import { useCallback, useEffect, useSyncExternalStore } from "react";
import { readFile } from "./fs";
import { detectJavaFileIconKind, type JavaFileIconKind } from "./javaFileKind";

/** IDEA expui/nodes 那六枚，浅色 / 深色。来自 Lithe 的 idea 图标主题。 */
const LIGHT: Record<JavaFileIconKind, string> = {
  "java.class":
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#E7EFFD" stroke="#3574F0"/><path d="M8.13295 11.5C9.61223 11.5 10.8836 10.6105 11.2075 9.33909H10.2213C9.90229 10.0739 9.11914 10.6057 8.13295 10.6057C6.77936 10.6057 5.80284 9.51796 5.80284 8C5.80284 6.48204 6.77936 5.39434 8.13295 5.39434C9.11914 5.39434 9.90229 5.92611 10.2213 6.66091H11.2075C10.8836 5.3895 9.61223 4.5 8.13295 4.5C6.21859 4.5 4.79248 5.99378 4.79248 8C4.79248 10.0062 6.21859 11.5 8.13295 11.5Z" fill="#3574F0"/></svg>',
  "java.interface":
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#F2FCF3" stroke="#208A3C"/><path fill-rule="evenodd" clip-rule="evenodd" d="M10 4.5V5.5L8.5 5.5V10.5H10V11.5L8.5 11.5H7.5L6 11.5V10.5H7.5V5.5L6 5.5V4.5H7.5H8.5H10Z" fill="#208A3C"/></svg>',
  "java.enum":
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#FAF5FF" stroke="#834DF0"/><path d="M5.49023 11.5H10.5102V10.585H6.48023V8.435H10.0702V7.515H6.48023V5.415H10.4102V4.5H5.49023V11.5Z" fill="#834DF0"/></svg>',
  "java.annotation":
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="7" fill="#F2FCF3"/><path d="M9.72989 5.38506V6.35862H9.70012C9.35494 5.69 8.71609 5.3046 7.87126 5.3046C6.38276 5.3046 5.26437 6.47931 5.26437 8.04023C5.26437 9.60115 6.38276 10.7759 7.87126 10.7759C8.81103 10.7759 9.58828 10.339 10.0026 9.65425C10.442 10.3357 11.2602 10.7517 12.2885 10.7517C13.9218 10.7517 15 9.60115 15 7.91954C15 4.11379 11.854 1 8 1C4.14598 1 1 4.18621 1 8.08046C1 11.8862 4.14598 15 8 15C9.85057 15 11.5161 14.2356 12.4333 13.4069L11.7092 12.6103C10.8966 13.3345 9.5931 13.9943 8 13.9943C4.70115 13.9943 2.00575 11.331 2.00575 8.08046C2.00575 4.74138 4.70115 2.00575 8 2.00575C11.2989 2.00575 13.9943 4.66897 13.9943 7.91954C13.9943 9.02989 13.3264 9.78621 12.2885 9.78621C11.3471 9.78621 10.6552 9.1908 10.6552 8.32184V5.38506H9.72989ZM7.95977 9.8908C6.99425 9.8908 6.27011 9.09425 6.27011 8.04023C6.27011 6.98621 6.99425 6.18966 7.95977 6.18966C8.92529 6.18966 9.64943 6.98621 9.64943 8.04023C9.64943 9.09425 8.92529 9.8908 7.95977 9.8908Z" fill="#208A3C"/></svg>',
  "java.record":
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#E7EFFD" stroke="#3574F0"/><path d="M7.92995 8.405H9.02495L10.925 11.5H9.77495L7.92995 8.405ZM5.69995 4.5H8.58495C9.04828 4.5 9.45328 4.58667 9.79995 4.76C10.15 4.93 10.42 5.17167 10.61 5.485C10.8 5.795 10.895 6.15833 10.895 6.575C10.895 6.98833 10.7983 7.35333 10.605 7.67C10.4116 7.98667 10.1383 8.23167 9.78495 8.405C9.43162 8.575 9.01828 8.66 8.54495 8.66H6.69995V11.5H5.69995V4.5ZM8.55995 7.77C8.81995 7.77 9.04662 7.72167 9.23995 7.625C9.43328 7.52833 9.58328 7.39 9.68995 7.21C9.79662 7.03 9.84995 6.81833 9.84995 6.575C9.84995 6.335 9.79662 6.12667 9.68995 5.95C9.58328 5.77 9.43328 5.63167 9.23995 5.535C9.04662 5.43833 8.81995 5.39 8.55995 5.39H6.69995V7.77H8.55995Z" fill="#3574F0"/></svg>',
  "java.exception":
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#FFFAEB" stroke="#C27D04"/><path d="M9 4.5L6 8H10L7 11.5" stroke="#C27D04" stroke-linecap="round"/></svg>',
};

const DARK: Record<JavaFileIconKind, string> = {
  "java.class":
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#25324D" stroke="#548AF7"/><path d="M8.13295 11.5C9.61223 11.5 10.8836 10.6105 11.2075 9.33909H10.2213C9.90229 10.0739 9.11914 10.6057 8.13295 10.6057C6.77936 10.6057 5.80284 9.51796 5.80284 8C5.80284 6.48204 6.77936 5.39434 8.13295 5.39434C9.11914 5.39434 9.90229 5.92611 10.2213 6.66091H11.2075C10.8836 5.3895 9.61223 4.5 8.13295 4.5C6.21859 4.5 4.79248 5.99378 4.79248 8C4.79248 10.0062 6.21859 11.5 8.13295 11.5Z" fill="#548AF7"/></svg>',
  "java.interface":
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#253627" stroke="#57965C"/><path fill-rule="evenodd" clip-rule="evenodd" d="M10 4.5V5.5L8.5 5.5V10.5H10V11.5L8.5 11.5H7.5L6 11.5V10.5H7.5V5.5L6 5.5V4.5H7.5H8.5H10Z" fill="#57965C"/></svg>',
  "java.enum":
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#2F2936" stroke="#A571E6"/><path d="M5.49023 11.5H10.5102V10.585H6.48023V8.435H10.0702V7.515H6.48023V5.415H10.4102V4.5H5.49023V11.5Z" fill="#A571E6"/></svg>',
  "java.annotation":
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="7" fill="#253627"/><path d="M9.72989 5.38506V6.35862H9.70012C9.35494 5.69 8.71609 5.3046 7.87126 5.3046C6.38276 5.3046 5.26437 6.47931 5.26437 8.04023C5.26437 9.60115 6.38276 10.7759 7.87126 10.7759C8.81103 10.7759 9.58828 10.339 10.0026 9.65425C10.442 10.3357 11.2602 10.7517 12.2885 10.7517C13.9218 10.7517 15 9.60115 15 7.91954C15 4.11379 11.854 1 8 1C4.14598 1 1 4.18621 1 8.08046C1 11.8862 4.14598 15 8 15C9.85057 15 11.5161 14.2356 12.4333 13.4069L11.7092 12.6103C10.8966 13.3345 9.5931 13.9943 8 13.9943C4.70115 13.9943 2.00575 11.331 2.00575 8.08046C2.00575 4.74138 4.70115 2.00575 8 2.00575C11.2989 2.00575 13.9943 4.66897 13.9943 7.91954C13.9943 9.02989 13.3264 9.78621 12.2885 9.78621C11.3471 9.78621 10.6552 9.1908 10.6552 8.32184V5.38506H9.72989ZM7.95977 9.8908C6.99425 9.8908 6.27011 9.09425 6.27011 8.04023C6.27011 6.98621 6.99425 6.18966 7.95977 6.18966C8.92529 6.18966 9.64943 6.98621 9.64943 8.04023C9.64943 9.09425 8.92529 9.8908 7.95977 9.8908Z" fill="#57965C"/></svg>',
  "java.record":
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#25324D" stroke="#548AF7"/><path d="M7.92995 8.405H9.02495L10.925 11.5H9.77495L7.92995 8.405ZM5.69995 4.5H8.58495C9.04828 4.5 9.45328 4.58667 9.79995 4.76C10.15 4.93 10.42 5.17167 10.61 5.485C10.8 5.795 10.895 6.15833 10.895 6.575C10.895 6.98833 10.7983 7.35333 10.605 7.67C10.4116 7.98667 10.1383 8.23167 9.78495 8.405C9.43162 8.575 9.01828 8.66 8.54495 8.66H6.69995V11.5H5.69995V4.5ZM8.55995 7.77C8.81995 7.77 9.04662 7.72167 9.23995 7.625C9.43328 7.52833 9.58328 7.39 9.68995 7.21C9.79662 7.03 9.84995 6.81833 9.84995 6.575C9.84995 6.335 9.79662 6.12667 9.68995 5.95C9.58328 5.77 9.43328 5.63167 9.23995 5.535C9.04662 5.43833 8.81995 5.39 8.55995 5.39H6.69995V7.77H8.55995Z" fill="#548AF7"/></svg>',
  "java.exception":
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6.5" fill="#3D3223" stroke="#D6AE58"/><path d="M9 4.5L6 8H10L7 11.5" stroke="#D6AE58" stroke-linecap="round"/></svg>',
};

const MAX_BYTES = 256 * 1024;
const MAX_CONCURRENT = 4;

const cache = new Map<string, JavaFileIconKind | null>();
const subscribers = new Map<string, Set<() => void>>();
const queued = new Set<string>();
const pending: Array<{ path: string; fileName: string }> = [];
let active = 0;

function notify(path: string) {
  for (const callback of subscribers.get(path) ?? []) callback();
}

/** 构建产物里的 .java 不读，和 Lithe 一样。 */
export function isJavaIconPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const local = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/");
  if (!local || normalized.startsWith("//")) return false;
  return !normalized
    .toLowerCase()
    .split("/")
    .some((segment) =>
      ["target", "build", "out", "generated", "generated-sources"].includes(segment),
    );
}

export function javaKindSvg(kind: JavaFileIconKind, dark: boolean): string {
  return (dark ? DARK : LIGHT)[kind];
}

/** 磁盘上的 .java 变了就丢掉缓存，下次画的时候再读。 */
export function invalidateJavaIcons(paths: string[]) {
  for (const path of paths) {
    if (!path.toLowerCase().endsWith(".java")) continue;
    if (!cache.delete(path)) continue;
    notify(path);
  }
}

function pump() {
  while (active < MAX_CONCURRENT && pending.length > 0) {
    const job = pending.shift();
    if (!job) return;
    active += 1;
    void readFile(job.path)
      .then((file) => {
        const kind =
          file.size > MAX_BYTES || file.contents.length > MAX_BYTES
            ? null
            : detectJavaFileIconKind(job.fileName, file.contents);
        cache.set(job.path, kind);
      })
      .catch(() => {
        cache.set(job.path, null);
      })
      .finally(() => {
        active -= 1;
        queued.delete(job.path);
        notify(job.path);
        pump();
      });
  }
}

function queue(path: string, fileName: string, byteSize?: number) {
  if (cache.has(path) || queued.has(path) || !isJavaIconPath(path)) return;
  if (byteSize !== undefined && byteSize > MAX_BYTES) {
    cache.set(path, null);
    notify(path);
    return;
  }
  queued.add(path);
  pending.push({ path, fileName });
  pump();
}

export function useJavaFileIcon(
  path: string | undefined,
  fileName: string,
  byteSize?: number,
): JavaFileIconKind | null {
  const enabled = Boolean(path && fileName.toLowerCase().endsWith(".java") && isJavaIconPath(path));
  const subscribe = useCallback(
    (callback: () => void) => {
      if (!enabled || !path) return () => undefined;
      const set = subscribers.get(path) ?? new Set();
      set.add(callback);
      subscribers.set(path, set);
      return () => {
        set.delete(callback);
        if (set.size === 0) subscribers.delete(path);
      };
    },
    [enabled, path],
  );
  const kind = useSyncExternalStore(
    subscribe,
    () => (enabled && path ? cache.get(path) : undefined),
    () => undefined,
  );

  useEffect(() => {
    if (!enabled || !path || cache.has(path)) return;
    queue(path, fileName, byteSize);
  }, [byteSize, enabled, fileName, kind, path]);

  return kind ?? null;
}
