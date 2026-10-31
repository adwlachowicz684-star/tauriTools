// task-board 数据层：配置（ctx.store KV）+ tasks.json（tb_* 文件命令）+ HTTP API 客户端。
// 所有变更都走「读最新 -> 改 -> 写回」，避免用过期快照覆盖别人的修改。

import type { PluginContext } from '../../../js/plugin-sdk.js';
import {
  currentProject,
  initialStatus,
  normalizeConfig,
  newProjectId,
  normalizeStore,
  nextTaskId,
  pushHistory,
  applyTransition,
} from '../core';
import { DEFAULT_CONFIG } from '../types';
import type { TbConfig, TaskStore, Task, Agent } from '../types';

// ---------------------------------------------------------------- 配置

export async function loadConfig(ctx: PluginContext): Promise<TbConfig> {
  const raw = (await ctx.store.get('config', {})) || {};
  /*
    走 normalizeConfig 而不是 {...DEFAULT_CONFIG, ...raw}：
    老配置的 dataDir 要迁进项目列表，否则升级后打开是个空壳项目，
    而任务其实还在盘上 —— 那种"东西没了"的错最难自查。
  */
  let cfg = normalizeConfig(raw);
  if (!cfg.dataDir) {
    // 首次使用：拿 Rust 侧默认目录（app_data_dir/task-board）并落盘
    const dir = await ctx.invoke('tb_default_dir');
    cfg = normalizeConfig({ ...cfg, dataDir: dir });
    await ctx.store.set('config', cfg);
  }
  await authorize(ctx, cfg);
  return cfg;
}

export async function saveConfig(ctx: PluginContext, cfg: TbConfig): Promise<TbConfig> {
  const next = normalizeConfig(cfg);
  await ctx.store.set('config', next);
  await authorize(ctx, next);
  return next;
}

/**
 * 把配置里的目录登记进 Rust 授权表。
 *
 * 任务目录和文档目录**都要登记** —— 文档路径没登记的话，
 * 搬文档的命令会被授权检查挡掉，表现为"点了没反应"。
 * 文档路径没设（''）就不登记，命令收到空串会直接拒。
 */
async function authorize(ctx: PluginContext, cfg: TbConfig): Promise<void> {
  await ctx.invoke('tb_set_data_dir', { dir: cfg.dataDir });
  if (cfg.docsDir) {
    try {
      await ctx.invoke('tb_set_docs_dir', { dir: cfg.docsDir });
    } catch {
      /*
        文档目录授权失败**不影响主流程**：任务读写不看它。
        只在这里吞掉，因为老版本后端还没这条命令，
        那时报出来会让人以为整个插件坏了 —— 而实际只是搬文档用不了。
      */
    }
  }
}

// ---------------------------------------------------------------- 项目

/**
 * 把当前项目指向 id，并且**让上层的 dataDir / docsDir 跟着一起走**。
 *
 * ⛔ 这一步不能省，原因有个反直觉的地方：
 * normalizeConfig 有一条"派生字段反向写回"的规则 ——
 *   传入的 c.dataDir 与 **新的当前项目** 的 dataDir 不一致时，
 *   就把新项目的 dataDir 改成 c.dataDir。
 * 这条规则是为了支持"设置页直接改 dataDir"（那个字段是派生的）。
 *
 * 但切项目时传进去的 cfg 里，dataDir 还是**旧项目**的：
 *   switchProject(cfg, 'p2') → c.dataDir 是 p1 的，而 cur 已经是 p2
 *   → p2.dataDir 被改成 p1 的目录！
 *
 * 后果是切到项目乙却仍看到甲的任务（用户报的现象），
 * 而且**这个改动会写进磁盘配置** —— 两个项目从此指向同一份 tasks.json，
 * 在其中一个里的任何改动都会"同时"出现在另一个里。
 *
 * 所以切换类操作必须显式把上层两个派生字段设成目标项目的值，
 * 让 c.dataDir === cur.dataDir，那条写回规则就不会误触发。
 */
export function aimAt(cfg: TbConfig, currentId: string): TbConfig {
  const p = (cfg.projects || []).find((x) => x.id === currentId);
  if (!p) return { ...cfg, currentId };   // 找不到就交给 normalizeConfig 去回落
  return { ...cfg, currentId, dataDir: p.dataDir, docsDir: p.docsDir };
}

