/**
 * 连锁确认弹窗上的「客户端名」：必须是真会发出去的那个
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/chain-preview-client-test.mjs
 *
 * ## 这一条为什么值得单开一个文件
 *
 * 确认弹窗上写着「动作「X」→ 客户端「Y」」。而 Y 此前由前端自己算：
 *
 *     clientName={boot?.config.chainClient || 'opencode'}
 *
 * 少了「动作专属客户端」那一层。后端 `chain::resolve_client` 的三层是
 * 「动作专属 → 全局默认 → opencode」，于是给某个动作配了自己的客户端时：
 *
 * | | 客户端 |
 * |---|---|
 * | 弹窗显示（旧） | 全局默认 |
 * | 实际发出 | **动作专属** |
 *
 * 弹窗说的是一个、发出去的是另一个。
 *
 * 这跟上一轮修的「确认框看到的文案与发出去的不是同一句」是同一条线：
 * **#43 要的是"看到的与发出的是同一份"，客户端同样是这份保证的一部分**。
 * 而且客户端不同意味着拉起的是**另一个外部 AI 进程**（可能还是另一个账号
 * 与另一份费用），比文案差一个字严重得多。
 *
 * ## 断言的写法要点
 *
 * 只断言"源码里有 client 这几个字"是不够的：
 *   · 它可能返回了 client 却仍是前端自己算的（那样照样漂）；
 *   · 它可能只算了两层（动作专属那一层漏掉正是本 bug）。
 * 所以把 `resolve_client` 切出来**真跑**，并与旧的两层写法对比 ——
 * 在「动作专属 ≠ 全局默认」这组输入上，两者必须给出**不同**的结果，
 * 否则这条断言就证明不了任何事。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
import { stripCommentsFlatJs } from '../../test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const { t, done } = makeT();

/** 剥注释：本文件自己的说明里就写着 `config.chainClient || 'opencode'` 等字样 */
const chain = stripCommentsFlatJs(fs.readFileSync(path.join(ROOT, 'src-tauri/src/fpx/chain.rs'), 'utf8'));
const mod = stripCommentsFlatJs(fs.readFileSync(path.join(ROOT, 'src-tauri/src/fpx/mod.rs'), 'utf8'));
const apiSrc = stripCommentsFlatJs(fs.readFileSync(path.join(HERE, 'api.ts'), 'utf8'));
const hub = stripCommentsFlatJs(fs.readFileSync(path.join(HERE, 'components/DialogsHub.tsx'), 'utf8'));
const hook = stripCommentsFlatJs(fs.readFileSync(path.join(HERE, 'hooks/useChainActions.ts'), 'utf8'));
const panel = stripCommentsFlatJs(fs.readFileSync(path.join(HERE, 'components/ToolsPanel.tsx'), 'utf8'));

/** 按 `pub fn 名(` 起、下一个同级 `pub fn ` 止，切出函数体 */
function bodyOf(src, name) {
  const i = src.indexOf(`pub fn ${name}(`);
  if (i < 0) return '';
  const j = src.indexOf('\npub ', i + 1);
  return src.slice(i, j < 0 ? src.length : j);
}

/* ============ 1. 把 resolve_client 机械改写成可执行 JS ============ */

const rcSrc = bodyOf(chain, 'resolve_client');
t('切到了 chain::resolve_client', rcSrc.includes('pub fn resolve_client'), rcSrc.slice(0, 80));

/**
 * Rust → JS 的机械改写。只处理这个函数实际用到的那几种形态；
 * 一旦源码换写法，下面的"改写后仍含 Rust 残留"这条会立刻报红，
 * 不会退化成"跑了但跑的是别的"。
 */
const rcJs = rcSrc
  .replace(
    /pub fn (\w+)\(([^)]*)\)\s*->\s*[\w&' ]+\s*\{/,
    (_m, name, args) => {
      /*
       * 参数形态是 `cfg: &FpxConfig` / `item: &ChainActionItem`：
       * 按第一个 `:` 截断取名字即可。**不能**用"去前缀空白"的写法，
       * `cfg:` 后面紧跟的是冒号不是空白，那种写法一个都清不掉 ——
       * 于是 `&FpxConfig` 原样留进形参，整段直接 SyntaxError。
       */
      const ps = args
        .split(',')
        .map((a) => a.trim().split(':')[0].trim())
        .join(', ');
      return `function ${name}(${ps}) {`;
    },
  )
  .replace(
    /let (\w+) = (\w+)\.(\w+)\.as_deref\(\)\.map\(str::trim\)\.unwrap_or\(""\);/g,
    'let $1 = (($2.$3) ?? "").trim();',
  )
  .replace(/if !(\w+)\.is_empty\(\) \{ return (\w+)\.to_string\(\); \}/g, 'if ($1 !== "") { return $2; }')
  .replace(/"(\w+)"\.to_string\(\)/g, 'return "$1";');

t('改写后没有 Rust 残留（& / :: / to_string）',
  !/&|::|to_string|as_deref|unwrap_or/.test(rcJs), rcJs.slice(0, 200));

/** 拿到的必须是个能调用的函数，不是源码字符串 */
let resolveClient = null;
try {
  // eslint-disable-next-line no-new-func
  resolveClient = new Function(`${rcJs}; return resolve_client;`)();
} catch (e) {
  resolveClient = null;
}
t('resolve_client 可执行', typeof resolveClient === 'function', String(typeof resolveClient));

/* ============ 2. 三层判据：跑真身 ============ */

const OWN = 'codebuddy';
const GLOBAL = 'cursor';

