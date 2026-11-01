/**
 * 可安装插件的 manifest（nexus.plugin.json）—— 定义与校验
 * ============================================================
 * 为什么要有这个文件
 * ------------------------------------------------------------
 * 装进来的插件需要一个「自描述」：我是谁、入口在哪、什么版本。
 * 宿主扫到目录后读它就认得这是个插件，不必改任何静态清单。
 *
 * ⚠️ 本模块最重要的一条设计约束：manifest 是**插件自己写的**
 * ------------------------------------------------------------
 * 因此它**只能承载声明性信息**（id / name / version / entry …），
 * 一律不承载任何影响信任判定的字段。
 *
 * 反面教材就在本仓库里（js/invoke-policy.js:406）：
 *   「为什么不能用 manifest.builtin —— 那是插件自己写的字段，
 *     恶意插件只要写 `builtin: true` 就能拿到豁免。」
 *
 * 所以本模块对下面这些字段的处理是**明确忽略**，不是「暂不支持」：
 *   · builtin / trusted / permissions（作为权限依据）
 *   —— 权限由宿主按**来源**决定（内置 vs 远程安装），见
 *      js/invoke-policy.js 的 registerBuiltinIds()：远程装的 id 永远
 *      进不去那个集合，天然被判 third → enforce。
 *
 * 那 permissions 为什么还保留在字段表里？
 *   只作**展示**用（装之前给用户看「本插件会用到这些能力」），
 *   不参与任何授权判定。展示和授权必须分开，混一起就是提权漏洞。
 */

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** manifest 文件名（固定，扫目录时认这个名字） */
export const MANIFEST_FILE = 'nexus.plugin.json';

/** 已安装插件目录名（相对项目根）。
 *
 * ⚠️ 必须独立于 runtime-plugins/：
 *   后者是**构建产物目录**（scripts/build-plugins.mjs 的输出），
 *   跑一次构建就会被覆盖清理 —— 装进去的插件下次构建全没了。 */
export const INSTALLED_PLUGINS_DIR = 'installed-plugins';

/** 必填字段 */
export const REQUIRED_FIELDS = ['id', 'name', 'version', 'entry'];

/** kind 取值：与 registry.js 现有语义一致 */
export const KIND_APP = 'app';
export const KIND_SERVICE = 'service';
export const KINDS = [KIND_APP, KIND_SERVICE];

/**
 * id 规则：小写字母数字，内部可含单短横线，不以横线开头/结尾。
 *
 * 为什么要限死：
 *   id 会进目录名、进 localStorage key、进 IPC 命令参数 ——
 *   允许 `/` 或 `..` 就等于允许路径穿越，允许大小写就等于
 *   Windows 上 `Foo` 与 `foo` 两个目录指同一个插件。
 */
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** id 长度上限（目录名与展示都要用，别让恶意 manifest 塞 4KB） */
const ID_MAX = 64;

/** semver 宽松校验：主.次.修，允许 v 前缀与预发布标签 */
const VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

/**
 * 校验一个 manifest 对象（**纯函数**，不碰文件系统，便于测试）。
 *
 * @param {unknown} raw  解析后的 JSON 对象（调用方负责 JSON.parse）
 * @param {object} [opts]
 * @param {string} [opts.dirName]  所在目录名，用于「目录名必须等于 id」的校验
 * @param {string[]} [opts.reservedIds]  保留 id（内置插件），冲突即拒绝
 * @returns {{ok: boolean, errors: string[], warnings: string[], manifest: object|null}}
 *          errors 非空即拒绝；warnings 只是提示，不阻断安装。
 *
 * 为什么返回 errors 数组而不是抛异常：
 *   安装界面要一次列清所有问题（缺 id + entry 越界 + 版本不合法），
 *   抛异常只能报第一条，用户得改一次提交一次。
 */