/** 新建项目。数据目录默认放在默认目录下的同名子目录里（可改）。 */
export async function addProject(
  ctx: PluginContext,
  cfg: TbConfig,
  name: string,
  dataDir: string,
  docsDir: string = '',
): Promise<TbConfig> {
  const id = newProjectId(cfg.projects.map((p) => p.id));
  /*
    数据目录留空 → 落到默认目录下的同名子目录。
    不能让空目录进配置：授权命令会直接拒，读写全挂，
    而界面上只显示"加载中"，看不出是目录没填。
  */
  let dir = (dataDir || '').trim();
  if (!dir) {
    const base = await ctx.invoke('tb_default_dir').catch(() => '');
    const slug = (name.trim() || id).replace(/[/\\:*?"<>|]/g, '_').trim() || id;
    dir = base ? `${base}/${slug}` : '';
  }
  const list = [...cfg.projects, {
    id,
    name: name.trim() || `项目 ${cfg.projects.length + 1}`,
    dataDir: dir,
    docsDir,
  }];
  // 新建即切过去 —— 建完还在看旧项目，会以为没建成
  const next = normalizeConfig(aimAt({ ...cfg, projects: list }, id));
  return saveConfig(ctx, next);
}

/**
 * 扫描一个目录（导入前验证用）。
 *
 * 后端没有这条命令时（老版本）**降级**成只验 tasks.json 是否存在 ——
 * 那样至少能看出"这里有没有任务库"，不至于整个导入功能开不了。
 */
export async function scanDir(
  ctx: PluginContext,
  dir: string,
  currentDataDir: string,
): Promise<{ dir: string; tasksJson: boolean; mdCount: number; dirCount: number; otherCount: number; sample: string[]; degraded?: boolean }> {
  try {
    /*
      ⛔ 这里**不调** tb_set_docs_dir 授权：
      扫描只是"看看里面有什么"，用户还没确认要用它。
      走那条命令会把当前项目真正的文档授权顶掉 ——
      扫一次别的目录，当前项目的文档路径就失效了。
      后端 tb_scan_dir 自己会把目标授权到 pending 槽（只读，且是用户亲手选的）。
    */
    const r: any = await ctx.invoke('tb_scan_dir', { dir });
    return {
      dir: String(r?.dir || dir),
      tasksJson: r?.tasksJson === true,
      mdCount: Number(r?.mdCount) || 0,
      dirCount: Number(r?.dirCount) || 0,
      otherCount: Number(r?.otherCount) || 0,
      sample: Array.isArray(r?.sample) ? r.sample.map((x: unknown) => String(x)) : [],
    };
  } catch {
    /*
      降级（后端没有 tb_scan_dir）：借读库命令探一下有没有 tasks.json。
      那条命令要求目标已授权，所以临时授权、探完**必须授权回去** ——
      不还原的话当前项目的任务库读写会全部被拒，
      表现为扫一次目录、整个看板空了。
    */
    let tasksJson = false;
    try {
      await ctx.invoke('tb_set_data_dir', { dir });
      const text = await ctx.invoke<string | null>('tb_read_store', { dir });
      tasksJson = text != null;
    } catch {
      tasksJson = false;
    } finally {
      if (currentDataDir) {
        await ctx.invoke('tb_set_data_dir', { dir: currentDataDir }).catch(() => {});
      }
    }
    return { dir, tasksJson, mdCount: 0, dirCount: 0, otherCount: 0, sample: [], degraded: true };
  }
}

/**
 * 导入一个项目：把某个文件夹接成新项目。
 *
 * `dataDir` 与 `docsDir` 分开传 —— 同一个文件夹可以同时是"任务库"和"文档"，
 * 但也可以是两个不同的地方（文档在另一个盘、或文档是任务库的子目录）。
 * 合成一个参数的话后者就表达不了。
 */
export async function importProject(
  ctx: PluginContext,
  cfg: TbConfig,
  name: string,
  dataDir: string,
  docsDir: string,
): Promise<TbConfig> {
  return addProject(ctx, cfg, name, dataDir, docsDir);
}

/** 切换当前项目 */
export async function switchProject(ctx: PluginContext, cfg: TbConfig, id: string): Promise<TbConfig> {
  return saveConfig(ctx, normalizeConfig(aimAt(cfg, id)));
}

/** 删除项目。不许删最后一个 —— 删了就没有当前项目，界面上没东西可显示。 */
export async function removeProject(ctx: PluginContext, cfg: TbConfig, id: string): Promise<TbConfig> {
  if (cfg.projects.length <= 1) return cfg;
  const projects = cfg.projects.filter((p) => p.id !== id);
  return saveConfig(ctx, normalizeConfig(aimAt({ ...cfg, projects }, projects[0].id)));
}

/**
 * 设置当前项目的文档路径。
 *
 * `move` 为真时把**旧目录里的文档整体搬过去**（旧位置不留）。
 * 搬之前先把新目录登记授权 —— 没登记的话搬的命令会被授权检查挡掉。
 *
 * ⚠️ 搬失败**不落盘**：配置改了而文档还在旧位置，下次读就对不上了。
 * 宁可这一次没改成，也不能留个指向空目录的路径。
 */
export async function setDocsDir(
  ctx: PluginContext,
  cfg: TbConfig,
  dir: string,
  move: boolean,
): Promise<{ cfg: TbConfig; moved: number; skipped: string[]; warning: string }> {
  const cur = currentProject(cfg);
  const oldDir = cur.docsDir || '';
  let moved = 0;
  const skipped: string[] = [];
  let warning = '';

  if (move && oldDir && dir && oldDir !== dir) {
    await ctx.invoke('tb_set_docs_dir', { dir });   // 先授权新目录
    let r: any = null;
    try {
      r = await ctx.invoke('tb_move_docs', { from: oldDir, to: dir });
    } catch (e: any) {
      throw new Error(`搬文档失败（配置未改）：${String(e?.message || e)}`);
    }
    moved = Number(r?.moved) || 0;
    const sk = Array.isArray(r?.skipped) ? r.skipped.map((x: unknown) => String(x)) : [];
    skipped.push(...sk);
    const failed = Array.isArray(r?.failed) ? r.failed.map((x: unknown) => String(x)) : [];
    if (failed.length > 0) warning = `有 ${failed.length} 项没搬成：${failed.slice(0, 5).join('、')}`;
  }

  const next = await saveConfig(ctx, normalizeConfig({ ...cfg, docsDir: dir }));
  return { cfg: next, moved, skipped, warning };
}

// ---------------------------------------------------------------- tasks.json 读写

/**
 * 解析 tasks.json 文本：先剥 UTF-8 BOM，再 JSON.parse。
 * 坏 JSON 时抛中文可读错误，而不是裸 SyntaxError —— 后者没人看得懂，
 * 空看板还会让人以为任务丢了。
 *
 * ⚠️ 历史坑（2026-10-25）：提交 8616727e 把首屏读从 JSON.parse 改成调用本函数，
 * 却漏了本函数的定义（全仓从无此函数）。于是 readStore 每次调用都
 * ReferenceError，任务面板整个起不来，报错还挂在「请确认数据目录」上，
 * 症状与成因对不上、极难定位。此处补齐定义。
 */
function parseStoreText(text: string): unknown {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(clean);
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    throw new Error(`tasks.json 解析失败：${msg}`);
  }
}

export async function readStore(ctx: PluginContext, dataDir: string): Promise<TaskStore> {
  const text = await ctx.invoke('tb_read_store', { dir: dataDir });
  if (!text) return normalizeStore(null);
  // 必须走 parseStoreText（剥 BOM + 中文错误），不能图省事写 JSON.parse(text)：
  // 首屏读的就是这条路径，裸 parse 的 SyntaxError 没人看懂。
  return normalizeStore(parseStoreText(text));
}

export async function writeStore(ctx: PluginContext, dataDir: string, store: TaskStore): Promise<void> {
  await ctx.invoke('tb_write_store', { dir: dataDir, json: JSON.stringify(store, null, 2) });
}

/**
 * 读-改-写一体：fn 拿到最新 store，返回的 store 会被写回。
 * 带乐观锁：写盘时带上「本次所基于的原文」（expect_text），Rust 锁内比对，
 * 不一致（其他通道已插队写入）则重读重试，最多 3 次——防止看板写回
 * 覆盖掉 AI / agent-flow 刚落盘的变更。
 */
export async function mutate(
  ctx: PluginContext,
  dataDir: string,
  fn: (store: TaskStore) => TaskStore | null,
): Promise<TaskStore> {
  for (let attempt = 0; ; attempt++) {
    const raw = (await ctx.invoke('tb_read_store', { dir: dataDir })) as string | null;
    const latest = normalizeStore(raw ? parseStoreText(raw) : null);
    const next = fn(latest);
    if (!next) return latest;
    try {
      await ctx.invoke('tb_write_store', {
        dir: dataDir,
        json: JSON.stringify(next, null, 2),
        expectText: raw,
      });
      return next;
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      if (attempt >= 2 || !msg.includes('TB_CONFLICT')) throw e;
      // 冲突：重读最新快照再试
    }
  }
}

// ---------------------------------------------------------------- 业务动作（UI 通道）

export async function createTask(
  ctx: PluginContext,
  dataDir: string,
  me: string,
  draft: {
    title: string;
    detail?: string;
    priority?: string;
    tags?: string[];
    assignee?: string;
    /** 预估工作量（人日，可小数）。传空/非法 = 0（没估） */
    estimate?: string | number;
    /** 任务类型（typeDefs 里的 id）。不传 = 未分类 */
    type?: string;
    /** 分组名。不传/空 = 不分组 */
    group?: string;
  },
): Promise<Task> {
  // 记录闭包实际使用的 id：乐观锁冲突重试时 id 会随最新快照重算，用它找回新建的任务
  let usedId = '';
  const next = await mutate(ctx, dataDir, (store) => {
    const id = nextTaskId(store);
    usedId = id;
    const at = Date.now();
    /*
      每个字段都显式写出来，不靠 normalizeTask 兜底 ——
      这份 JSON 是要给 AI 直接读改的：字段在文件里**看得见**
      它才会去填；靠默认值补出来的字段，AI 根本不知道有这一项。
    */
    const est = Number(draft.estimate);
    const base = {
      id,
      title: draft.title.trim(),
      detail: (draft.detail || '').trim(),
      summary: '',
      kind: 'task' as const,
      parent: null,
      deps: [] as string[],
      /*
        初始状态取本项目流程的第一个状态（自定义流程下不一定是 todo）。
        Rust 侧 HTTP 通道同样是这个判据 —— 两边必须一致，
        否则界面建出来的任务，AI 经 API 查出来的初始态对不上。
      */
      status: initialStatus(store.flow),
      priority: draft.priority || 'P2',
      estimate: Number.isFinite(est) && est > 0 ? est : 0,
      /*
        类型存定义表里的 id，不是显示名 —— 存名字的话改个名
        就要回头改所有任务，旧名还会变成没人认的孤值。
      */
      type: typeof draft.type === 'string' ? draft.type.trim() : '',
      /*
        分组。⛔ 同样必须显式写出来 —— 上面的注释说的就是这个判据：
        这份 JSON 是给 AI 直接读改的，字段在文件里看得见它才会去填。
        group 恰好漏了：靠 normalizeTask 兜底的话，AI 看到的文件里没有这一列，
        于是它建出来的任务永远不带分组。
      */
      group: typeof draft.group === 'string' ? draft.group.trim() : '',
      tags: (draft.tags || []).filter(Boolean),
      reporter: me || 'manual',
      assignee: draft.assignee || null,
      createdAt: at,
      updatedAt: at,
      history: [],
    };
    const task = pushHistory(base, me || 'manual', 'create', '新建任务', at) as Task;
    return { ...store, nextId: store.nextId + 1, tasks: [...store.tasks, task] };
  });
  const created = next.tasks.find((t) => t.id === usedId);
  if (!created) throw new Error('新建失败');
  return created;
}

export async function transitionTask(
  ctx: PluginContext,
  dataDir: string,
  me: string,
  id: string,
  to: string,
  note = '',
): Promise<Task> {
  let out: Task | null = null;
  await mutate(ctx, dataDir, (store) => {
    const idx = store.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return null;
    const next = applyTransition(store.tasks[idx], to, me, note);
    if (!next) return null;
    const tasks = [...store.tasks];
    tasks[idx] = next;
    out = next;
    return { ...store, tasks };
  });
  if (!out) throw new Error(`任务 ${id} 流转失败（状态不允许或任务不存在）`);
  return out;
}

export async function commentTask(
  ctx: PluginContext,
  dataDir: string,
  me: string,
  id: string,
  note: string,
): Promise<Task> {
  let out: Task | null = null;
  await mutate(ctx, dataDir, (store) => {
    const idx = store.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return null;
    const next = pushHistory(store.tasks[idx], me, 'note', note);
    const tasks = [...store.tasks];
    tasks[idx] = next;
    out = next;
    return { ...store, tasks };
  });
  if (!out) throw new Error(`任务 ${id} 不存在`);
  return out;
}

export async function deleteTask(ctx: PluginContext, dataDir: string, id: string): Promise<void> {
  await mutate(ctx, dataDir, (store) => {
    if (!store.tasks.some((t) => t.id === id)) return null;
    return { ...store, tasks: store.tasks.filter((t) => t.id !== id) };
  });
}

export async function registerAgent(ctx: PluginContext, dataDir: string, agent: Agent): Promise<void> {
  await mutate(ctx, dataDir, (store) => {
    const at = Date.now();
    const exists = store.agents.some((a) => a.id === agent.id);
    const agents = exists
      ? store.agents.map((a) => (a.id === agent.id ? { ...a, ...agent, lastSeen: at } : a))
      : [...store.agents, { ...agent, lastSeen: at }];
    return { ...store, agents };
  });
}

// ---------------------------------------------------------------- HTTP API 客户端（AI / agent-flow 通道）

function apiBase(cfg: TbConfig): string {
  return `http://127.0.0.1:${cfg.port}`;
}

function authHeaders(cfg: TbConfig): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.token) h['X-TB-Token'] = cfg.token;
  return h;
}

