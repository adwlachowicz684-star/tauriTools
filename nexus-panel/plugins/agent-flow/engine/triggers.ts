import type { Trigger } from '../types';
import { nextRun } from './cron';

export type FireReason = 'manual' | 'interval' | 'cron' | 'watch' | 'webhook' | 'chat';

export type SchedulerDeps = {
  /** 每次 tick 拉取最新触发器，避免闭包持有过期数据 */
  getTriggers: () => Trigger[];
  /** 真正执行工作流；返回 false 表示执行失败 */
  onFire: (t: Trigger, reason: FireReason, payload?: string) => Promise<boolean>;
  log?: (msg: string) => void;
  /** 注入时钟，便于测试 */
  now?: () => number;
};

type CronMemo = { expr: string; at: number | null };
type Timer = ReturnType<typeof setTimeout>;

const TICK_MS = 1000;

/**
 * 触发器调度器。
 *
 * 三条铁律：
 *  1. 防重入 —— 上一轮没跑完，任何触发都跳过，绝不让 CLI 进程堆叠
 *  2. 防抖   —— watch 事件在窗口内合并成一次，改 10 个文件只跑一次
 *  3. 容错   —— 单次执行失败不会停掉周期调度，只记录结果
 */
export class TriggerScheduler {
  private timer: Timer | null = null;
  private running = false;

  /** interval 用：上次实际触发时刻 */
  private lastFired = new Map<string, number>();
  /** cron 用：缓存表达式与下次触发时刻，表达式变了自动重算 */
  private cronMemo = new Map<string, CronMemo>();
  /** watch 用：防抖定时器 */
  private debounce = new Map<string, Timer>();

  private deps: SchedulerDeps;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private log(msg: string) {
    this.deps.log?.(msg);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.log('触发器调度器已启动');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const t of this.debounce.values()) clearTimeout(t);
    this.debounce.clear();
    this.log('触发器调度器已停止');
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 主循环：检查周期与定时触发器 */
  private tick() {
    if (this.running) return;
    const now = this.now();

    for (const t of this.deps.getTriggers()) {
      if (!t.enabled) continue;

      if (t.kind === 'interval') {
        const gap = Math.max(10, t.config.intervalSec) * 1000;
        const last = this.lastFired.get(t.id);
        if (last === undefined || now - last >= gap) {
          void this.fire(t, 'interval');
          return; // 一轮只触发一个，避免瞬间并发
        }
      } else if (t.kind === 'cron') {
        const memo = this.cronMemo.get(t.id);
        if (!memo || memo.expr !== t.config.cronExpr) {
          const at = nextRun(t.config.cronExpr, new Date(now));
          this.cronMemo.set(t.id, { expr: t.config.cronExpr, at: at ? at.getTime() : null });
          if (at === null) this.log(`定时触发器「${t.name}」表达式无解，已跳过`);
          continue; // 本轮刚算出结果，下轮再判断是否命中
        }
        if (memo.at !== null && now >= memo.at) {
          void this.fire(t, 'cron');
          return;
        }
      }
    }
  }

  /** 文件监听事件入口：做防抖后触发 */
  notifyWatch(path: string) {
    const now = this.now();
    for (const t of this.deps.getTriggers()) {
      if (!t.enabled || t.kind !== 'watch') continue;

      const exts = t.config.watchExts;
      if (exts.length > 0) {
        const dot = path.lastIndexOf('.');
        const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
        if (!exts.some((e) => e.toLowerCase().replace(/^\./, '') === ext)) continue;
      }
      this.scheduleWatchFire(t, path);
    }
  }

  /**
   * 对话关键词命中入口。
   *
   * 与 webhook 共用防重入：对话里关键词可能密集出现（AI 一次回复
   * 反复提到同一个词），绝不能让 CLI 进程堆起来。
   */
  async notifyChat(id: string, payload: string): Promise<boolean> {
    const t = this.deps.getTriggers().find((x) => x.id === id);
    if (!t) {
      this.log(`对话命中，但未找到触发器 ${id}`);
      return false;
    }
    if (!t.enabled) {
      this.log(`对话触发器「${t.name}」已停用，忽略本次命中`);
      return false;
    }
    return this.fire(t, 'chat', payload);
  }

