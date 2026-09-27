/**
 * 运行时依赖（runtime deps）—— 装进工具内部、供插件动态取用的 npm 包
 * ============================================================
 *
 * 【它解决什么】
 * 打包产物里没有 package.json，也没有 node_modules —— 前端依赖在构建期
 * 就被 Vite 打进了 bundle。所以"运行时再装一个包"这件事，默认是不成立的：
 * 你装了，插件也 import 不到。
 *
 * 本模块做的是把这条链路补上：
 *
 *   远端 CDN（取 ESM 单文件） → 工具数据目录 deps/<pkg>.mjs → asset:// → 动态 import
 *
 * 【为什么是"ESM 单文件"而不是 npm tarball】
 * tarball 要在客户端解压（.tar.gz + 依赖树解析），既没有 tar/flate2 依赖、
 * 也拿不到 npm 的 tree 解析规则；更要紧的是：解压出来的多数是 CJS，
 * 浏览器 import 不了。
 * CDN 的 `+esm` 端点直接给出浏览器可用的 ESM 单文件，跳过了这两步。
 * 代价：只适合"纯前端、无 node 内建模块"的包 —— 这就是为什么下面
 * `canInstall()` 要显式拒绝一部分，而不是照单全收。
 *
 * 【三处最容易踩的空】
 * ① 装完必须能被 import，否则"装成功"是个假象 —— 见 loadRuntimeDep()。
 * ② 命令不存在不能静默，必须明说"后端尚未接入" —— 见 INSTALL_ERR。
 * ③ 版本要从 package.json 的声明来，不能自己猜 —— 见 specOf()。
 */

/** CDN 基址。改这里就够了，不要在各处拼字符串。 */
export const RT_DEP_CDN = 'https://cdn.jsdelivr.net/npm';

/** 装到工具数据目录下的子目录名。 */
export const RT_DEP_DIR = 'deps';

/** 安装命令（后端）。不存在时 = 后端还没接这条链路。 */
export const CMD_LIST = 'fpx_rt_dep_list';
export const CMD_INSTALL = 'fpx_rt_dep_install';
export const CMD_REMOVE = 'fpx_rt_dep_remove';

/**
 * 明确的失败原因。
 * 这些字符串会直接显示给用户，所以每一条都要能回答"我下一步该做什么"，
 * 不能只说"失败"。
 */
export const RT_ERR = {
  noCmd: '后端尚未接入运行时依赖（缺 fpx_rt_dep_install）—— 请更新到支持该命令的版本',
  noSpec: '解析不出包名与版本 —— 该依赖的 install 字段格式不在预期内',
  notSupported: '这个包不适合运行时安装（Rust crate / 需要 node 内建模块的包）',
  network: '下载失败 —— 检查网络，或稍后重试',
  empty: '下载到的内容是空的 —— CDN 可能不支持这个包的 ESM 构建',
  range:
    '声明的版本是复合范围（如 >=1.0.0 <2 或 1.x || 2.x），CDN 定位不到具体版本 —— ' +
    '请在版本框里写死一个版本号（如 12.0.0），或先在 package.json 锁定',
  badVer: '版本号看着不对 —— 请写成 12.0.0 这种形式（不要带 ^ ~ 之外的符号）',
  removed: '已移除',
};

/** scoped 包（@scope/name）与斜杠都要换掉，否则会当成目录。 */
export function safeFileOf(name, version) {
  const n = String(name || '').trim().replace(/[@/\\]/g, '_');
  const v = String(version || '').trim().replace(/[^0-9A-Za-z._-]/g, '');
  return `${n}@${v || 'latest'}.mjs`;
}

/**
 * 版本归一化 —— 与 safeFileOf 对版本做的事**完全一致**。
 *
 * 为什么单列一个函数：判断"已装的是不是声明的那个"时，两边口径必须相同。
 * 声明写 `^12.0.0`、落盘文件名是 `mermaid@12.0.0.mjs`、list 还原出的版本是
 * `12.0.0` —— 直接拿字符串比必然不等，于是"装的就是它"被误判成"装了别的
 * 版本"，界面上凭空多出一条"与声明不符"。
 */
