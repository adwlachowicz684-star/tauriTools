/**
 * 卸载残留校验（只读 · 不阻断 · 同步）
 * ============================================================
 * 目的：插件卸载后做一次**全局快照差分**，把"多出来的东西"报出来。
 *
 * 为什么需要它
 * ------------------------------------------------------------
 * 卸载靠 `inst.cleanupFns.forEach(fn => fn())`，而 cleanupFns 是
 * **插件自己 push 的** —— 漏一个就漏一片，全仓库此前 0 处回收校验。
 *
 * 真实污染源已存在：`plugins/mindmap/editor/kityminder.core.min.js`
 * 里有 `window.addEventListener("resize", ...)`。它是压缩的第三方库，
 * 既无法审计，也无法要求它改。
 *
 * 设计约束（非常重要）
 * ------------------------------------------------------------
 * 1. **只读** —— 不改任何全局状态，只观察。不做"顺手清理"：
 *    自动清理可能删掉别的插件正在用的东西，比泄漏更危险。
 * 2. **绝不阻断卸载** —— 全程 try/catch，最后执行，永不 throw。
 *    校验失败只产生一条日志，**插件照常卸载成功**。
 * 3. **同步零延迟** —— 在 safeTeardown 末尾同步拍快照，不 await、
 *    不 setTimeout。为了校验让每次切插件慢 100ms 就是"安全影响功能"了。
 *    代价是抓不到"卸载后异步才做的清理"——那类只能靠后续手段，
 *    见污染防控文档里"异步逃逸"一节。
 * 4. **弱归因** —— 多插件共存时，差分只能看到"总量变了"，
 *    无法证明是哪个插件留的。所以报告措辞是"卸载 X 期间"，
 *    不是"X 泄漏了"。精确归因要等 owned 通道（下一步）。
 */

/**
 * 宿主自身的正常变动，不算泄漏。
 *
 * 为什么要过滤：宿主在卸载期间自己也会往 body 加东西（设置抽屉遮罩、
 * toast、检查器高亮层）。不过滤的话每次都报，报告就没人看了。
 *
 * 为什么不静默过滤：过滤掉的项**照样计数并展示**，只是标为 benign。
 * 静默过滤会掩盖真实问题 —— 万一某个插件正好用了同样的类名呢。
 */
const BENIGN_BODY = [
  '.nx-insp-overlay',      // 元素检查器高亮层
  '.nx-insp-badge',        // 元素检查器信息条
  '.drawer-mask',          // 设置抽屉遮罩
  '.toast',                // 提示条
];

/** 拍一张全局快照。只读。 */
export function snapshotGlobals() {
  try {
    const keys = Object.keys(window).sort();
    const head = [...document.head.children].map(nodeTag);
    const body = [...document.body.children].map(nodeTag);
    return {
      windowKeys: keys,
      headNodes: head,
      bodyNodes: body,
      styleSheets: document.styleSheets.length,
      adoptedStyleSheets: (document.adoptedStyleSheets || []).length,
    };
  } catch {
    /* 快照本身失败不该影响卸载 —— 返回一个"空"快照，差分会认为无变化 */
    return null;
  }
}

/** 节点的简短标识；带 id/class 才能区分同类节点 */
function nodeTag(n) {
  if (!n) return '';
  let s = (n.tagName || '').toLowerCase();
  if (n.id) s += '#' + n.id;
  const cls = [...(n.classList || [])].filter(Boolean).slice(0, 2);
  if (cls.length) s += '.' + cls.join('.');
  return s;
}

/** 求 a 相对 b 多出来的项（多重集合语义：重复出现要分别算） */
function addedOf(before, after) {
  const pool = [...before];
  const out = [];
  for (const x of after) {
    const i = pool.indexOf(x);
    if (i >= 0) pool.splice(i, 1);
    else out.push(x);
  }
  return out;
}

/**
 * 比对两张快照。
 *
 * @returns {{suspect: string[], benign: string[]}} 只看"新增"，
 *   因为"减少"是清理生效的表现，不是泄漏。
 */
export function diffSnapshots(before, after) {
  if (!before || !after) return { suspect: [], benign: [] };

  const added = [
    ...addedOf(before.windowKeys, after.windowKeys).map((k) => `window.${k}`),
    ...addedOf(before.headNodes, after.headNodes).map((n) => `head > ${n}`),
    ...addedOf(before.bodyNodes, after.bodyNodes).map((n) => `body > ${n}`),
  ];

  /* 样式表数量：只能看总数，看不出是谁加的 —— 所以只报数字变化 */
  const dStyle = after.styleSheets - before.styleSheets;
  if (dStyle > 0) added.push(`document.styleSheets +${dStyle}`);
  const dAdopted = after.adoptedStyleSheets - before.adoptedStyleSheets;
  if (dAdopted > 0) added.push(`document.adoptedStyleSheets +${dAdopted}`);

  const benign = [];
  const suspect = [];
  for (const item of added) {
    const isBenign = BENIGN_BODY.some((sel) => {
      const cls = sel.replace(/^\./, '');
      return item.includes('.' + cls) || item.includes('#' + cls);
    });
    (isBenign ? benign : suspect).push(item);
  }
  return { suspect, benign };
}

/**
 * 在卸载末尾跑一次校验并报告。**永不 throw。**
 *
 * @param {string} pluginId 正在卸载的插件
 * @param {object} before   卸载前快照（由调用方在卸载前拍）
 */
export function auditUnmount(pluginId, before) {
  /* 整个函数体包 try：校验工具的失败绝不能影响卸载 */
  try {
    if (!before) return { suspect: [], benign: [] };
    const after = snapshotGlobals();
    const { suspect, benign } = diffSnapshots(before, after);

    if (suspect.length) {
      console.warn(
        `[unmount-audit] 插件「${pluginId}」卸载后疑似残留 ${suspect.length} 项：`,
        suspect,
      );
    }
    /* benign 也要输出，但用 info 级 —— 它可能是误报，也可能是
       某个插件碰巧用了同类名。静默过滤会让这类问题永远没人看见。 */
    if (benign.length) {
      console.info(
        `[unmount-audit] 插件「${pluginId}」卸载期间宿主自身变动 ${benign.length} 项（已忽略）：`,
        benign,
      );
    }
    return { suspect, benign };
  } catch (e) {
    console.error('[unmount-audit] 校验自身出错（不影响卸载）:', e);
    return { suspect: [], benign: [] };
  }
}