  /**
   * 外部 HTTP 调用入口。
   * 与其他触发一样受防重入约束：上一轮没跑完会直接跳过，
   * 所以疯狂 curl 也不会把 CLI 进程堆起来。
   */
  async notifyWebhook(id: string, body: string): Promise<boolean> {
    const t = this.deps.getTriggers().find((x) => x.id === id);
    if (!t) {
      this.log(`收到 webhook 调用，但未找到触发器 ${id}`);
      return false;
    }
    if (!t.enabled) {
      this.log(`webhook「${t.name}」已停用，忽略本次调用`);
      return false;
    }
    return this.fire(t, 'webhook', body);
  }

  private scheduleWatchFire(t: Trigger, path: string) {
    const key = t.id;
    const existing = this.debounce.get(key);
    if (existing) clearTimeout(existing);

    const wait = Math.max(0, t.config.debounceMs);
    this.debounce.set(
      key,
      setTimeout(() => {
        this.debounce.delete(key);
        this.log(`监听到变化：${path}`);
        void this.fire(t, 'watch');
      }, wait),
    );
  }

  /**
   * 手动触发（界面「立即执行」按钮）。同样受总开关与防重入约束。
   *
   * 一个节点可挂多种方式并展开成多条 Trigger，
   * 所以这里既接受展开后的 id（`nodeId:kind`），也接受 nodeId 本身
   * —— 传节点 id 时会挑该节点上的 manual 触发器，
   * 没有 manual 就退而取这个节点的第一种。
   */
  async fireManual(id: string): Promise<boolean> {
    const all = this.deps.getTriggers();
    const t =
      all.find((x) => x.id === id) ??
      all.find((x) => x.nodeId === id && x.kind === 'manual') ??
      all.find((x) => x.nodeId === id);
    if (!t) {
      this.log('触发器不存在');
      return false;
    }
    if (!t.enabled) {
      this.log(`触发器「${t.name}」已停用，未执行`);
      return false;
    }
    return this.fire(t, 'manual');
  }

  private async fire(t: Trigger, reason: FireReason, payload?: string): Promise<boolean> {
    if (this.running) {
      this.log(`跳过「${t.name}」：上一轮仍在执行中`);
      return false;
    }
    this.running = true;
    this.lastFired.set(t.id, this.now());

    // cron 触发后立刻推进到下一次，避免同一秒内重复命中
    if (t.kind === 'cron') {
      const at = nextRun(t.config.cronExpr, new Date(this.now()));
      this.cronMemo.set(t.id, { expr: t.config.cronExpr, at: at ? at.getTime() : null });
    }

    const label: Record<FireReason, string> = {
      manual: '手动', interval: '周期', cron: '定时',
      watch: '监听', webhook: '调用', chat: '对话',
    };
    const labelText = label[reason];
    this.log(`${labelText}触发「${t.name}」开始执行`);

    try {
      const ok = await this.deps.onFire(t, reason, payload);
      this.log(`${labelText}触发「${t.name}」${ok ? '执行成功' : '执行失败'}`);
      return ok;
    } catch (err) {
      this.log(`${labelText}触发「${t.name}」异常：${String(err)}`);
      return false;
    } finally {
      this.running = false;
    }
  }

  /**
   * 触发器被删除时清理内部状态，防止内存泄漏与误触发。
   *
   * 传 nodeId 时，该节点展开出的所有方式一并清理
   * （单选时代一个节点只有一条，多选后必须按前缀清）。
   */
  remove(id: string) {
    const prefix = `${id}:`;
    const keys = new Set<string>([id]);
    // 三个 Map 都要扫 —— 只扫 lastFired 会漏：
    // watch 的防抖项可能还没触发过（不在 lastFired），
    // cron 的缓存也可能先于首次触发就建好了
    for (const m of [this.lastFired, this.cronMemo, this.debounce]) {
      for (const k of m.keys()) if (k.startsWith(prefix)) keys.add(k);
    }
    for (const k of keys) {
      this.lastFired.delete(k);
      this.cronMemo.delete(k);
      const d = this.debounce.get(k);
      if (d) {
        clearTimeout(d);
        this.debounce.delete(k);
      }
    }
  }
}
