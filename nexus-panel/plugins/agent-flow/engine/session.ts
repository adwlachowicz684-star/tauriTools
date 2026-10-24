/**
 * 窗口会话身份（sessionID）。
 *
 * ================= 它解决什么 =================
 *
 * 一个面板可能同时被**多个 AI 窗口 / 多个对话**操作：
 * 窗口甲排的任务、窗口乙不知道，去认领就会撞车；
 * 或者窗口甲想找出"我自己刚才排的那几条"，却无从判断哪条是自己的。
 *
 * sessionID 就是**这个面板实例**的身份：
 *   · 任务上记着是哪個窗口认领的
 *   · 运行记录上记着是哪個窗口跑的
 * 于是"只看我的""接手窗口乙那条"都能查。
 *
 * ================= 与 assignee 的关系 =================
 *
 * 两个字段**并存**，不合并：
 *   · assignee —— 人看的名字（"张三"、"codebuddy"），手填，可随意
 *   · session  —— 機器身份（窗口号），由本模块生成，不由人改
 *
 * ⛔ 合并成一个的后果：assignee 是手填的，两个窗口可以填同一个名字，
 * 那时"是不是我自己认领的"就判断不了了 —— 而接手判断依赖于这个区分。
 *
 * ================= 为什么自动生成并持久化 =================
 *
 * 让人/AI 自己填一个窗口号，必然出现填重或忘填；
 * 而忘填时"这条是不是我的"会退化成"猜"。
 *
 * 持久化：不存的话每次刷新面板都换一个号，
 * 刚认领的任务刷新后就"不是我的"了 —— 那是数据丢失级别的错乱。
 *
 * ================= 为什么不用对话来源推导 =================
 *
 * conversations.ts 里的 codebuddy / traecli 等是**产品来源**，
 * 粒度是"哪个工具"，不是"哪个窗口"。同一个产品可以同时开好几个窗口，
 * 它们互相之间该能被区分开。
 */

import { defaultKV, type KV } from './kv';

const SESSION_KEY = 'agent-flow:session';

/** 窗口号前缀。写在 id 里，AI 在文件里一眼能认出"这是个窗口号" */
const PREFIX = 'w';

export type Session = {
  /** 稳定 id，如 w_3f2a91。写进任务与运行记录的是它 */
  id: string;
  /**
   * 人可读的标签，如"窗口 甲"。
   *
   * 只是为了在界面上不必盯着 w_3f2a91 认自己 ——
   * 编号没有语义，人记不住。改 label 不影响任何关联（关联只认 id）。
   */
  label: string;
  /** 这个号是什么时候生成的 */
  createdAt: number;
};

/** 随机段。6 位足够（几千万分之一撞号），短了会在多窗口时容易撞 */
function randomPart(): string {
  const n = Math.floor(Math.random() * 0xffffff);
  return n.toString(16).padStart(6, '0');
}

export function newSessionId(now: number = Date.now()): string {
  return `${PREFIX}_${now.toString(36)}_${randomPart()}`;
}

/** 看起来是不是一个本模块生成的窗口号。解析外部数据时要能认出来 */
export function looksLikeSessionId(s: string): boolean {
  return /^w_[0-9a-z]+_[0-9a-f]{6}$/.test(s);
}

/**
 * 读取当前窗口身份；没有就生成一个并**立刻存下**。
 *
 * 为什么读的时候就顺手存：不存的话，同一会话里两次调用之间
 * （比如先读去显示、过一会再读去认领）若触发了重新生成，
 * 两次拿到的号不一样，认领结果就对不上了。
 */
export function loadSession(kv: KV = defaultKV()): Session {
  const raw = kv.get(SESSION_KEY);
  if (raw) {
    const s = parseSession(raw);
    if (s) return s;
  }
  const fresh: Session = {
    id: newSessionId(),
    label: '',
    createdAt: Date.now(),
  };
  saveSession(fresh, kv);
  return fresh;
}

export function saveSession(s: Session, kv: KV = defaultKV()): void {
  try {
    kv.set(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* 存不下就算了 —— 退化成"每次一个临时号"，比白屏好 */
  }
}

function parseSession(raw: string): Session | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : '';
    if (!id) return null;
    return {
      id,
      label: typeof o.label === 'string' ? o.label : '',
      createdAt: typeof o.createdAt === 'number' && isFinite(o.createdAt) ? o.createdAt : 0,
    };
  } catch {
    return null;
  }
}

/**
 * 换一个新号（"这个窗口不用原来的身份了"）。
 *
 * ⛔ 换号**不清理**任务上已有的旧号：
 * 那些任务确实是旧窗口认领的，改成新号等于伪造历史；
 * 留着旧号，界面上会显示成"别的窗口认领的"，那才是事实。
 */
export function resetSession(kv: KV = defaultKV()): Session {
  const fresh: Session = { id: newSessionId(), label: '', createdAt: Date.now() };
  saveSession(fresh, kv);
  return fresh;
}

/** 显示名。没设 label 时退回短号 —— 至少能认出末尾几位 */
export function sessionName(s: Session): string {
  return s.label.trim() || shortId(s.id);
}

/** 缩略号：w_3f2a91 → 3f2a91。界面窄列里放得下 */
export function shortId(id: string): string {
  const at = id.indexOf('_');
  if (at < 0) return id;
  const rest = id.slice(at + 1);
  const at2 = rest.indexOf('_');
  return at2 < 0 ? rest : rest.slice(at2 + 1);
}
