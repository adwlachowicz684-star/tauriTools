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
export const CMD_VERSIONS = 'fpx_rt_dep_versions';
/** 整包卸载（一个包的所有已装文件一次删掉）。 */
export const CMD_PURGE = 'fpx_rt_dep_purge';

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

/**
 * 包名安全化 —— 与 Rust 侧 `safe_name_of` 必须一致。
 *
 * 单列一个函数，是因为**整包卸载要按它算前缀**（见 purgeRuntimeDep）。
 * 前缀规则再写一份就可能和落盘规则漂移：落盘用 `A@`，前缀按 `B@` 判，
 * 结果是整包卸载永远删不到东西、还报成功 —— 界面上就是"清不掉"。
 */
export function safeNameOf(name) {
  return String(name || '').trim().replace(/[@/\\]/g, '_');
}

/**
 * 一个包在 deps 目录里的文件名前缀。
 *
 * ⚠️ 判归属**必须用 `安全名 + "@"`**，不能用 `startsWith(name)`：
 * 包 `md` 的前缀 `md@` 不会误伤 `md-viewer@1.0.0.mjs`；
 * 而按 `startsWith("md")` 判就会把它一起删掉 —— 跨包删除，且被删的
 * 那个在界面上根本没出现过，用户无从察觉。
 */
export function depPrefixOf(name) {
  return `${safeNameOf(name)}@`;
}

/** scoped 包（@scope/name）与斜杠都要换掉，否则会当成目录。 */
export function safeFileOf(name, version) {
  const n = safeNameOf(name);
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
  /*
   * 需要伴生的包取**原始 ESM 文件**，不走 `+esm`。
   * 理由见 RT_CLASSIC：这类包的主体本身就是 ESM，重打包是多余的一次失败面；
   * 而它的伴生必须保持经典脚本形态，两者得走同一套地址规则。
   */
  const spec = classicSpecOf(name);
  if (spec) return rawUrlOf(name, version, spec.esm);
  const pin = pinnedVersionOf(version);
  const v = pin.ok ? pin.version : '';
  const pkg = v ? `${String(name || '')}@${v}` : String(name || '');
  return `${RT_DEP_CDN}/${pkg}/+esm`;
}

/**
 * 需要「经典脚本伴生」的包 —— 包名 → 包内**原始文件名**。
 *
 * 【为什么要单独一张表】
 * 这些包的 ESM 主体自己跑不起来：它依赖一个**不是 ES module** 的文件，
 * 那文件在全局挂变量，必须以普通 `<script>` 加载，且**必须先于** ESM import。
 * 只装主体，插件拿到的是个缺零件的引擎，报错也指不到"少装了伴生"。
 *
 * 【已实测（1.2026.8）】
 *   · plantuml.js   —— 末尾 `export{C as render,D as renderToString}`，
 *                      且**没有任何 import 语句** → 自洽 ESM，直接用原始文件
 *   · viz-global.js —— 全文没有顶层 `export{}`，是 UMD/经典脚本，
 *                      挂全局 Viz 给 plantuml.js 用 → 必须 <script> 加载
 *
 * 【为什么这两个都取原始文件，不走 `+esm`】
 * 主体本来就是 ESM，转不转都一样（还多一次 3.9MB 的重打包，失败面更大）；
 * 伴生**不能**转 —— 转成 ESM 后"挂全局"这个动作就不发生了，
 * 表现为下载成功、引擎却依旧找不到 Viz。
 *
 * 【为什么这里写的是包内文件名，而不是完整 URL】
 * URL 由 classicUrlOf 拼，基址与版本规则只有一处（entryUrlOf 那套）。
 * 各写一份完整 URL 就又是一处命名/地址漂移。
 */
export const RT_CLASSIC = {
  '@plantuml/core': { esm: 'plantuml.js', classic: 'viz-global.js' },
};

/** 需要伴生的包名。 */
export function classicSpecOf(name) {
  return RT_CLASSIC[String(name || '')] || null;
}

/** 伴生在 CDN 上的地址。不需要伴生的包返回 null。 */
export function classicUrlOf(name, version) {
  const spec = classicSpecOf(name);
  if (!spec) return null;
  return rawUrlOf(name, version, spec.classic);
}