export function normVersion(version) {
  return String(version || '')
    .trim()
    .replace(/[^0-9A-Za-z._-]/g, '');
}

/**
 * 版本自然序比较：9 排在 10 前面。
 *
 * 直接用字符串排会变成 "10.0.0" < "9.0.0"，于是列表里 10 排在 9 前面。
 * 单看不觉得有问题，但"顺序"本身会被当成有含义（最上面那个像是最新的），
 * 用户据此判断该删哪个，就可能删错。显示顺序要么对，要么干脆不暗示含义。
 */
export function cmpVersion(a, b) {
  const pa = String(a ?? '').split('.');
  const pb = String(b ?? '').split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = parseInt(pa[i], 10);
    const y = parseInt(pb[i], 10);
    const bothNum = !Number.isNaN(x) && !Number.isNaN(y);
    if (bothNum) {
      if (x !== y) return x - y;
      continue;
    }
    /* 一段是数字一段不是（如 12.0.0-rc）时退回字符串比，避免 NaN 把顺序搅乱 */
    const s = String(pa[i] ?? '').localeCompare(String(pb[i] ?? ''));
    if (s !== 0) return s;
  }
  return 0;
}

/**
 * 复合范围的样子：`>=1.0.0 <2`、`1.x || 2.x`、`*`。
 *
 * 这些**没法**靠剥符号得到一个具体版本（`>=1.0.0 <2` 剥完是 `1.0.02`，
 * 拼进 URL 是 404）。所以单独识别出来，让调用方明确拒绝，而不是拿一个
 * 拼出来的假版本去下载。
 */
const RANGE_RE = /[<>]|\|\||\s|\*/;

/**
 * 把声明里的版本规范（可能是范围）解析成一个**能直接拼进 URL 的具体版本**。
 *
 * 为什么必须先归一化再拼 URL（实测）：
 *   https://cdn.jsdelivr.net/npm/mermaid@^12.0.0/+esm   → 502（下载失败）
 *   https://cdn.jsdelivr.net/npm/mermaid@12.0.0/+esm    → 200
 * 也就是说：**带 ^ 的 URL 根本取不到东西**。而 manifest 里绝大多数声明
 * 都是 `^12.0.0` 这种范围，于是一键安装对绝大多数包都是"点了就失败"。
 *
 * 归一化的第二个理由（更要紧）：URL、落盘文件名、列表里显示的版本
 * **必须指同一个版本**。safeFileOf 一直在剥范围符号（落盘是
 * `mermaid@12.0.0.mjs`），若 URL 仍带 ^，即便 CDN 肯解析范围，装进来的
 * 也会是范围内最新的那个（比如 12.3.0），而界面显示的是 `12.0.0` ——
 * 显示与实际不符，且无从察觉。
 *
 * 复合范围（`>=1.0.0 <2`）无法定位到具体版本，返回 ok:false 让调用方
 * 明确拒绝；不做猜测、也不退化成 latest（那同样是"装的不是显示的那份"）。
 */
export function pinnedVersionOf(version) {
  const raw = String(version || '').trim();
  if (!raw) return { version: '', ok: true, latest: true };
  if (RANGE_RE.test(raw)) return { version: normVersion(raw), ok: false, reason: 'range' };
  const v = normVersion(raw);
  if (!v) return { version: '', ok: false, reason: 'empty' };
  return { version: v, ok: true, latest: false };
}

/**
 * CDN 上取 ESM 单文件的地址。
 *
 * 版本一律先过 pinnedVersionOf 剥掉 ^ / ~ 等范围符号，理由见它的注释。
 * 复合范围这里退化成"不带版本"（即 latest），但**调用方必须先查
 * pinnedVersionOf().ok**，别拿这个退化结果去装 —— 见 installRuntimeDep。
 */
export function entryUrlOf(name, version) {
  const pin = pinnedVersionOf(version);
  const v = pin.ok ? pin.version : '';
  const pkg = v ? `${String(name || '')}@${v}` : String(name || '');
  return `${RT_DEP_CDN}/${pkg}/+esm`;
}

