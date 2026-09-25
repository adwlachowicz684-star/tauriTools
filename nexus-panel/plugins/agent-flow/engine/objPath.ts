/**
 * 按点号路径写进嵌套对象/数组。
 *
 * 存在的理由：卡片上要改的不全是顶层字段。
 * 触发器的每一个条件卡是 `entries[0].config.intervalSec` 这种，
 * 而改节点数据的通道（useNodePatch）只收一层平面的 `Record<string, unknown>` ——
 * 传 `{'entries.0.kind': 'cron'}` 过去会**真的建出一个叫这个名字的顶层字段**，
 * 不报错，界面上却毫无变化（没有任何地方读它）。
 *
 * 这类"改了没反应还不报错"正是最难查的那一类，所以路径解析必须
 * 在一处集中实现，而不是每个调用点各写一份 split/join。
 */

/** 点号路径 → 各级键。数字段在写数组时会转成下标 */
export function pathSegs(path: string): (string | number)[] {
  return path.split('.').map((s) => (s === '' ? s : Number.isNaN(Number(s)) ? s : Number(s)));
}

/**
 * 不可变写入：只在路径经过的那些层级上复制，其余保持原引用。
 *
 * 返回**新对象**，不改动入参 ——
 * 直接改原对象的话 React 会认为 data 没变（引用相同）从而不重渲染，
 * 表现为"值改了但卡片上还是旧的"。
 */
export function setInPath<T>(root: T, path: string, value: unknown): T {
  const segs = pathSegs(path);
  if (segs.length === 0) return root;

  const walk = (cur: unknown, i: number): unknown => {
    if (i >= segs.length) return value;
    const seg = segs[i];

    if (typeof seg === 'number') {
      // 数组下标：原值不是数组就从头建一个（长度按需要补齐）
      const arr = Array.isArray(cur) ? cur.slice() : [];
      while (arr.length < seg) arr.push(undefined);
      arr[seg] = walk(i === segs.length - 1 ? undefined : arr[seg], i + 1);
      return arr;
    }

    const obj = cur && typeof cur === 'object' && !Array.isArray(cur)
      ? { ...(cur as Record<string, unknown>) }
      : {};
    obj[seg] = walk((obj as Record<string, unknown>)[seg], i + 1);
    return obj;
  };

  return walk(root, 0) as T;
}

/** 按路径读值 —— 给"显示当前值"用，取不到就返回 undefined */
export function getInPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of pathSegs(path)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[seg as string | number];
  }
  return cur;
}