if (typeof resolveClient === 'function') {
  /* 动作专属非空 → 用它（全局默认被盖掉） */
  t('动作专属优先于全局默认',
    resolveClient({ chain_client: GLOBAL }, { client: OWN }) === OWN,
    resolveClient({ chain_client: GLOBAL }, { client: OWN }));

  /* 动作专属为空 → 全局默认 */
  t('动作专属为空时用全局默认',
    resolveClient({ chain_client: GLOBAL }, { client: null }) === GLOBAL,
    resolveClient({ chain_client: GLOBAL }, { client: null }));

  /* 两层都空 → opencode */
  t('两层都空时回落 opencode',
    resolveClient({ chain_client: null }, { client: null }) === 'opencode',
    resolveClient({ chain_client: null }, { client: null }));

  /* 纯空格等同于空（trim） */
  t('纯空格视为空（trim）',
    resolveClient({ chain_client: '   ' }, { client: '  ' }) === 'opencode',
    resolveClient({ chain_client: '   ' }, { client: '  ' }));

  /* ★ 行为证据：旧的两层写法在同一组输入上给出**不同**的答案 */
  const legacy = (cfg) => cfg.chain_client || 'opencode';
  t('★ 旧的两层写法会漏掉动作专属（与三层判据不同）',
    resolveClient({ chain_client: GLOBAL }, { client: OWN }) !== legacy({ chain_client: GLOBAL }),
    `三层=${resolveClient({ chain_client: GLOBAL }, { client: OWN })} 两层=${legacy({ chain_client: GLOBAL })}`);
}

/* ============ 3. 后端：preview 把 client 一并带回 ============ */

const preview = bodyOf(mod, 'fpx_chain_preview');
t('切到了 fpx_chain_preview', preview.includes('pub fn fpx_chain_preview'));

t('preview 返回 ChainPreview（不是裸 String）',
  />\s*Result<chain::ChainPreview,\s*String>/.test(preview), preview.slice(0, 120));
t('preview 构造时带上 client',
  /Ok\(chain::ChainPreview\s*\{\s*text,\s*client\s*\}\)/.test(preview));
t('preview 的 client 走 chain::resolve_client（与发送侧同一个）',
  /let client = chain::resolve_client\(&cfg,\s*item\);/.test(preview));

const sendAction = bodyOf(mod, 'fpx_chain_send_action');
t('发送侧回落到同一个 chain::resolve_client',
  /chain::resolve_client\(&cfg,\s*&item\)/.test(sendAction));

const structSrc = chain.slice(chain.indexOf('pub struct ChainPreview'));
t('ChainPreview 有 text 与 client 两个字段',
  /pub text: String/.test(structSrc.slice(0, 300)) && /pub client: String/.test(structSrc.slice(0, 300)));

/* ============ 4. 前端：弹窗不再自己推算 ============ */

t('api.chainPreview 返回 ChainPreview 而不是 string',
  /chainPreview:\s*\([^)]*\)\s*=>\s*call<ChainPreview>\('fpx_chain_preview'/.test(apiSrc));

t('DialogsHub 不再按 config.chainClient 推算客户端',
  !/clientName=\{[^}]*config\.chainClient[^}]*\}/.test(hub), 'DialogsHub');
t('DialogsHub 用 pendingSend.client', /clientName=\{pendingSend\.client\}/.test(hub));

t('PendingSend 带 client 字段', /interface PendingSend[\s\S]{0,300}client:\s*string/.test(hub));
t('useChainActions 把后端给的 client 存进 pendingSend',
  /setPendingSend\(\{[^}]*text:\s*r\.text,\s*client:\s*r\.client/.test(hook), hook.slice(0, 60));

/*
 * 面板那条路是**显式传** chosen 的（`chainSendAction` 的第五个参数），
 * 后端按"显式指定优先"用 chosen，所以面板自己算与后端一致 ——
 * 它不该改走 preview 的 client。这条钉住"两条路各有各的正确做法"，
 * 免得以后有人把面板也改成读 preview.client，那反而会丢掉手选覆盖。
 */
t('面板仍显式传 chosen（手选覆盖不被 preview 的 client 顶掉）',
  /chainSendAction\(actionId,\s*kind,\s*target,\s*finalText \|\| null,\s*chosen\)/.test(panel));

/* ============ 5. 兜底：全仓不得再出现"只看全局默认"的客户端推算 ============ */

const dirs = [path.join(HERE, 'components'), HERE, path.join(HERE, 'hooks')];
let bad = 0;
let scanned = 0;
for (const d of dirs) {
  for (const f of fs.readdirSync(d)) {
    if (!/\.tsx?$/.test(f)) continue;
    const src = stripCommentsFlatJs(fs.readFileSync(path.join(d, f), 'utf8'));
    if (!/chainClient/.test(src)) continue;
    scanned += 1;
    /*
     * 「只有 || 'opencode' 兜底、没有动作/本地覆盖那一层」的形状。
     * 面板那条日志文案里也写着 `config.chainClient || 'opencode'`，
     * 但它说的是"默认没变、仍是 X"，不是"将要发给 X"，不该误伤。
     */
    for (const m of src.matchAll(/.{0,60}config\.chainClient\s*\|\|\s*'opencode'/g)) {
      const ctx = m[0];
      if (/clientName=/.test(ctx)) bad += 1;
    }
  }
}
t('扫到了含 chainClient 的前端文件', scanned >= 2, `扫到 ${scanned} 个`);
t('没有别处再把"只看全局默认"当作将要发送的客户端', bad === 0, `命中 ${bad} 处`);

done();
