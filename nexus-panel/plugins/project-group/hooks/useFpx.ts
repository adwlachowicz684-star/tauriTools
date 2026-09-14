import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNexus } from '../../../src/nexus-react';
import { errText, makeApi, normalizeKey } from '../api';
import type {
  Bootstrap, CardKind, ContentItem, FpxConfig, LinkRow, Snapshot, TabInfo,
} from '../types';

export interface LogLine {
  at: string;
  text: string;
  isError: boolean;
}

const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

export function useFpx() {
  const ctx = useNexus();
  const api = useMemo(() => makeApi(ctx), [ctx]);

  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [content, setContent] = useState<ContentItem[]>([]);
  const [contentKind, setContentKind] = useState<'all' | 'agent' | 'skill' | 'rule'>('all');

  const [selProject, setSelProject] = useState<string | null>(null);
  const [selGroup, setSelGroup] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Record<CardKind, number>>({ project: 0, group: 0 });

  // 插件被 reload() 时组件会卸载再挂载，alive 必须重新置 true，否则新实例里所有 setBusy 都被吞掉
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const pushLog = useCallback((text: string, isError = false) => {
    setLog((l) => [{ at: now(), text, isError }, ...l].slice(0, 200));
  }, []);

  /* ---------------- 活动页签记忆 ----------------
   * 存 ctx.store（localStorage）而不是 config.json：
   * 这是 UI 会话状态，不是业务数据——MCP server / 备份 / 目录监听三个后台线程
   * 都不关心"上次停在哪一栏"。放 config.json 的话每切一次页签都要写文件、
   * 回传全量快照、重渲染整个界面；放 store 是零 IO、零重渲染。
   * 代价是清浏览器数据会丢，但那只是个"上次在哪"的偏好，丢了无所谓。
   */
  const TAB_KEY = 'activeTab';
  /** 恢复完成前不写回：否则初始的 {0,0} 会先把持久化的位置冲掉 */
  const tabReady = useRef(false);
  const lastSavedTab = useRef('');

  useEffect(() => {
    if (!boot || tabReady.current) return;
    // 页签数可能因删除而变少，必须 clamp，否则恢复出的序号越界
    const clamp = (i: number, n: number) => Math.min(Math.max(0, i), Math.max(0, n - 1));
    void (async () => {
      const saved = await ctx.store
        .get<Record<CardKind, number> | null>(TAB_KEY, null)
        .catch(() => null);
      const p = clamp(saved?.project ?? 0, boot.projectTabs?.length ?? 1);
      const g = clamp(saved?.group ?? 0, boot.groupTabs?.length ?? 1);
      lastSavedTab.current = `${p}|${g}`;
      tabReady.current = true;
      if (!alive.current) return;
      // 用户在恢复完成前已经手动切过页签，就不要再覆盖他的操作
      setActiveTab((prev) =>
        prev.project === 0 && prev.group === 0 ? { project: p, group: g } : prev);
    })();
  }, [boot, ctx]);

  useEffect(() => {
    if (!boot || !tabReady.current) return;
    const key = `${activeTab.project}|${activeTab.group}`;
    if (key === lastSavedTab.current) return;
    lastSavedTab.current = key;
    // 只写 store，不回写 config：不触发快照往返，界面不会闪
    void ctx.store.set(TAB_KEY, activeTab).catch(() => {});
  }, [boot, activeTab, ctx]);

  /** 统一套一层：出错记日志 + toast，不再到处 try/catch */
  const run = useCallback(async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    try {
      const r = await fn();
      return r;
    } catch (e) {
      const msg = `${label}失败：${errText(e)}`;
      pushLog(msg, true);
      ctx.toast(msg, 'err');
      return null;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [ctx, pushLog]);

  /** 最新的配置副本，供 updateConfig 作为连续保存的基准（见 updateConfig 注释）。 */
  const configRef = useRef<FpxConfig | null>(null);

  /**
   * 把后端返回的快照并回界面，同时**立刻**同步 configRef。
   *
   * 早期版本只 setBoot，configRef 交给下面那个 [boot] 的 effect 去补。
   * 但 effect 要等到本次渲染提交后才跑，中间有一整段窗口：
   * createLink / setIcon / setLock 这类「applySnapshot 但不走 updateConfig」的调用
   * 之后若紧接着来一次 updateConfig，它读到的 configRef 还是上一次的旧草稿，
   * 于是把刚落盘的快照整份盖掉。同步写死在这里就不存在这个窗口。
   * 下面的 effect 仍保留：refresh() 等只 setBoot 的路径还得靠它兜。
   */
  const applySnapshot = useCallback((snap: Snapshot) => {
    configRef.current = snap.config;
    setBoot((b) => (b ? { ...b, ...snap } : b));
  }, []);

  useEffect(() => {
    if (boot) configRef.current = boot.config;
  }, [boot]);



  const refresh = useCallback(async () => {
    const b = await run('加载', () => api.bootstrap());
    if (b && alive.current) setBoot(b);
    if (alive.current) setLoading(false);
    return b;
  }, [api, run]);

  useEffect(() => { refresh(); }, [refresh]);

  /* ---------------- 配置读写 ---------------- */

  /** 改配置并落盘（mutate 里直接改 draft） */
  /**
   * 保存配置：基于最新草稿改一份发出去。
   *
   * 用 ref 而不是闭包里的 boot 作为基准，是因为连续操作会互相覆盖：
   * 用户快速添加两张卡片（或连点两次保存），第二次调用时 React 还没把第一次的
   * 快照刷进 boot，闭包里仍是旧 config，于是第二份草稿里没有第一次的改动，
   * 保存后直接把第一次的结果抹掉。ref 在每次改动后立刻更新，能串起连续操作。
   */
  const updateConfig = useCallback(async (mutate: (draft: FpxConfig) => void) => {
    const base = configRef.current ?? boot?.config;
    if (!base) return null;
    const draft: FpxConfig = JSON.parse(JSON.stringify(base));
    mutate(draft);

    const prev = configRef.current;
    configRef.current = draft;          // 乐观推进：让紧随其后的调用看到这次的改动
    const snap = await run('保存配置', () => api.saveConfig(draft));
    if (snap) {
      configRef.current = snap.config;  // 以后端返回的为准（后端可能补过字段）
      applySnapshot(snap);
    } else if (configRef.current === draft) {
      // 只在「期间没人再推进过」时才回滚。
      // 两次保存在飞是常态：先发的那次若最后才失败（昂贵的写先返回错误、
      // 便宜的后发先成功都有可能），无条件回滚会把后一次已经落盘的结果
      // 从 configRef 里抹掉，下一次保存便整份覆盖回去。
      configRef.current = prev;         // 失败回滚，别让本地继续错下去
    }
    return snap;
  }, [api, applySnapshot, boot, run]);

  const cardsOf = useCallback((kind: CardKind): TabInfo[] =>
    (kind === 'project' ? boot?.projectTabs : boot?.groupTabs) ?? [], [boot]);

  /* ---------------- 卡片 / 页签 ---------------- */

  const addCard = useCallback(async (kind: CardKind, path: string) => {
    const list = cardsOf(kind);
    const idx = activeTab[kind];
    if (list[idx]?.items.some((c) => c.path === path)) {
      ctx.toast('该文件夹已在当前页签中', 'err');
      return;
    }
    await updateConfig((d) => {
      const tabs = kind === 'project' ? d.projectTabs : d.groupTabs;
      while (tabs.length <= idx) tabs.push({ name: `页签${tabs.length + 1}`, items: [] });
      tabs[idx].items.push(path);
    });
    pushLog(`已添加${kind === 'project' ? '项目' : '项目组'}：${path}`);
    // 拖入后是否自动选中由设置项决定（原版 autoSelect 的语义）
    if (boot?.config.autoSelect ?? true) {
      if (kind === 'project') setSelProject(path); else setSelGroup(path);
    }
  }, [activeTab, boot?.config.autoSelect, cardsOf, ctx, pushLog, updateConfig]);

  /**
   * 从页签移除卡片。
   * 只动当前页签——卡片是按页签分别登记的，同一路径可以存在于多个页签，
   * 全表删除会连带清掉用户在别的页签里的登记。
   */
  const removeCard = useCallback(async (kind: CardKind, path: string) => {
    const idx = activeTab[kind];
    await updateConfig((d) => {
      const tabs = kind === 'project' ? d.projectTabs : d.groupTabs;
      if (tabs[idx]) tabs[idx].items = tabs[idx].items.filter((p) => p !== path);
    });
    pushLog(`已从页签移除：${path}`);
  }, [activeTab, pushLog, updateConfig]);

  /**
   * 同栏内排序 / 跨页签移动。
   *
   * 目标页签索引必须 clamp：movecard 会先把自己从所有页签里摘掉再插入目标页签，
   * 若 toTabIndex 超出当前页签数，原来的写法会一路补空页签直到该下标，
   * 卡片被塞进一个凭空新建的空白页签里 —— 用户看到的就是"卡片消失了"。
   * 索引来源（activeTab）存在 localStorage 里，与当前快照偶有不同步，故在后端兜底。
   */
  const moveCard = useCallback(async (
    kind: CardKind, path: string, toTabIndex: number, toIndex: number,
  ) => {
    await updateConfig((d) => {
      const tabs = kind === 'project' ? d.projectTabs : d.groupTabs;
      // 掐头去尾：先把目标位置定在合法范围内，再摘卡（摘卡不影响页签数）
      const maxTab = Math.max(0, tabs.length - 1);
      const tab = Math.max(0, Math.min(toTabIndex, maxTab));
      for (const t of tabs) t.items = t.items.filter((p) => p !== path);
      const target = tabs[tab];
      const i = Math.max(0, Math.min(toIndex, target.items.length));
      target.items.splice(i, 0, path);
    });
  }, [updateConfig]);

  /**
   * 跨类别移动卡片（项目 ⇄ 项目组）。
   * 可能触发物理搬家，失败时后端整体中止并报错，这里只是转达。
   */
  const moveCardAcross = useCallback(async (fromKind: CardKind, path: string, dstTabIndex?: number) => {
    const dstKind: CardKind = fromKind === 'project' ? 'group' : 'project';
    const r = await run(`转为${dstKind === 'group' ? '项目组' : '项目'}`, () =>
      api.moveCardAcross(fromKind, path, dstKind, dstTabIndex));
    if (!r) return;
    applySnapshot(r.snapshot);
    pushLog(r.relocated
      ? `已转为${dstKind === 'group' ? '项目组' : '项目'}，文件夹已移动到：${r.relocated}`
      : `已转为${dstKind === 'group' ? '项目组' : '项目'}（文件夹未移动）`);
  }, [api, applySnapshot, pushLog, run]);

  const addTab = useCallback(async (kind: CardKind, name: string) => {
    await updateConfig((d) => {
      const tabs = kind === 'project' ? d.projectTabs : d.groupTabs;
      tabs.push({ name: name.trim() || `页签${tabs.length + 1}`, items: [] });
    });
    setActiveTab((s) => ({ ...s, [kind]: cardsOf(kind).length }));
  }, [cardsOf, updateConfig]);

  const renameTab = useCallback(async (kind: CardKind, index: number, name: string) => {
    await updateConfig((d) => {
      const tabs = kind === 'project' ? d.projectTabs : d.groupTabs;
      if (tabs[index]) tabs[index].name = name.trim() || tabs[index].name;
    });
  }, [updateConfig]);

  const removeTab = useCallback(async (kind: CardKind, index: number) => {
    const before = cardsOf(kind).length;
    if (before <= 1) {
      ctx.toast('至少保留一个页签', 'err');
      return;
    }
    const snap = await updateConfig((d) => {
      const tabs = kind === 'project' ? d.projectTabs : d.groupTabs;
      if (tabs.length <= 1) return;
      // 越界直接不动，避免 splice 掉一个本不该删的页签
      if (index < 0 || index >= tabs.length) return;
      tabs.splice(index, 1);
    });
    if (!snap) return;
    // 删除后最大合法索引 = 原长度 - 2；被删的不是最后一个时保持当前位置即可
    const maxIndex = before - 2;
    setActiveTab((s) => ({ ...s, [kind]: Math.max(0, Math.min(s[kind] > index ? s[kind] - 1 : s[kind], maxIndex)) }));
  }, [cardsOf, ctx, updateConfig]);

  /* ---------------- 链接 ---------------- */

  const createLink = useCallback(async (project: string, group: string, names?: string[]) => {
    const snap = await run('分配项目组', () => api.createLink(project, group, names));
    if (snap) {
      applySnapshot(snap);
      const row: LinkRow | undefined = snap.links.find((l) => l.project === project);
      pushLog(`已分配：${project} → ${group}（${row?.names.length ?? 0} 个链接）`);
      ctx.toast('分配完成', 'ok');
    }
  }, [api, applySnapshot, ctx, pushLog, run]);

  const removeLink = useCallback(async (project: string) => {
    const snap = await run('撤销链接', () => api.removeLink(project));
    if (snap) {
      applySnapshot(snap);
      pushLog(`已撤销链接：${project}`);
      ctx.toast('已撤销', 'ok');
    }
  }, [api, applySnapshot, ctx, pushLog, run]);

  /* ---------------- 外观 / 保护 ---------------- */

  const setTagColor = useCallback((path: string, color: string | null) =>
    updateConfig((d) => {
      if (color) d.tagColors[path] = color;
      else delete d.tagColors[path];
    }), [updateConfig]);

  /**
   * 图标 + 标签色一次保存。
   * 两者必须合并：分开调会各自基于同一份旧配置草稿并发写回，后一次覆盖前一次。
   */
  const saveStyle = useCallback(async (path: string, iconRef: string | null, color: string | null) => {
    const snap = await run('保存外观', () => api.saveStyle(path, iconRef, color));
    if (snap) {
      applySnapshot(snap);
      pushLog(`已保存外观：${path}`);
      ctx.toast('外观已保存', 'ok');
    }
  }, [api, applySnapshot, ctx, pushLog, run]);

  /**
   * 只改图标，不碰标签色。
   *
   * 不能复用 saveStyle 并回传 boot 里读到的颜色：saveStyle 的 color 传 null 表示
   * 「删除颜色」，而 boot 可能还没刷到刚保存的颜色（尤其继承自项目组的情况），
   * 那样回传 null 会把颜色直接抹掉。所以走 fpx_set_icon 这个只改图标的命令。
   */
  const setIcon = useCallback(async (path: string, iconRef: string | null) => {
    const snap = await run('保存图标', () => api.setIcon(path, iconRef));
    if (snap) {
      applySnapshot(snap);
      pushLog(`已保存图标：${path}`);
    }
  }, [api, applySnapshot, pushLog, run]);

  const saveCustomColors = useCallback(async (colors: string[]) => {
    const snap = await run('保存常用色', () => api.saveCustomColors(colors));
    if (snap) applySnapshot(snap);
  }, [api, applySnapshot, run]);

  const setLock = useCallback(async (path: string, denyDelete: boolean, denyWrite: boolean) => {
    const snap = await run('设置保护', () => api.setLock(path, denyDelete, denyWrite));
    if (snap) {
      applySnapshot(snap);
      pushLog(`${path} 保护：防删除=${denyDelete} 防写入=${denyWrite}`);
      ctx.toast('保护已更新', 'ok');
    }
  }, [api, applySnapshot, ctx, pushLog, run]);

  /**
   * 路径比较是否忽略大小写 —— 必须按平台来，不能写死。
   * Windows 文件系统不敏感，Linux / macOS 敏感（A/a 是两个不同目录）。
   * 无条件转小写会把两个不同项目判成同一个，标签色 / 图标 / ACL 锁会串档。
   */
  const ci = boot?.platform === 'windows';

  /* ---------------- 内容浏览 ---------------- */

  /** 内容区焦点目录：选中的项目组，或选中项目已链接的项目组 */
  const focusDir = useMemo(() => {
    if (!boot) return '';
    if (selGroup) return selGroup;
    if (selProject) {
      const row = boot.links.find((l) => l.project === selProject);
      if (row?.group) return row.group;
      const card = boot.projectTabs.flatMap((t) => t.items).find((c) => c.path === selProject);
      if (card?.linkedGroup) return card.linkedGroup;
    }
    return '';
  }, [boot, selGroup, selProject]);

  const scan = useCallback(async (root: string, kind: typeof contentKind = contentKind) => {
    if (!root) { setContent([]); return; }
    const items = await run('扫描内容', () => api.scanContent(root, kind));
    if (items) setContent(items);
  }, [api, contentKind, run]);

  useEffect(() => { scan(focusDir, contentKind); }, [focusDir, contentKind, scan]);

  /* ---------------- 改名 / 清除无效项 ---------------- */

  const renameFolder = useCallback(async (kind: CardKind, path: string, newName: string) => {
    const r = await run('改名', () => api.renameFolder(kind, path, newName));
    if (!r) return null;
    applySnapshot(r.snapshot);
    // 选中项要跟着改，否则改名后选中的还是旧路径，后续操作会打到不存在的目录上
    if (kind === 'project') {
      setSelProject((p) => (p && normalizeKey(p, ci) === normalizeKey(path, ci) ? r.newPath : p));
    } else {
      setSelGroup((p) => (p && normalizeKey(p, ci) === normalizeKey(path, ci) ? r.newPath : p));
    }
    const extra = r.recHits > 0 ? `，同步 ${r.recHits} 条链接记录` : '';
    pushLog(`已改名为「${newName}」${extra}`);
    return r;
  }, [api, applySnapshot, ci, pushLog, run]);

  const clearInvalid = useCallback(async () => {
    const r = await run('清除无效项', () => api.clearInvalid());
    if (!r) return null;
    applySnapshot(r.snapshot);
    // 被清掉的可能正是当前选中项
    const gone = new Set(r.removed.map((p) => normalizeKey(p, ci)));
    setSelProject((p) => (p && gone.has(normalizeKey(p, ci)) ? null : p));
    setSelGroup((p) => (p && gone.has(normalizeKey(p, ci)) ? null : p));
    if (r.tabHits === 0 && r.recHits === 0) {
      pushLog('没有发现无效项');
    } else {
      pushLog(`已清除 ${r.tabHits} 个无效登记${r.recHits > 0 ? `、${r.recHits} 条失效链接记录` : ''}`);
    }
    return r;
  }, [api, applySnapshot, ci, pushLog, run]);

  return {
    ctx, api, boot, loading, busy, log, pushLog, run,
    renameFolder, clearInvalid,
    selProject, setSelProject, selGroup, setSelGroup,
    activeTab, setActiveTab,
    content, contentKind, setContentKind, focusDir, scan,
    updateConfig, addCard, removeCard, moveCard, moveCardAcross, addTab, renameTab, removeTab,
    createLink, removeLink, setTagColor, setIcon, saveStyle, saveCustomColors, setLock, refresh,
  };
}

export type FpxStore = ReturnType<typeof useFpx>;
