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
  removed: '已移除',
};

/** scoped 包（@scope/name）与斜杠都要换掉，否则会当成目录。 */
export function safeFileOf(name, version) {
  const n = String(name || '').trim().replace(/[@/\\]/g, '_');
  const v = String(version || '').trim().replace(/[^0-9A-Za-z._-]/g, '');
  return `${n}@${v || 'latest'}.mjs`;
}

/** CDN 上取 ESM 单文件的地址。 */
export function entryUrlOf(name, version) {
  const v = String(version || '').trim();
  const pkg = v ? `${name}@${v}` : String(name || '');
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

/** 哪些条目根本不该出现"一键安装"按钮。 */
export function canInstall(item) {
  if (!item) return false;
  if (item.kind === 'rust') return false; // crate 走 cargo，不是运行时能装的
  if (item.dev) return false; // 开发时依赖不进产物，装了也没人用
  return !!specOf(item.install);
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
 */
export async function installRuntimeDep(ctx, item) {
  if (!canInstall(item)) {
    return { ok: false, error: item && item.kind === 'rust' ? RT_ERR.notSupported : RT_ERR.noSpec };
  }
  const spec = specOf(item.install);
  const r = await callCmd(ctx, CMD_INSTALL, {
    name: spec.name,
    version: spec.version,
    url: entryUrlOf(spec.name, spec.version),
    file: safeFileOf(spec.name, spec.version),
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
    version: spec.version,
    file: (r && r.file) || safeFileOf(spec.name, spec.version),
  };
}

export async function removeRuntimeDep(ctx, name, version) {
  const r = await callCmd(ctx, CMD_REMOVE, { name, version, file: safeFileOf(name, version) });
  if (r && r.__missing) return { ok: false, error: RT_ERR.noCmd, missing: true };
  if (r && r.__error) return { ok: false, error: r.__error };
  return { ok: true };
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
