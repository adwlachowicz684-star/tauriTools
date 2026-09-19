/**
 * localStorage 读写的最小封装。
 *
 * 抽出来的直接原因：这个封装此前在 customPresets / paramCards / modules /
 * nodeDefaults 四个模块里**各抄了一份**（KV 类型 + defaultKV + try/catch）。
 * 以后要给存储加一层加密，或者换成 Tauri 的文件存储，就得改四处 ——
 * 漏一处就是"部分数据加密了、部分没有"，比全不加密更难查。
 */

export type KV = {
  get: (k: string) => string | null;
  set: (k: string, v: string) => void;
  remove?: (k: string) => void;
};

/**
 * 访问 localStorage 在隐私模式下会**直接抛异常**，
 * 而读取发生在模块初始化阶段 —— 一抛就是整个插件白屏。
 * 所以每个方法都包 try：读不到就当没有，存不下就算了。
 */
export function defaultKV(): KV {
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
        /* 存不下就算了，不能让整个面板挂掉 */
      }
    },
    remove: (k: string) => {
      try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(k);
      } catch {
        /* 同上 */
      }
    },
  };
}

/**
 * 读一个"包在对象里的列表"。
 *
 * 四个存储的格式都是 `{ version, <字段名>: [...] }`，
 * 差别只在字段名与元素校验器 —— 所以抽成这一个函数，
 * 而不是让各处各写一遍 `Array.isArray(x) ? x : x?.field`。
 *
 * 坏数据一律当"没有"：宁可让用户重新存一次，也不要让插件起不来。
 *
 * @param field 列表在包装对象里的字段名（'presets' / 'cards' / 'modules'）
 * @param isValid 元素校验；不传则只做数组判断
 */
/*
 * 返回值用 unknown[] + 调用方 as 断言，而不是泛型。
 * （早年是为了绕开类型剥离脚本的限制，那条限制已随脚本废弃而解除；
 *   这个写法本身也没问题，保留。）
 */
export function loadList(
  kv: KV,
  key: string,
  field: string,
  isValid?: (v: unknown) => boolean,
): unknown[] {
  const raw = kv.get(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed as Record<string, unknown> | null)?.[field];
    if (!Array.isArray(list)) return [];
    /*
     * 写成两个 if 而不是三元 + as 的组合：
     * 三元里两段都有 as 时读起来绕，拆开更直白。
     */
    if (isValid) return list.filter(isValid);
    return list;
  } catch {
    return [];
  }
}

/**
 * 读一个"整个对象就是内容"的存储（如节点默认值表）。
 *
 * 不用 `<T extends Record<...>>` 而是收一个窄一点的入参类型：
 * 约束写在这里容易和调用方的推断打架，放外面更好读。
 */
export function loadObject(kv: KV, key: string): unknown {
  const raw = kv.get(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

/** 存一个带版本号的包装对象。四个存储共用这一个写入口径 */
export function saveWrapped(
  kv: KV,
  key: string,
  version: number,
  field: string,
  list: unknown[],
): void {
  kv.set(key, JSON.stringify({ version, [field]: list }));
}
