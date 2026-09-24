/**
 * md 分块 —— 大文档的解析与渲染单位
 * ============================================================
 * 存在的理由：整篇喂给 ReactMarkdown 有两个硬伤
 *   ① 敲一个键就整篇重新解析（大文档直接卡死）
 *   ② 不可见部分照样参与渲染与布局
 *
 * 切成块之后：
 *   · 增量 —— 文本没变的块复用上次渲染结果（按内容缓存）
 *   · 虚拟 —— 不可见的块交给浏览器跳过（content-visibility，见 App.tsx）
 *
 * 这里只做**切分**，不碰 DOM，所以能在 node 里真跑测试。
 * 运行：node md-perf-test.mjs
 */

/*
 * 围栏状态要跨块跟踪。
 *
 * 不跟踪的话，代码块里的空行会被当成块边界 ——
 * 于是
 *   ```js
 *   const a = 1;
 *
 *   const b = 2;
 *   ```
 * 被切成两块，后半段 `const b = 2;\n``` 单独渲染成
 * 一段普通文字加三个反引号。**不报错，只是显示成一堆垃圾**，
 * 这正是最难排查的那类问题。
 */
function isFence(line) {
  return /^\s{0,3}(```+|~~~+)/.test(line);
}

function fenceMarker(line) {
  const m = line.match(/^\s{0,3}(```+|~~~+)/);
  return m ? m[1][0].repeat(3) : '';
}

/**
 * 按空行切分成顶层块。
 *
 * @param {string} text
 * @returns {Array<{text: string, start: number, end: number}>}
 *   start/end 是**字符**下标（用于定位，虚拟滚动不直接用）
 */
export function splitBlocks(text) {
  if (typeof text !== 'string' || !text) return [];

  const lines = text.split('\n');
  const out = [];
  let buf = [];
  let fence = '';          // 当前所处的围栏标记（'' = 不在围栏里）
  let pos = 0;             // 当前行在原文中的字符起点
  let start = 0;

  const flush = () => {
    /* 只含空行的缓冲不产出块：否则行尾多个空行会生成一堆空 div，
       虚拟滚动下每个空 div 还占一个估算高度，页面底部拖出一大片空白。 */
    const joined = buf.join('\n');
    if (joined.trim()) out.push({ text: joined, start, end: start + joined.length });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const f = isFence(line);
    if (f) {
      const marker = fenceMarker(line);
      if (!fence) {
        fence = marker;
      } else if (marker === fence && !/^\s{0,3}(```+|~~~+)\s*\S/.test(line)) {
        /* 闭合围栏：标记相同且后面没有 info string。
           不判 info string 的话 ```js ... ```js 会被当成又开一个围栏。 */
        fence = '';
      }
    }

    if (!fence && line.trim() === '' ) {
      /* 空行 = 块边界（只在围栏外） */
      flush();
      pos += line.length + 1;
      start = pos;
      continue;
    }

    if (buf.length === 0) start = pos;
    buf.push(line);
    pos += line.length + 1;
  }
  flush();

  /* 兜底：整篇没有空行（比如一整段）时上面会产出 0 块 —— 那就整篇一块 */
  if (out.length === 0 && text.trim()) {
    out.push({ text: text.trim(), start: 0, end: text.trim().length });
  }
  return out;
}

/*
 * 块缓存 —— 增量解析的关键。
 *
 * 键是**块文本本身**：文本没变就复用上次渲染出来的 React 元素，
 * 于是编辑时只有光标所在那一块重新解析。
 *
 * 上限是必须的：无上限的话翻过的每一块都常驻，
 * 长文档一路滚下去就是几百上千个 React 元素，内存只涨不落 ——
 * 而这恰恰是"为了省内存才做虚拟滚动"要解决的问题。
 */
export function createBlockCache(limit = 400) {
  const map = new Map();
  return {
    /*
     * get 也要"先删再插"（真 LRU）。
     *
     * 只刷新 set、不刷新 get 的话，淘汰的是"最早存进去的"而不是
     * "最久没用过的" —— 来回翻长文档时，正在看的块可能因为存得早
     * 被挤掉，下次翻回来又要重新解析一遍整条 remark/rehype 管线。
     */
    get(k) {
      if (!map.has(k)) return undefined;
      const v = map.get(k);
      map.delete(k);
      map.set(k, v);
      return v;
    },
    set(k, v) {
      /* 同理：已存在的键先删再插，把它挪到队尾 */
      if (map.has(k)) map.delete(k);
      map.set(k, v);
      while (map.size > limit) {
        const oldest = map.keys().next().value;
        map.delete(oldest);
      }
    },
    get size() { return map.size; },
  };
}

/**
 * 当前视口里最靠上的那个块的下标。
 *
 * 阅读状态存**块下标**而不是滚动比例：
 *   虚拟滚动下不可见块的高度是估算值，滚动条总高会随渲染变化，
 *   同一个比例在不同时刻指向的位置不一样 —— 恢复出来会偏。
 *   块下标不受高度估算影响，是稳的。
 *
 * @param {HTMLElement|null} container 滚动容器
 * @param {NodeListOf<Element>|Element[]} blocks 块元素
 * @returns {number} 找不到返回 0
 */
export function visibleBlockIndex(container, blocks) {
  if (!container || !blocks || !blocks.length) return 0;
  const top = container.getBoundingClientRect().top;
  for (let i = 0; i < blocks.length; i++) {
    const r = blocks[i].getBoundingClientRect();
    /* 底边在容器顶边之下 = 这一块还没完全滚过去 */
    if (r.bottom > top + 1) return i;
  }
  return 0;
}