/**
 * 从 deps-manifest 的 install 字段（形如 `npm i mermaid@^12.0.0`）里取出
 * 包名与版本。
 *
 * 为什么不在界面上直接拿 name/declared：manifest 里 `declared` 可能是
 * `^12.0.0` 这种范围，也可能是 null（未声明的依赖根本没有）。而 install
 * 字段是 scan-deps 生成时就定好的唯一可执行指令 —— 以它为准才不会出现
 * "界面显示装 A、实际装了 B"。
 */
export function specOf(install) {
  const s = String(install || '').trim();
  if (!s) return null;

  // 去掉可能存在的 sudo / 包管理器前缀，只留最后一个 "包名@版本" 片段
  const parts = s.split(/\s+/).filter(Boolean);
  let spec = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^[.\-@A-Za-z0-9_/.^-]+$/.test(parts[i]) && !/^[.\-]+$/.test(parts[i])) {
      spec = parts[i];
      break;
    }
  }
  if (!spec) return null;

  // scoped：@scope/name@1.2.3
  const at = spec.lastIndexOf('@');
  if (at <= 0) return { name: spec, version: '' };

  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  if (!name || !version) return { name: name || spec, version: '' };
  return { name, version };
}

/**
 * 装了反而坏 / 装了也用不了的包 —— 必须拒绝，并且理由要能说清"装了会怎样"。
 * ------------------------------------------------------------
 *
 * 【为什么不能只凭"它是运行时依赖"就放行】
 * canInstall 早先只排除 rust 与 dev，于是下面这六条全都显示「安装」按钮。
 * 而它们装进去的下场分别是：
 *
 *   · react / react-dom / react-markdown / @xyflow/react
 *     → CDN 的单文件把 react 一起打进去 = **第二份 react 实例**，
 *       任何插件一用就是 Invalid hook call。而这个报错**完全指不到**
 *       "你刚装了运行时依赖"这一步 —— 用户只会看到某个插件崩了。
 *
 *   · @tauri-apps/api
 *     → 它靠 window.__TAURI_INTERNALS__ 与宿主 Rust 侧通信，版本必须
 *       和 Cargo 侧一致。装一份外部版本 = 能 import、但所有调用静默失败。
 *
 *   · @plantuml/core
 *     → 必须先注入 viz-global.js（classic script）再 import ESM，
 *       单文件装进去也用不了；且 ≤1.2026.5 是 GPL-3.0，不能随手换版本。
 *
 * 这不是保守：这六条里**每一条的失败都不指向这里**，是本项目最难归因的
 * 那一类。宁可不给按钮，也不能让人踩进去。
 *
 * 【为什么是显式名单而不是自动推断依赖树】
 * 判断"某个包依赖 react"需要读子包的 package.json —— 打包产物里没有
 * node_modules，客户端拿不到依赖树。自动推断在这里做不到，所以宁可显式
 * 列出并给理由；配套的防僵尸断言见 runtime-deps-test（名单里的名字必须
 * 真的在 manifest 里，写错或包已移除时立刻红）。
 */
export const RT_BLOCKED = {
  'react':
    '宿主已有一份 react。装进来的是第二份实例，插件一用就是 Invalid hook call，而报错完全指不到"刚装了运行时依赖"这一步。要换版本请改 package.json 后重新构建。',
  'react-dom':
    '同 react：装进来的是第二份实例，与宿主的渲染器不是同一个，报错同样指不到这里。',
  'react-markdown':
    'CDN 单文件会把 react 一起打进去 —— 那是第二份 react 实例，用它的插件会 Invalid hook call。',
  '@xyflow/react':
    '同上：单文件里自带一份 react，与宿主那份并存即冲突。',
  '@tauri-apps/api':
    '它靠 window.__TAURI_INTERNALS__ 与宿主 Rust 侧通信，版本必须和 Cargo 侧一致。装一份外部版本会"能 import、但所有调用静默失败"。',
  '@plantuml/core':
    '它必须先注入 viz-global.js（classic script）再 import ESM，单文件装进去也用不了；且 ≤1.2026.5 是 GPL-3.0，不能随手换版本。',
};

/**
 * 为什么这条**不能**一键安装；能装则返回 null。
 *
 * canInstall 与它共用这一处判定，不会出现"能装但理由非空"或
 * "不能装却没理由可显示"的不一致 —— 界面要的就是把理由显示出来，
 * 而不是静默地不显示按钮（那样用户只会以为功能没做完）。
 */