/** 探活：服务在线返回 true */
export async function apiHealth(cfg: TbConfig): Promise<boolean> {
  try {
    const r = await fetch(`${apiBase(cfg)}/api/health`, { headers: authHeaders(cfg) });
    if (!r.ok) return false;
    const j = await r.json();
    return j && j.ok === true;
  } catch {
    return false;
  }
}

export async function apiStart(ctx: PluginContext, cfg: TbConfig): Promise<string> {
  // notifyUrl 一并下发：HTTP 通道送审（PATCH status=review）时 Rust 侧 fire-and-forget POST
  return ctx.invoke('tb_http_start', {
    port: cfg.port,
    token: cfg.token,
    dataDir: cfg.dataDir,
    notifyUrl: cfg.notifyUrl || '',
  });
}

export async function apiStop(ctx: PluginContext, cfg: TbConfig): Promise<void> {
  await ctx.invoke('tb_http_stop', { port: cfg.port });
}

/** 文档里给 AI/流程用的调用示例（设置面板展示 + 复制） */
export function curlExample(cfg: TbConfig): string {
  const auth = cfg.token ? `-H "X-TB-Token: ${cfg.token}" ` : '';
  return [
    `# 查全部任务`,
    `curl ${auth}http://127.0.0.1:${cfg.port}/api/tasks`,
    ``,
    `# 新建任务（发现问题）`,
    `curl -X POST ${auth}-H "Content-Type: application/json" \\`,
    `  -d '{"title":"登录页样式错乱","priority":"P1","tags":["bug","ui"],"reporter":"dev-a"}' \\`,
    `  http://127.0.0.1:${cfg.port}/api/tasks`,
    ``,
    `# 认领任务`,
    `curl -X PATCH ${auth}-H "Content-Type: application/json" \\`,
    `  -d '{"assignee":"dev-a","by":"dev-a"}' http://127.0.0.1:${cfg.port}/api/tasks/tb-0001`,
    ``,
    `# 提交审查`,
    `curl -X PATCH ${auth}-H "Content-Type: application/json" \\`,
    `  -d '{"status":"review","by":"dev-a","note":"自测通过"}' http://127.0.0.1:${cfg.port}/api/tasks/tb-0001`,
    ``,
    `# 审查通过`,
    `curl -X PATCH ${auth}-H "Content-Type: application/json" \\`,
    `  -d '{"status":"done","by":"review-1"}' http://127.0.0.1:${cfg.port}/api/tasks/tb-0001`,
  ].join('\n');
}

/** 任务提交审查时通知外部（agent-flow webhook 等），失败静默 */
export async function notifyWebhook(cfg: TbConfig, task: Task): Promise<void> {
  if (!cfg.notifyUrl) return;
  try {
    await fetch(cfg.notifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'task-board',
        event: 'submit-review',
        task: { id: task.id, title: task.title, status: task.status, assignee: task.assignee },
      }),
    });
  } catch {
    /* 通知失败不阻塞主流程 */
  }
}

/** 生成随机访问令牌（32 位十六进制） */
export function genToken(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}
