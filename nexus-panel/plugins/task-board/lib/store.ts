// task-board 数据层：配置（ctx.store KV）+ tasks.json（tb_* 文件命令）+ HTTP API 客户端。
// 所有变更都走「读最新 -> 改 -> 写回」，避免用过期快照覆盖别人的修改。

import type { PluginContext } from '../../../js/plugin-sdk.js';
import {
  initialStatus,
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
  const cfg = { ...DEFAULT_CONFIG, ...raw };
  if (!cfg.dataDir) {
    // 首次使用：拿 Rust 侧默认目录（app_data_dir/task-board）并落盘
    const dir = await ctx.invoke('tb_default_dir');
    cfg.dataDir = dir;
    await ctx.store.set('config', cfg);
  }
  // 目录必须先进 Rust 授权表，否则读写命令全被拒
  await ctx.invoke('tb_set_data_dir', { dir: cfg.dataDir });
  return cfg;
}

export async function saveConfig(ctx: PluginContext, cfg: TbConfig): Promise<TbConfig> {
  const next = { ...DEFAULT_CONFIG, ...cfg };
  await ctx.store.set('config', next);
  await ctx.invoke('tb_set_data_dir', { dir: next.dataDir });
  return next;
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