export function blockReasonOf(item) {
  if (!item) return null;
  if (item.kind === 'rust') return 'Rust crate 走 cargo，不是运行时能装的。';
  if (item.dev) return '开发时依赖不进打包产物，装了也没人用。';
  // 以 install 字段为准，与 specOf 的口径一致（declared 可能是范围或 null）
  const spec = specOf(item.install);
  if (!spec) return RT_ERR.noSpec;
  /*
   * 用 hasOwnProperty 而不是 `RT_BLOCKED[name] || null`：
   * 后者在理由被写成空串时会当成"没命中"→ 按钮又出现了。
   * 名单命中就该拒绝；理由为空是**缺陷**（界面会出现"没有解释的禁用"），
   * 由测试那条"理由 ≥10 字"兜住，不在这里悄悄兜底成一句提示。
   */
  if (!Object.prototype.hasOwnProperty.call(RT_BLOCKED, spec.name)) return null;
  return RT_BLOCKED[spec.name] || null;
}

/** 哪些条目根本不该出现"一键安装"按钮。 */
export function canInstall(item) {
  return blockReasonOf(item) === null;
}

/**
 * 装了**暂时没人用**的说明。
 * ------------------------------------------------------------
 * 【为什么要单独写一条，而不是照旧只给个安装按钮】
 * 依赖页签目前只有 mermaid 真有插件用 ctx.requireDep 去取运行时那份；
 * 其余可安装的包（rehype-highlight / rehype-slug / remark-gfm 这类
 * 渲染管线包）在构建期就被 Vite 打进了产物，运行时装进去**没有任何
 * 代码会去读它** —— 界面显示"已安装并验证可加载"，而渲染行为一点没变。
 *
 * 这类"装成功但没效果"不报错、不红，用户只会以为功能还没做完。
 * 所以要把话说在按钮之前，而不是让人装完自己发现。
 *
 * 【为什么这类包不做运行时热替换】
 * 渲染管线被四个入口共用（粘贴 / 拖入 / service / 宿主传路径）。
 * 一旦允许"某个入口用运行时版、另一个用打包版"，同一段 md 在两处
 * 渲染出的结果就会不同 —— 那正是 F11 花一整轮修掉的失效形态，
 * 不能为了"换一个语法高亮版本"把它再引进来。
 * 要换这类包的版本：改 package.json 后重新构建。
 */
export const RT_NO_CONSUMER =
  '当前没有插件用 ctx.requireDep 取用运行时版本 —— 装进去暂时不会被用到。' +
  '渲染管线这类包在构建期已打进产物，换版本请改 package.json 后重新构建。';

/**
 * 能装、但装了没人取用时返回说明；有消费方或本来就装不了则返回 null。
 *
 * 装不了的走 blockReasonOf（那是"装了会出事"，比"装了没用"更严重），
 * 这里不重复给第二条说明 —— 两句话挤在一起，反而都不看了。
 */
export function consumerNoteOf(item) {
  if (!item) return null;
  if (!canInstall(item)) return null;
  if ((item.runtimeUsedBy ?? []).length > 0) return null;
  return RT_NO_CONSUMER;
}

/** 调后端命令；命令不存在时返回明确的 noCmd，而不是抛异常后静默。 */
async function callCmd(ctx, cmd, args) {
  if (!ctx || typeof ctx.invoke !== 'function') return { __missing: true };
  try {
    return await ctx.invoke(cmd, args);
  } catch (e) {
    const msg = String((e && (e.message || e)) || '');
    // "command not found" 这一类：说明后端还没接这个能力
    if (/not found|unknown command|不存在|未注册/i.test(msg)) return { __missing: true };
    return { __error: msg || '调用失败' };
  }
}

/** 已装的列表。后端没接时返回空数组（界面据此提示"尚未接入"）。 */
export async function listRuntimeDeps(ctx) {
  const r = await callCmd(ctx, CMD_LIST, {});
  if (r && r.__missing) return { missing: true, list: [] };
  if (r && r.__error) return { missing: false, list: [], error: r.__error };
  const list = (r && (r.list ?? r)) || [];
  return { missing: false, list: Array.isArray(list) ? list : [] };
}

