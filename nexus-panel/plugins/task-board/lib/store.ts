// task-board 数据层：配置（ctx.store KV）+ tasks.json（tb_* 文件命令）+ HTTP API 客户端。
// 所有变更都走「读最新 -> 改 -> 写回」，避免用过期快照覆盖别人的修改。

import type { PluginContext } from '../../../js/plugin-sdk.js';
import {
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

export async function readStore(ctx: PluginContext, dataDir: string): Promise<TaskStore> {
  const text = await ctx.invoke('tb_read_store', { dir: dataDir });
  if (!text) return normalizeStore(null);
  return normalizeStore(JSON.parse(text));
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
    const latest = normalizeStore(raw ? JSON.parse(raw) : null);
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
  draft: { title: string; detail?: string; priority?: string; tags?: string[]; assignee?: string },
): Promise<Task> {
  // 记录闭包实际使用的 id：乐观锁冲突重试时 id 会随最新快照重算，用它找回新建的任务
  let usedId = '';
  const next = await mutate(ctx, dataDir, (store) => {
    const id = nextTaskId(store);
    usedId = id;
    const at = Date.now();
    const base = {
      id,
      title: draft.title.trim(),
      detail: (draft.detail || '').trim(),
      status: 'todo',
      priority: draft.priority || 'P2',
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