export function validateManifest(raw, opts = {}) {
  const errors = [];
  const warnings = [];
  const reserved = new Set(opts.reservedIds || []);

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['manifest 不是对象'], warnings, manifest: null };
  }

  /* ---- 必填 ---- */
  for (const f of REQUIRED_FIELDS) {
    if (raw[f] === undefined || raw[f] === null || raw[f] === '') {
      errors.push(`缺必填字段: ${f}`);
    }
  }

  /* ---- id ---- */
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (id) {
    if (id.length > ID_MAX) errors.push(`id 超长（>${ID_MAX}）`);
    else if (!ID_RE.test(id)) errors.push(`id 不合法（只允许小写字母数字与短横线）: ${id}`);
    if (reserved.has(id)) errors.push(`id 与内置插件冲突: ${id}`);
  }

  /* ---- 目录名必须等于 id ---- */
  if (opts.dirName && id && opts.dirName !== id) {
    errors.push(`目录名与 id 不一致: 目录=${opts.dirName} id=${id}`);
  }

  /* ---- version ---- */
  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  if (version && !VERSION_RE.test(version)) {
    errors.push(`version 不是 semver: ${version}`);
  }

  /* ---- entry（安全关键）---- */
  const entry = typeof raw.entry === 'string' ? raw.entry.trim() : '';
  if (entry) {
    if (entry.startsWith('/') || /^[A-Za-z]:[\\/]/.test(entry)) {
      errors.push(`entry 必须是相对路径: ${entry}`);
    } else if (entry.split(/[\\/]/).includes('..')) {
      /* 路径穿越：恶意插件用 entry: '../../../etc/passwd' 跳出插件目录，
       * 让宿主把任意文件当插件入口加载。 */
      errors.push(`entry 含 ..（路径穿越）: ${entry}`);
    } else if (!/\.(html?|js|mjs)$/i.test(entry)) {
      /* 只接受 HTML/JS 入口：可安装插件一律 iframe 形态（D4）。
       * 放 .tsx/.json/.md 进来说明 manifest 写错了，或有人在试探。 */
      errors.push(`entry 必须是 .html/.js/.mjs（可安装插件一律 iframe）: ${entry}`);
    }
  }

  /* ---- kind ---- */
  const kind = raw.kind === undefined ? KIND_APP : raw.kind;
  if (!KINDS.includes(kind)) {
    errors.push(`kind 只能是 ${KINDS.join(' / ')}: ${kind}`);
  }

  /* ---- 自报的权限/信任字段：明确忽略 ---- */
  for (const banned of ['builtin', 'trusted', 'isBuiltin', 'privileged']) {
    if (raw[banned] !== undefined) {
      warnings.push(`忽略自报字段 ${banned}（信任由宿主按来源判定，不由插件声明）`);
    }
  }

  /* ---- 未知字段：忽略但提示（前向兼容，别让新版 manifest 装不进来）---- */
  const known = new Set([
    'id', 'name', 'version', 'entry', 'kind', 'icon', 'description',
    'minHost', 'repo', 'ref', 'homepage', 'author', 'license', 'permissions',
  ]);
  for (const k of Object.keys(raw)) {
    if (!known.has(k)) warnings.push(`未知字段已忽略: ${k}`);
  }

  if (errors.length) return { ok: false, errors, warnings, manifest: null };

  return {
    ok: true,
    errors,
    warnings,
    manifest: {
      /* 只回白名单字段：不带任何插件自报的额外内容进宿主。
       * 少带一个字段顶多丢展示，多带一个字段可能就是提权。 */
      id,
      name: String(raw.name),
      version,
      entry,
      kind,
      icon: typeof raw.icon === 'string' ? raw.icon : '◻',
      description: typeof raw.description === 'string' ? raw.description : '',
      minHost: typeof raw.minHost === 'string' ? raw.minHost : null,
      repo: typeof raw.repo === 'string' ? raw.repo : null,
      ref: typeof raw.ref === 'string' ? raw.ref : null,
      homepage: typeof raw.homepage === 'string' ? raw.homepage : null,
      author: typeof raw.author === 'string' ? raw.author : null,
      license: typeof raw.license === 'string' ? raw.license : null,
      /* 展示用，不参与授权判定（见文件头说明） */
      permissions: Array.isArray(raw.permissions)
        ? raw.permissions.filter((x) => typeof x === 'string')
        : [],
    },
  };
}

/* ------------------------------------------------------------------ *
 * 合并进静态注册表
 * ------------------------------------------------------------------ */

/**
 * 把已安装插件合并进静态注册表。
 *
 * @param {object[]} staticPlugins  registry.js 的静态部分
 * @param {object[]} installed      validateManifest 产出的 manifest（已校验）
 * @returns {{plugins: object[], skipped: Array<{id:string, reason:string}>}}
 *
 * 冲突策略：**静态优先**。
 *   内置插件（home / settings / md …）是外壳的一部分，
 *   装进来的插件不能顶掉它 —— 否则用户装一个 id 叫 `settings`
 *   的插件就能把设置页换掉，这是提权。
 *
 * 安装目录内的插件一律标记为 installed: true、builtin: 不设
 *   （builtin 由宿主的 registerBuiltinIds 决定，这里不写，
 *    写了也只是装饰，反而误导 —— 见文件头）。
 */
export function mergeInstalled(staticPlugins, installed) {
  const out = (Array.isArray(staticPlugins) ? staticPlugins : []).slice();
  const skipped = [];
  const seen = new Set(out.map((p) => p && p.id).filter(Boolean));

  for (const m of Array.isArray(installed) ? installed : []) {
    if (!m || !m.id) {
      skipped.push({ id: String((m && m.id) || '(无 id)'), reason: 'manifest 无效' });
      continue;
    }
    if (seen.has(m.id)) {
      skipped.push({ id: m.id, reason: 'id 与已注册插件冲突（静态优先）' });
      continue;
    }
    seen.add(m.id);
    out.push({
      id: m.id,
      name: m.name,
      icon: m.icon,
      /* 可安装插件一律 iframe（D4）：module 形态依赖 import.meta.glob
       * 编译期绑定，装进来也不会被收进产物。 */
      type: 'iframe',
      entry: m.entry,
      kind: m.kind,
      description: m.description,
      installed: true,
      /* 元信息，供更新与卸载用 */
      version: m.version,
      repo: m.repo,
      ref: m.ref,
    });
  }
  return { plugins: out, skipped };
}