/**
 * 装一个包。
 * 返回 { ok, name, version, file?, error? } —— 不用抛异常表达失败，
 * 因为调用方（界面）要的是把原因显示出来，而不是走 catch 分支后什么都不做。
 *
 * 【装新不清旧 —— 多版本并存留不留由用户决定】
 *
 * 装一个新版本时**不动**同名包的其它版本。旧版本可能是用户特意留着的
 * （回滚用、对比用、或有插件钉住了旧版行为），后台替他删掉，等于替他做了
 * "留哪个"的决定 —— 而界面上他根本看不出来少了什么，只会莫名其妙。
 *
 * 所以这里的契约是：装 = 只写目标文件；留不留 = 用户在界面上逐条点「移除」。
 *
 * ⚠️ 唯一会被覆盖的情况是**同名同版本**（文件名相同）—— 那是"重装"，
 * 不是"清旧"。别把这两件事混在一起做。
 */
export async function installRuntimeDep(ctx, item, opts = {}) {
  if (!canInstall(item)) {
    return { ok: false, error: item && item.kind === 'rust' ? RT_ERR.notSupported : RT_ERR.noSpec };
  }
  const spec = specOf(item.install);
  if (!spec) return { ok: false, error: RT_ERR.noSpec };
  /*
   * 版本优先用调用方给的（界面上用户手填的那个），没有才用声明的。
   * "装哪个版本"交给用户 —— 与多版本共存时"留哪个"交给用户是同一个取舍：
   * 后台替他挑一个，界面上看不出挑了什么。
   */
  const want = String((opts && opts.version) || '').trim() || spec.version;
  const pin = pinnedVersionOf(want);
  /*
   * 复合范围必须在这里明确拒绝。
   * 不拒绝的话会拿 `>=1.0.0 <2` 归一化出来的 `1.0.02` 去下载 → 404，
   * 而错误只显示"下载失败"，用户会去查网络，永远查不到根因。
   */
  if (!pin.ok) return { ok: false, error: RT_ERR.range };
  /*
   * 手填的版本必须以数字开头。
   * 不查的话，填个 `abc` 会拼出 `mermaid@abc/+esm` → 404，
   * 而错误只显示"下载失败"，用户会去查网络 —— 根因却在输入框里。
   */
  if (pin.version && !/^\d/.test(pin.version)) return { ok: false, error: RT_ERR.badVer };
  const r = await callCmd(ctx, CMD_INSTALL, {
    name: spec.name,
    version: pin.version,
    url: entryUrlOf(spec.name, pin.version),
    file: safeFileOf(spec.name, pin.version),
  });

  if (r && r.__missing) return { ok: false, error: RT_ERR.noCmd, missing: true };
  if (r && r.__error) {
    const msg = r.__error;
    // 后端把网络失败与空内容分开报，这里只做归类，不改写原文
    if (/empty|空/i.test(msg)) return { ok: false, error: RT_ERR.empty };
    return { ok: false, error: /http|net|下载|timeout|超时/i.test(msg) ? RT_ERR.network : msg };
  }
  if (!r || r.ok === false) return { ok: false, error: (r && r.error) || RT_ERR.network };
  return {
    ok: true,
    name: spec.name,
    version: pin.version,
    file: (r && r.file) || safeFileOf(spec.name, pin.version),
  };
}

/**
 * 移除一条。
 *
 * ⚠️ 第 4 个参数 file **必须优先用后端 list 给的那个**，不要自己拼。
 *
 * 文件命名规则是两处各写一份（本文件 safeFileOf / Rust 侧 safe_file_of），
 * 靠人工保持一致。一旦哪天规则变了，用 safeFileOf 重新拼出来的名字就会
 * 指向一个**不存在的文件**：后端对"文件不存在"按成功返回（目标是"这条不再
 * 存在"），于是点「移除」后刷新，那条还在 —— 界面上看就是"移除无效"。
 *
 * 而 list 返回的 file 是 deps 目录里**真实存在的名字**，拿它删永远不会
 * 删空、也不会删错。多版本共存时这一点尤其要紧：见 installedVersionsOf()。
 */
