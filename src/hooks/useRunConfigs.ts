import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  detectRuns,
  loadRunState,
  runTools,
  saveRunState,
} from "../lib/runConfigs";
import type { RunConfiguration, RunTools } from "../lib/runConfigs";
import { nativeSeparators } from "../lib/format";
import { RUN_KIND_ORDER } from "../lib/runIcons";
import { useI18n } from "../i18n";

/** 用户改过一条识别配置后剩下的那几栏。命令行这些内容不存，存了就成了改不掉的旧记录。 */
interface RunPrefs {
  selected: string;
  pinned: string[];
}

const EMPTY_TOOLS: RunTools = { maven: "", gradle: "", java: "", javaFeature: 0 };

/**
 * 运行配置这一层：有哪些可跑的、当前选哪条、钉选了哪几条。
 *
 * 与执行分开是照 IDEA：那侧是 RunManager，这侧是 ExecutionManager。会话状态在
 * `useRunSessions`，那里只管跑与不跑。
 */
export function useRunConfigs(root: string | null) {
  const { t } = useI18n();
  /** 归一成这台机器上的写法：同一工程被写成 `D:/x` 与 `D:\x` 时不该记成两份。 */
  const workspace = root ? nativeSeparators(root) : null;
  const [detected, setDetected] = useState<RunConfiguration[]>([]);
  const [custom, setCustom] = useState<RunConfiguration[]>([]);
  const [prefs, setPrefs] = useState<RunPrefs>({ selected: "", pinned: [] });
  const [tools, setTools] = useState<RunTools>(EMPTY_TOOLS);
  /** 识别过程中读不到的东西；空表不等于「这个工程没有可跑的」。 */
  const [problems, setProblems] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const customRef = useRef(custom);
  customRef.current = custom;
  /** 每次换工程或重扫都换一个序号，落盘的副作用靠它区分「这一份结果」。 */
  const generation = useRef(0);

  // 应用启动时即独立探测一次本机全局 JVM 工具（mvn/gradle/java），避免切换工作区窗口期内 tools 为空导致 NO_TOOL 误报。
  useEffect(() => {
    void runTools()
      .then((found) => setTools(found))
      .catch(() => {});
  }, []);

  const rescan = useCallback(() => {
    if (!workspace) {
      setDetected([]);
      setProblems([]);
      return;
    }
    setScanning(true);
    const generationId = ++generation.current;
    void Promise.all([detectRuns(workspace), runTools()])
      .then(([outcome, found]) => {
        if (generationId !== generation.current) return;
        setDetected(outcome.configs);
        setProblems(outcome.problems);
        setTools(found);
      })
      .catch((cause: unknown) => {
        if (generationId !== generation.current) return;
        setDetected([]);
        setProblems([cause instanceof Error ? cause.message : String(cause)]);
      })
      .finally(() => {
        if (generationId === generation.current) setScanning(false);
      });
  }, [workspace]);

  // 换工程：先清掉上一个工程的内存态，再读用户那几样决定并扫构建文件，防止异步返回前把旧工程配置写串。
  useEffect(() => {
    setDetected([]);
    setCustom([]);
    setPrefs({ selected: "", pinned: [] });
    setProblems([]);
    customRef.current = [];
    prefsRef.current = { selected: "", pinned: [] };
    if (!workspace) {
      return;
    }
    rescan();
    const generationId = generation.current;
    void loadRunState(workspace)
      .then((state) => {
        if (generationId !== generation.current) return;
        customRef.current = state.configs;
        prefsRef.current = { selected: state.selected, pinned: state.pinned };
        setCustom(state.configs);
        setPrefs({ selected: state.selected, pinned: state.pinned });
      })
      .catch(() => {
        // 读不到就当没有：配置文件坏了不该让整个运行区消失。
      });
  }, [workspace, rescan]);

  const configs = useMemo(() => {
    const pinned = new Set(prefs.pinned);
    const stamped = [...detected, ...custom].map((config) => ({
      ...config,
      pinned: pinned.has(config.id),
    }));
    // 钉选的永远在前，其余按类型分组；次序就用图标那一份权威列表，同一类型里保持识别时排好的次序。
    return stamped.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return RUN_KIND_ORDER.indexOf(a.kind) - RUN_KIND_ORDER.indexOf(b.kind);
    });
  }, [custom, detected, prefs.pinned]);

  const byId = useCallback(
    (id: string) => configs.find((config) => config.id === id) ?? null,
    [configs]
  );

  /** 当前选中的那条 id。认不出来（配置没了）就落到能用的第一条。 */
  const selected = useMemo(() => {
    const picked = byId(prefs.selected);
    if (picked) return picked;
    return configs.find((config) => !config.unavailable) ?? configs[0] ?? null;
  }, [byId, configs, prefs.selected]);

  // 用户那几样决定一改就整节写回；这一份状态小，不做增量。
  const flush = useCallback(() => {
    if (!workspace) return;
    const state = {
      configs: customRef.current,
      selected: prefsRef.current.selected,
      pinned: prefsRef.current.pinned,
    };
    void saveRunState(workspace, state).catch(() => {
      // 写不进去这轮就只在内存里生效，下一轮改动再试。
    });
  }, [workspace]);

  const select = useCallback(
    (id: string) => {
      setPrefs((current) => ({ ...current, selected: id }));
      prefsRef.current = { ...prefsRef.current, selected: id };
      flush();
    },
    [flush]
  );

  const togglePin = useCallback(
    (id: string) => {
      setPrefs((current) => {
        const pinned = current.pinned.includes(id)
          ? current.pinned.filter((item) => item !== id)
          : [...current.pinned, id];
        const next = { ...current, pinned };
        prefsRef.current = next;
        return next;
      });
      flush();
    },
    [flush]
  );

  /** 存一条用户自己的配置。已有同 id 就改它。 */
  const saveCustom = useCallback(
    (config: RunConfiguration) => {
      setCustom((list) => {
        const at = list.findIndex((item) => item.id === config.id);
        const next = at < 0 ? [...list, config] : list.map((item) => (item.id === config.id ? config : item));
        customRef.current = next;
        return next;
      });
      flush();
    },
    [flush]
  );

  const removeCustom = useCallback(
    (id: string) => {
      setCustom((list) => {
        const next = list.filter((item) => item.id !== id);
        customRef.current = next;
        return next;
      });
      flush();
    },
    [flush]
  );

  /**
   * 把一条识别出来的配置存成用户自己的那一份。
   *
   * `${mvn}` 这类占位照抄留着：它是「本机 PATH 上那个 mvn」的意思，烤成绝对路径反而一挪 JDK
   * 就废了。存成自定义之后这条就归用户了——识别结果再变也不影响它。
   */
  const saveAsCustom = useCallback(
    (config: RunConfiguration): string => {
      const copy: RunConfiguration = {
        ...config,
        id: crypto.randomUUID(),
        name: t("run.copyName", { name: config.name }),
        generated: false,
        unavailable: null,
      };
      setCustom((list) => {
        const next = [...list, copy];
        customRef.current = next;
        return next;
      });
      setPrefs((current) => {
        const next = { ...current, selected: copy.id };
        prefsRef.current = next;
        return next;
      });
      flush();
      return copy.id;
    },
    [flush, t]
  );

  return useMemo(
    () => ({
      configs,
      custom,
      detected,
      selected,
      select,
      togglePin,
      saveCustom,
      saveAsCustom,
      removeCustom,
      tools,
      problems,
      scanning,
      rescan,
      workspace,
    }),
    [
      configs,
      custom,
      detected,
      problems,
      removeCustom,
      rescan,
      saveAsCustom,
      saveCustom,
      scanning,
      select,
      selected,
      togglePin,
      tools,
      workspace,
    ]
  );
}

export type RunConfigController = ReturnType<typeof useRunConfigs>;
