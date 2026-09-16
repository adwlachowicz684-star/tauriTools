import { cloneData } from './duplicate';

/**
 * 参数卡片。
 *
 * 把一组常用参数（如「GitHub 仓库地址 + 分支」「某个 LLM 凭据」）存成一张卡片，
 * 之后在属性面板里点一下就能套到节点上，画布节点上也以小卡扣的形式显示出来。
 *
 * ================= 语义（务必看清，这是设计的核心）=================
 *
 *   卡片 = 模板库，节点上的参数 = 实例。
 *
 *   · 把卡片套到节点上 → 拷贝一份值进节点（深拷贝，不是引用）
 *   · 之后改节点上的字段 → 该节点脱钩成「自定义」，卡片本身不变，
 *     其它引用了同一张卡片的节点也不受影响
 *   · 改卡片本身 → 同样不影响已经套用过的节点
 *
 * 这与「侧栏自定义节点」的语义完全一致：库是库，实例是实例。
 * 一旦让实例跟着库变，改一个节点就会波及别处 —— 那种牵连是灾难性的，
 * 用户根本记不住哪些节点共享了哪张卡片。
 *
 * ================= 为什么按 group 分组 =================
 *
 * 卡片按 group（如 'github-repo'）归类，而不是全局混在一起。
 * 否则会出现「把一张 HTTP 地址卡片套到 GitHub 仓库字段上」这类错配。
 * 同组卡片可跨节点类型共享：'github-repo' 组的卡片，
 * 更新检测和推送两个节点都能选到 —— 这是刻意要的复用。
 */

export const PARAM_CARDS_KEY = 'agent-flow.paramCards.v1';
const FORMAT_VERSION = 1;

export type ParamCard = {
  id: string;
  /** 归属组（'github-repo' / 'github-cred' …）。同组卡片跨节点类型共享 */
  group: string;
  name: string;
  /** 该组字段的键值对 */
  values: Record<string, unknown>;
  createdAt: number;
};

/* ------------------------------------------------------------------ */
/* 卡片组定义 —— 让卡片成为通用能力，而不是某几个节点的私有特性          */
/* ------------------------------------------------------------------ */

/**
 * 一「组」卡片管辖哪些字段、在界面上怎么显示、值长什么样算合法。
 *
 * 为什么要有这张表：
 * 最初卡片是 GitHub 节点私有的（组名、字段、摘要全写死在节点定义里），
 * 于是"给另一个节点加卡片"要重写一遍同样的东西；
 * 更关键的是**无法做类型验证** —— 不知道一组卡片该管哪些字段，
 * 就只能凭 group 名字字符串相等来判断能不能拖到某个节点上，
 * 而字符串是可以在两处各写一份、然后各改各的。
 *
 * 有了这张表之后：
 *   · 节点只需声明 meta.cardGroups: ['github-repo']，面板自动渲染选择器
 *   · 拖动卡片到节点时，能按 keys 校验卡片值是否真的适配这个节点
 *   · 新增一组卡片 = 注册一条 CardGroupDef，不用碰任何节点
 */
export type CardGroupDef = {
  group: string;
  /** 面板上的字段名 */
  label: string;
  /** 这组卡片管辖的字段名。改其中任一字段 → 节点脱钩 */
  keys: string[];
  /** 卡片上显示的摘要，如 "acme/web" */
  summary: (values: Record<string, unknown>) => string;
  /** 新建卡片时的默认名字 */
  name?: string;
  /**
   * 值合法性校验。返回错误说明，null 表示通过。
   * 拖动卡片到节点时用它挡住"看着能拖、套上去是空的"这类错配。
   */
  validate?: (values: Record<string, unknown>) => string | null;
};

const CARD_GROUPS = new Map<string, CardGroupDef>();

export function registerCardGroup(def: CardGroupDef): void {
  CARD_GROUPS.set(def.group, def);
}

export function getCardGroup(group: string): CardGroupDef | null {
  return CARD_GROUPS.get(group) ?? null;
}

export function allCardGroups(): CardGroupDef[] {
  return [...CARD_GROUPS.values()];
}

/* ------------------------------------------------------------------ */
/* 存储                                                                */
/* ------------------------------------------------------------------ */

export type KV = {
  get: (k: string) => string | null;
  set: (k: string, v: string) => void;
};

/**
 * 缺省读写。
 *
 * 用 try 包住是必要的：隐私模式下访问 localStorage 会直接抛异常，
 * 而这条路径在模块初始化时就可能走到，一抛就是整个插件白屏。
 */
function defaultKV(): KV {
  return {
    get: (k: string) => {
      try {
        return typeof localStorage === 'undefined' ? null : localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k: string, v: string) => {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(k, v);
      } catch {
        /* 存不下就算了，不该因此中断用户操作 */
      }
    },
  };
}

/** 读出来的东西不可信：可能是旧版本、手改过、或别的插件写坏的 */
function isCard(x: unknown): x is ParamCard {
  const o = x as ParamCard;
  return (
    !!o
    && typeof o.id === 'string' && o.id.length > 0
    && typeof o.group === 'string' && o.group.length > 0
    && typeof o.name === 'string'
    && !!o.values && typeof o.values === 'object'
  );
}