export async function removeRuntimeDep(ctx, name, version, file) {
  const f = String(file || '').trim() || safeFileOf(name, version);
  const r = await callCmd(ctx, CMD_REMOVE, { name, version, file: f });
  if (r && r.__missing) return { ok: false, error: RT_ERR.noCmd, missing: true };
  if (r && r.__error) return { ok: false, error: r.__error };
  return { ok: true };
}

/**
 * 这个包**所有**已装的版本。
 *
 * 【为什么不能只取第一个】
 * 清单里的声明版本是会变的（^12.0.0 → ^13.0.0）。换版本后旧文件仍留在
 * deps 目录里，于是同一个包可能装着多份。只 `find(name)` 取第一个的下场是：
 *
 *   界面显示「已装 12.0.0」（排序最小的那个）
 *   点「移除」→ 按**声明版本**拼文件名 → 删掉的是 13.0.0（没显示的那个）
 *   刷新 → 12.0.0 还在 → 用户看到的是"移除失效"
 *
 * 而且那个没被显示的版本从此**没有任何入口能删它**，只能在磁盘上越堆越多。
 * 所以这里返回全部，界面逐条列出、逐条可删。
 */
export function installedVersionsOf(installed, item) {
  const spec = specOf(item && item.install);
  if (!spec) return [];
  const list = Array.isArray(installed) ? installed : [];
  return list.filter((d) => d && d.name === spec.name).slice().sort((x, y) => cmpVersion(x.version, y.version));
}

/**
 * 已装版本里与声明**不符**的那些（旧版本 / 换了声明后残留的）。
 *
 * 返回它们是为了让"该清理"这件事**看得见**：不标出来的话，用户只会看到
 * 列表里有个"已装 X"，无从判断那是当前的还是上一版留下的。
 */
export function staleVersionsOf(installed, item) {
  const spec = specOf(item && item.install);
  const want = normVersion(spec ? spec.version : '');
  /*
   * 声明里没写版本（install 是 `npm i xxx`）时**无法判定**该装哪个 ——
   * 这时返回空，不把已装的都标成"与声明不符"。
   * 无法判定却硬标，界面上就是"装着的每个版本都像错的"，比不标更糟。
   */
  if (!want) return [];
  return installedVersionsOf(installed, item).filter((d) => normVersion(d.version) !== want);
}

/**
 * 把装好的包 import 进来。
 *
 * ⚠️ 这里必须真的 import 一次，不能只检查文件在不在 ——
 * "文件在、import 报错" 是最常见的一种假成功（CDN 给的 ESM 里带了
 * 浏览器不认的语法，或者包本身依赖 node 内建模块）。装完不 import，
 * 用户会在真正用到它的插件里才看到报错，而那时已经不知道是哪一步的问题。
 */
export async function loadRuntimeDep(ctx, name, version, path) {
  const p = path || (await resolveRuntimeDepPath(ctx, name, version));
  if (!p) throw new Error('找不到已安装的依赖文件');
  const url = toAssetUrl(ctx, p);
  return import(/* @vite-ignore */ url);
}

/** 把磁盘路径转成 webview 能加载的地址。 */
export function toAssetUrl(ctx, path) {
  const fn =
    ctx && typeof ctx.convertFileSrc === 'function'
      ? ctx.convertFileSrc
      : typeof globalThis !== 'undefined' &&
        globalThis.__TAURI__ &&
        globalThis.__TAURI__.tauri &&
        globalThis.__TAURI__.tauri.convertFileSrc;
  if (fn) return fn(path, 'asset');
  // 兜底：Windows 上 asset 协议就是 http://asset.localhost/<盘符>/...
  const p = String(path || '').replace(/\\/g, '/');
  return `http://asset.localhost/${p.replace(/^\/+/, '')}`;
}

/** 从已装列表里找某一条的文件路径。 */
export async function resolveRuntimeDepPath(ctx, name, version) {
  const { list } = await listRuntimeDeps(ctx);
  const hit = list.find((d) => d && d.name === name && (!version || d.version === version));
  return hit ? hit.path || hit.file : '';
}