/** 包内某个原始文件在 CDN 上的地址（不带 `+esm`）。 */
export function rawUrlOf(name, version, rel) {
  const pin = pinnedVersionOf(version);
  const v = pin.ok ? pin.version : '';
  const pkg = v ? `${String(name || '')}@${v}` : String(name || '');
  return `${RT_DEP_CDN}/${pkg}/${rel}`;
}

/** classic 伴生在 deps 目录里的文件名 —— 与 Rust 侧 classic_file_of 必须一致。 */
export function classicFileOf(name, version) {
  const n = safeNameOf(name);
  const v = normVersion(version);
  return `${n}@${v || 'latest'}.classic.js`;
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
 *
 * 这不是保守：这五条里**每一条的失败都不指向这里**，是本项目最难归因的
 * 那一类。宁可不给按钮，也不能让人踩进去。
 *
 * 注：@plantuml/core **曾经**在这里。它是"ESM 主体 + 经典脚本伴生"的典型，
 * 之前单文件方案确实装不了 —— 现在伴生机制有了（见 RT_CLASSIC），
 * 所以它已从本名单移除。移除的依据是实测过两个文件的形态，不是推测。
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
 * 取某包在 CDN 上的可用版本列表 —— 界面上那个版本下拉的数据来源。
 *
 * 【为什么不缓存】
 * 缓存会让测试互相串味（上一个用例塞进去的值会影响下一个），而它省下的
 * 只是一次网络往返 —— 这个列表只在用户点开版本框时才拉一次。缓存交给
 * 调用方（界面组件）按包名维护。
 *
 * 【为什么失败要返回 error 而不是抛】
 * 拿不到版本列表**不该阻断安装**：用户还能手填。抛出去的话调用方要么
 * try/catch 兜住（很容易漏写），要么整个安装区渲染不出来 —— 那等于把
 * "一个辅助信息没取到"升级成"装不了了"。
 *
 * 【为什么过滤预发布版本】
 * `1.2.3-beta.1` 这类在 CDN 上未必有对应的 ESM 构建，装进去可能是个空壳，
 * 而报错离这一步已经很远。宁可少给几个选项。
 */
export async function fetchRuntimeDepVersions(ctx, name, opts = {}) {
  const n = String(name || '').trim();
  if (!n) return { list: [], error: '包名为空' };
  const r = await callCmd(ctx, CMD_VERSIONS, { name: n });
  if (r && r.__missing) return { missing: true, list: [] };
  if (r && r.__error) return { list: [], error: r.__error };
  const raw = (r && (r.versions ?? r)) || [];
  const list = Array.isArray(raw)
    ? raw.filter((x) => typeof x === 'string' && x && !x.includes('-'))
    : [];
  if (!list.length) return { list: [], error: (r && r.error) || '没取到可用版本' };
  /* 倒序（新在前）+ 截断。排序规则只在 cmpVersion 一处，别再写一份。 */
  const max = opts.max || 30;
  return { list: list.slice().sort((a, b) => cmpVersion(b, a)).slice(0, max) };
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
    /*
     * 伴生地址不需要时必须是**显式 null**，不能省略这个字段。
     * 省略会让后端收到 undefined → 有些桥接层会把它当成"没传"，
     * 于是伴生不下载也不报错：装完显示成功，插件加载才发现缺零件。
     */
    classicUrl: classicUrlOf(spec.name, pin.version),
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
 * 整包卸载：把这个包在工具内部的所有已装文件一次删掉。
 *
 * 【为什么不能只靠逐条 remove】
 * 逐条删要求每一份在界面上都有对应的一行。而"已装但清单里没有"的那些
 * （装过之后又从 package.json 移除）根本不会出现在清单行里 ——
 * 界面看不见，也就删不掉，只能在磁盘上越堆越多。
 * 整包卸载按包名走，与清单是否还有这一项无关。
 *
 * 【removed === 0 不算失败】
 * 目标是"这个包不再存在"，它此前在不在没有意义。报失败会让界面上
 * 出现一个无法恢复的错误态，而用户能做的只有再点一次。
 */
export async function purgeRuntimeDep(ctx, name) {
  const n = String(name || '').trim();
  if (!n) return { ok: false, error: '包名为空' };
  const r = await callCmd(ctx, CMD_PURGE, { name: n });
  if (r && r.__missing) return { ok: false, error: RT_ERR.noCmd, missing: true };
  if (r && r.__error) return { ok: false, error: r.__error };
  const removed = Number((r && (r.removed ?? r)) || 0);
  return { ok: true, removed, files: Array.isArray(r && r.files) ? r.files : [] };
}

/**
 * 已装、但清单里已经没有的那些（残留）。
 *
 * 【为什么会有一类东西】
 * 装过运行时依赖之后，如果它后来被从 package.json 里删掉，
 * js/deps-manifest.js 就不再有这一项 —— DepsCard 是按清单逐行渲染的，
 * 于是它**永远不会被显示出来**：看不见，就删不掉。
 *
 * 【为什么按安全名比对】
 * 后端从文件名还原出的 name 是安全化过的（`_plantuml_core`），
 * 清单里写的是 `@plantuml/core`。直接比字符串会全部判成残留 ——
 * 界面上凭空多出一堆"清单里没有"，而真相只是命名口径不同。
 */
export function orphanDepsOf(installed, manifestNames) {
  const known = new Set((manifestNames || []).map((n) => safeNameOf(n)));
  const list = Array.isArray(installed) ? installed : [];
  return list.filter((d) => d && !known.has(String(d.name)));
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

/** 从已装列表里找某一条（返回整条，含伴生信息）。 */
export async function resolveRuntimeDep(ctx, name, version) {
  const { list } = await listRuntimeDeps(ctx);
  const hit = list.find((d) => d && d.name === name && (!version || d.version === version));
  return hit || null;
}

/** 从已装列表里找某一条的文件路径。 */
export async function resolveRuntimeDepPath(ctx, name, version) {
  const hit = await resolveRuntimeDep(ctx, name, version);
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
  const {
    fallback = null,
    importModule = defaultImporter,
    loadClassic = defaultClassicLoader,
  } = opts;

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
  const hit = await resolveRuntimeDep(ctx, name, version);
  const installed = hit ? hit.path || hit.file : '';

  if (installed) {
    /*
     * 伴生（经典脚本）必须**先于** ESM import 注入。
     *
     * 顺序反了的表现不是"报错说顺序错了"，而是引擎加载成功、一渲染就
     * 报"找不到 Viz" —— 报错离这一步很远，而且看起来像图本身写错了。
     *
     * 只对**确实声明了伴生**的包做这件事：给任意包装一个经典脚本，
     * 等于允许一段未经审查的脚本在宿主上下文里执行。
     */
    if (hit && hit.classicFile && classicSpecOf(name)) {
      try {
        await loadClassic(toAssetUrl(ctx, classicPathOf(hit)));
      } catch (e) {
        /*
         * 伴生注入失败 = 这份运行时依赖不完整，直接回退打包版。
         * 不能带着"缺零件的引擎"继续 —— 那会渲染到一半才失败。
         */
        const msg = `伴生脚本加载失败: ${String((e && e.message) || e)}`;
        if (!fallback) return { mod: null, source: 'none', error: msg };
        return { mod: await fallback(), source: 'bundle', error: msg };
      }
    }

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

/**
 * 伴生文件在磁盘上的完整路径。
 *
 * 优先用后端 list 给的 classicFile（那是从磁盘事实得出的），
 * 没有才按规则拼 —— 与 remove 必须用 list 给的 file 是同一个道理：
 * 自己拼出来的是"应该叫什么"，list 给的是"实际叫什么"。
 */
export function classicPathOf(hit) {
  if (!hit) return '';
  if (hit.classicPath) return hit.classicPath;
  const base = hit.path || hit.file || '';
  if (hit.classicFile && base) {
    const idx = base.lastIndexOf(hit.file || '');
    if (idx >= 0) return base.slice(0, idx) + hit.classicFile;
  }
  return classicFileOf(hit.name, hit.version);
}

/**
 * 以普通 <script> 注入一个地址。
 *
 * async=false 是必须的：默认的 async 会在 DOM 上乱序执行，
 * 而这里的语义就是"必须先执行完再往下走"。
 */
function defaultClassicLoader(url) {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('当前环境没有 document，无法注入经典脚本'));
      return;
    }
    const s = document.createElement('script');
    s.src = url;
    s.async = false;
    s.onload = () => resolve(true);
    s.onerror = () => reject(new Error('伴生脚本加载失败'));
    document.head.appendChild(s);
  });
}

/** 仅供测试：清掉决策缓存。 */
export function __clearDepDecisions() {
  depDecisions.clear();
}