export function loadParamCards(kv: KV = defaultKV()): ParamCard[] {
  const raw = kv.get(PARAM_CARDS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed?.cards;
    if (!Array.isArray(list)) return [];
    return list.filter(isCard);
  } catch {
    // 坏数据宁可当没有，也不要让插件起不来
    return [];
  }
}

export function saveParamCards(list: ParamCard[], kv: KV = defaultKV()): void {
  kv.set(PARAM_CARDS_KEY, JSON.stringify({ version: FORMAT_VERSION, cards: list }));
}

/* ------------------------------------------------------------------ */
/* 增删改                                                              */
/* ------------------------------------------------------------------ */

function newId(): string {
  return `pc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function addParamCard(
  input: { group: string; name: string; values: Record<string, unknown> },
  kv: KV = defaultKV(),
): ParamCard {
  const list = loadParamCards(kv);
  const card: ParamCard = {
    id: newId(),
    group: input.group,
    name: input.name.trim() || '未命名',
    // 存的时候也深拷贝：否则调用方之后改了传入的对象，卡片内容跟着变
    values: cloneData(input.values),
    createdAt: Date.now(),
  };
  list.push(card);
  saveParamCards(list, kv);
  return card;
}

export function renameParamCard(id: string, name: string, kv: KV = defaultKV()): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  saveParamCards(
    loadParamCards(kv).map((c) => (c.id === id ? { ...c, name: trimmed } : c)),
    kv,
  );
}

export function removeParamCard(id: string, kv: KV = defaultKV()): void {
  saveParamCards(loadParamCards(kv).filter((c) => c.id !== id), kv);
}

/** 某组的全部卡片。UI 的选择器按组取 */
export function cardsOfGroup(group: string, kv: KV = defaultKV()): ParamCard[] {
  return loadParamCards(kv).filter((c) => c.group === group);
}

export function findCard(id: string | undefined | null, kv: KV = defaultKV()): ParamCard | null {
  if (!id) return null;
  return loadParamCards(kv).find((c) => c.id === id) ?? null;
}

/* ------------------------------------------------------------------ */
/* 套用 / 脱钩                                                          */
/* ------------------------------------------------------------------ */

/**
 * 节点上记录「哪个组套用了哪张卡片」。
 * 存在 data 里，随画布存档一起走。
 */
export type CardRefs = Record<string, string>;

export type NodeLike = { data?: unknown };

function dataOf(node: NodeLike): Record<string, unknown> {
  return (node.data ?? {}) as Record<string, unknown>;
}

/** 该组当前套用的是哪张卡片；没有则返回 null（即已脱钩 / 从未套用） */
export function cardIdOf(data: unknown, group: string): string | null {
  const d = (data ?? {}) as Record<string, unknown>;
  const refs = d.cardRefs as CardRefs | undefined;
  const id = refs?.[group];
  return typeof id === 'string' && id ? id : null;
}

/**
 * 把卡片套到节点上，返回要 patch 进节点的字段（纯函数，不直接改节点）。
 *
 * 值是深拷贝 —— 与自定义预设的 dataOf 同一套口径：
 * 若共享引用，改一个节点会波及所有套用同一张卡片的节点。
 *
 * 只覆盖 keys 里列出的字段：卡片里多余的字段不该被塞进节点
 * （比如一张卡片同时存了 branch，但某个节点类型没有这个字段）。
 *
 * 保留其它组的引用：节点可以同时套用多张不同组的卡片。
 */
export function applyCardTo(
  data: unknown,
  card: ParamCard,
  keys: string[],
): Record<string, unknown> {
  const d = (data ?? {}) as Record<string, unknown>;
  const refs = { ...((d.cardRefs as CardRefs) ?? {}) };
  refs[card.group] = card.id;

  const patch: Record<string, unknown> = { cardRefs: refs };
  for (const k of keys) {
    if (k in card.values) patch[k] = cloneData(card.values[k]);
  }
  return patch;
}

/**
 * 脱钩：节点上的值被手改了，不再跟随卡片。
 *
 * 只移除该组的引用，值本身不动 —— 用户改的值要留在节点上，
 * 只是它不再是"这张卡片的实例"了。
 */
export function detachGroup(data: unknown, group: string): Record<string, unknown> {
  const d = (data ?? {}) as Record<string, unknown>;
  const refs = { ...((d.cardRefs as CardRefs) ?? {}) };
  if (!(group in refs)) return {};
  delete refs[group];
  return { cardRefs: refs };
}

/** 该组是否已脱钩（有值但没引用卡片） */
export function isDetached(data: unknown, group: string): boolean {
  return cardIdOf(data, group) === null;
}

/**
 * 手改了某个字段时，判断要不要连带脱钩。
 *
 * 传入被改的字段名与该组管辖的字段列表：
 * 只有改的字段属于这一组，才需要脱钩（改分支属于仓库组，改提交信息则不属于）。
 *
 * ================= 一个必须挡掉的自我脱钩 =================
 *
 * 套用 / 切换卡片时，patch 里同时包含「该组的字段值」和「新的 cardRefs」。
 * 若照上面的规则判断，会认为"你改了这组字段"从而脱钩 ——
 * 而脱钩会用**旧 data 的 refs** 覆盖刚设好的新引用，于是切换失效：
 *
 *   merged = { ...patch(含新 refs), ...detachGroup(旧 refs 删掉本组) }
 *            ↑ 后者覆盖前者，结果 cardRefs 被清空
 *
 * 只有"节点原本没套卡片"时碰巧看不出问题（detachGroup 返回空对象、不覆盖），
 * 所以首次套用正常、第二次切换就失效 —— 这类 bug 很容易在自测时漏掉。
 *
 * 挡法：patch 里自带 cardRefs 就说明调用方正管理引用，不参与脱钩。
 */
export function shouldDetach(patch: Record<string, unknown>, keys: string[]): boolean {
  if ('cardRefs' in patch) return false;
  return Object.keys(patch).some((k) => keys.indexOf(k) >= 0);
}

/* ------------------------------------------------------------------ */
/* 复制卡片（Ctrl + 拖动）                                              */
/* ------------------------------------------------------------------ */

/**
 * 复制一张卡片（按住 Ctrl 拖动时用）。
 *
 * 与节点复制同一套语义：副本是深拷贝，改副本不影响原件。
 * 名字加「副本」后缀，避免列表里出现两张同名卡片无从分辨。
 */
export function duplicateCard(id: string, kv: KV = defaultKV()): ParamCard | null {
  const src = findCard(id, kv);
  if (!src) return null;
  const copy: ParamCard = {
    ...src,
    id: newId(),
    name: `${src.name} 副本`,
    values: cloneData(src.values),
    createdAt: Date.now(),
  };
  const list = loadParamCards(kv);
  // 插在原件后面：副本紧挨着原件，比丢到列表末尾好找
  const at = list.findIndex((c) => c.id === id);
  list.splice(at >= 0 ? at + 1 : list.length, 0, copy);
  saveParamCards(list, kv);
  return copy;
}

/* ------------------------------------------------------------------ */
/* 类型验证：卡片能不能套到这个节点上                                     */
/* ------------------------------------------------------------------ */

export type CheckResult = { ok: true } | { ok: false; reason: string };

/**
 * 判断一张卡片能否套到某个节点类型上。
 *
 * 三层校验，缺一不可：
 *  1. 组必须已注册 —— 未注册的组没有 keys，无从校验，也无从套用
 *  2. 节点必须声明支持这个组 —— 这是"类型验证"的核心。
 *     没有这一层，把 HTTP 地址卡片拖到 GitHub 节点上会静默写进去，
 *     节点上凭空多出几个用不到的字段
 *  3. 卡片的值必须通过组自带的 validate —— 挡住"看着能拖、套上去是空的"
 *
 * @param supportedGroups 该节点类型声明支持的组（来自 def.meta.cardGroups）
 */
export function checkCardForNode(
  card: ParamCard,
  supportedGroups: string[] | undefined,
  kv: KV = defaultKV(),
): CheckResult {
  const def = getCardGroup(card.group);
  if (!def) {
    return { ok: false, reason: `「${card.name}」属于未注册的分组 ${card.group}` };
  }
  if (!supportedGroups || supportedGroups.indexOf(card.group) < 0) {
    return { ok: false, reason: `${def.label}不能套到这个节点上` };
  }
  const err = def.validate?.(card.values) ?? null;
  if (err) return { ok: false, reason: `「${card.name}」${err}` };
  return { ok: true };
}

/** 按组定义取出要写进节点的字段（组未注册时返回空 patch） */
export function patchForCard(card: ParamCard): Record<string, unknown> {
  const def = getCardGroup(card.group);
  return def ? applyCardTo({}, card, def.keys) : {};
}

/* ------------------------------------------------------------------ */
/* 导入导出（跨环境分享）                                                */
/* ------------------------------------------------------------------ */

export function exportParamCards(kv: KV = defaultKV()): string {
  return JSON.stringify({ version: FORMAT_VERSION, cards: loadParamCards(kv) }, null, 2);
}

export type ImportResult = { added: number; updated: number; skipped: string[] };

export function importParamCards(
  json: string,
  opts?: { mode?: 'merge' | 'replace' },
  kv: KV = defaultKV(),
): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('不是合法的 JSON');
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { cards?: unknown })?.cards;
  if (!Array.isArray(list)) throw new Error('文件里没有卡片列表');

  const result: ImportResult = { added: 0, updated: 0, skipped: [] };
  const current = opts?.mode === 'replace' ? [] : loadParamCards(kv);

  for (const item of list) {
    if (!isCard(item)) {
      result.skipped.push(String((item as { name?: string })?.name ?? '(无名)'));
      continue;
    }
    // 同 id 视为同一条，覆盖。重复导入不会堆副本。
    const at = current.findIndex((c) => c.id === item.id);
    if (at >= 0) {
      current[at] = item;
      result.updated += 1;
    } else {
      current.push(item);
      result.added += 1;
    }
  }

  saveParamCards(current, kv);
  return result;
}