/* ============================================================
   取用（消费侧）—— requireDep
   ============================================================ */

/**
 * 取一个包来用：装过就用装进来的，没装就用打包进产物的那一份。
 *
 * 返回 `{ mod, source, error }`：
 *   source = 'runtime'  用的是 deps/ 里装的那份（可换版本、不必重打包）
 *          = 'bundle'   用的是构建时打进产物那一份（fallback）
 *          = 'none'     两边都没有
 *
 * 【为什么"装了但 import 失败"必须回退，不能报错】
 * 运行时依赖是**增强**，不是基础功能。装的那份坏了（CDN 给的 ESM
 * 带了浏览器不认的语法、或依赖 node 内建模块）就整篇图全挂，
 * 等于把一个可选增强变成了单点故障 —— 用户还得先卸载才能恢复正常。
 * 所以失败一律回退到打包版：功能不降级，只是少了一次可换版本的好处。
 *
 * 【为什么决策要缓存（只定一次来源）】
 * ① 每块图都探测一次：一篇 20 张图就是 20 次 invoke + 20 次 import，
 *    而结论根本不会变。
 * ② 更要紧的是 —— 有些库（mermaid）的 themeVariables 是**模块级全局**。
 *    一会儿用运行时版、一会儿用打包版，两份实例的设置互相踩，
 *    表现为"图偶发画错颜色"，而没人会想到这是加载来源不一致。
 *    所以来源**一次定死**，包括"回退"这个决策本身也要缓存：
 *    不缓存的话每块图都会重试一次坏文件，既慢又可能出现
 *    "前几张用打包版、后几张又尝试运行时版"的混合态。
 *
 * 【为什么探测失败要当作"没装"，而不是抛错】
 * 后端没接这条命令（老版本）、或这次 invoke 失败，都不该让图挂掉 ——
 * 打包版是一定能用的。把它当成"没装"就自动走打包版，行为与老版本一致。
 */
const depDecisions = new Map();

export async function requireDep(ctx, name, opts = {}) {
  const version = String(opts.version || '').trim();
  const key = `${name}@${version || '*'}`;
  const hit = depDecisions.get(key);
  if (hit) return hit;

  const p = decideDep(ctx, name, version, opts).catch((e) => ({
    mod: null,
    source: 'none',
    error: String((e && e.message) || e || '取用失败'),
  }));
  depDecisions.set(key, p);
  return p;
}

async function decideDep(ctx, name, version, opts) {
  const { fallback = null, importModule = defaultImporter } = opts;

  /*
   * 这里**故意不写 try/catch**。
   *
   * 探测失败（后端没接这条命令、或插件没拿到授权）是在更上游被吸收的：
   * callCmd() 把 invoke 的异常转成 `{ __missing }` / `{ __error }`，
   * listRuntimeDeps() 再转成"空列表 + error 字段"，**不抛**。
   *
   * 所以这里拿到的一定是字符串（'' 表示没装）。
   * 早先这里写过一层 try/catch，它**从来不会进入** ——
   * 看起来是兜底，实际是死代码，还会让人以为失败在这里被处理了，
   * 从而忽略上游那处真正的行为（见 runtime-deps-test 第 7 组第 ④ 条）。
   */
  const installed = await resolveRuntimeDepPath(ctx, name, version);

  if (installed) {
    const url = toAssetUrl(ctx, installed);
    try {
      const mod = await importModule(url);
      if (mod) return { mod, source: 'runtime', error: '' };
    } catch (e) {
      /* 落到下面回退 */
      if (!fallback) {
        return { mod: null, source: 'none', error: String((e && e.message) || e) };
      }
      return { mod: await fallback(), source: 'bundle', error: String((e && e.message) || e) };
    }
  }

  if (!fallback) return { mod: null, source: 'none', error: '' };
  try {
    return { mod: await fallback(), source: 'bundle', error: '' };
  } catch (e) {
    return { mod: null, source: 'none', error: String((e && e.message) || e) };
  }
}

function defaultImporter(url) {
  return import(/* @vite-ignore */ url);
}

/** 仅供测试：清掉决策缓存。 */
export function __clearDepDecisions() {
  depDecisions.clear();
}
