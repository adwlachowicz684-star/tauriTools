/**
 * 依赖副本守卫 —— 防止「装出第二份 react」把渲染整条线打哑。
 *
 * 起因（本轮实测）：`npm i react-markdown@^10.1.0` 之后，npm 在
 * `node_modules/react-markdown/node_modules/` 下放了一份 **react 19.3.1**，
 * 与顶层声明的 18.3.1 并存。
 *
 * 后果不是报错，是**静默错值**：两份 react 各自持有自己的元素符号，
 * react-markdown 用 19 那份造元素，react-dom 18 那份去渲染，
 * 服务端渲染直接抛「Objects are not valid as a React child」——
 * 于是 md-render 这一个服务**整条不可用**，而依赖清单是绿的、
 * 语法是对的、单测里除了真渲染那几条全都过。
 *
 * 同一类事故在本项目已第三次出现（前两次是别的包自带副本，
 * 表现是若干测试直接崩在半路）。所以这里把「不得有第二份」钉成判据，
 * 而不是每次靠人眼在 node_modules 里翻。
 */
import { readFileSync, existsSync, readdirSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0; let fail = 0;
const t = (name, ok, info) => {
  if (ok) { pass++; console.log(`✅ ${name}${info ? ` → ${info}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${info ? ` → ${info}` : ''}`); }
};

/* ---------- 判据：找出 node_modules 下的所有 react / react-dom 副本 ---------- */

/*
 * 只往下挖 4 层：npm 的嵌套副本就在 `node_modules/<pkg>/node_modules/<dep>`，
 * 再深的目录是依赖自己的依赖，扫下去既慢又会撞上大量无关目录。
 *
 * 跳过 .bin：那里是软链不是包，且遍历它会碰到断链（第 5 节的老坑）。
 */
const MAX_DEPTH = 4;

function findCopies(root) {
  const out = [];
  const seen = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === '.bin' || e.name === '.package-lock.json') continue;
      const p = join(dir, e.name);
      /*
       * 必须连软链一起认：本项目的 node_modules/react 就是指向全局的软链，
       * 而 readdirSync(withFileTypes) 对软链返回 isSymbolicLink()、不是
       * isDirectory()。只认目录的话顶层那一份**根本进不了列表**，
       * 于是"没有第二份"永远绿 —— 判据漏扫自己，比漏扫别人更难发现。
       */
      /*
       * @types/react 只是类型声明、不参与运行时，且 npm 常给它单独装一份
       * （本仓实测 19.3.0）。把它算成"第二份 react"会报假红 ——
       * 而假红最烦人的地方是诱使人去改本来对的东西（这里就是真去删类型包）。
       */
      const parentName = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      if ((e.name === 'react' || e.name === 'react-dom')
        && parentName !== '@types'
        && (e.isDirectory() || e.isSymbolicLink())) {
        let ver = null;
        try { ver = JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')).version; } catch { /* 读不到就记 null */ }
        out.push({ path: p, version: ver });
        continue;
      }
      if (e.isDirectory() || e.isSymbolicLink()) walk(p, depth + 1);
    }
  };
  walk(root, 0);
  seen.push(root);
  return out;
}

/* 顶层那一份的判定：路径里只出现一次 node_modules 段 */
function isTopLevel(p) {
  const parts = p.split(/[\\/]/);
  return parts.filter((x) => x === 'node_modules').length === 1;
}

function major(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d+)/.exec(v);
  return m ? Number(m[1]) : null;
}

/* ---------- 前置 ---------- */

const nm = join(HERE, 'node_modules');
t('（前置）node_modules 存在 —— 不存在的话下面全是假绿', existsSync(nm),
  existsSync(nm) ? nm.replace(HERE, '') : '缺 node_modules，先 npm i');

const pkgText = existsSync(join(HERE, 'package.json'))
  ? readFileSync(join(HERE, 'package.json'), 'utf8') : '';
const declared = (() => {
  try {
    const p = JSON.parse(pkgText);
    return { react: p?.dependencies?.react || null, reactDom: p?.dependencies?.['react-dom'] || null };
  } catch { return { react: null, reactDom: null }; }
})();
t('（前置）package.json 声明了 react 与 react-dom', !!declared.react && !!declared.reactDom,
  `react ${declared.react} / react-dom ${declared.reactDom}`);

/* ---------- 第 1 节：顶层版本必须合声明 ---------- */

const copies = existsSync(nm) ? findCopies(nm) : [];
const topReact = copies.find((c) => isTopLevel(c.path) && /[\\/]react$/.test(c.path));
const topReactDom = copies.find((c) => isTopLevel(c.path) && /[\\/]react-dom$/.test(c.path));

t('顶层 react 存在', !!topReact, topReact ? topReact.version : '未安装');
t('顶层 react-dom 存在', !!topReactDom, topReactDom ? topReactDom.version : '未安装');

const wantMajor = major(String(declared.react || '').replace(/[^0-9.]/g, ''));
t('顶层 react 的主版本与声明一致', !!topReact && major(topReact.version) === wantMajor,
  `声明 ${declared.react} → 要 ${wantMajor} 主版本，实际 ${topReact ? topReact.version : '—'}`);
t('顶层 react 与 react-dom 同版本（不同版本就是两份渲染器）',
  !!topReact && !!topReactDom && topReact.version === topReactDom.version,
  topReact && topReactDom ? `react ${topReact.version} / react-dom ${topReactDom.version}` : '—');

/* ---------- 第 2 节：不得有第二份 ---------- */

const nested = copies.filter((c) => !isTopLevel(c.path));
t('node_modules 里没有第二份 react / react-dom ★', nested.length === 0,
  nested.length === 0
    ? `共 ${copies.length} 份（均为顶层）`
    : nested.map((c) => `${c.path.replace(HERE + '/', '')}@${c.version ?? '?'}`).join(' | '));

/*
 * 版本不一致比"多一份"更隐蔽：两份都是 18 时未必炸，
 * 一旦某份是 19，元素符号就换了族，渲染器认不出对方造的元素。
 */
const offMajor = nested.filter((c) => major(c.version) !== null && major(c.version) !== wantMajor);
t('第二份（若有）不得与主声明差主版本 ★', offMajor.length === 0,
  offMajor.length === 0 ? '无跨主版本副本' : offMajor.map((c) => `${c.path.replace(HERE + '/', '')}@${c.version}`).join(' | '));

/* ---------- 第 3 节：自检 —— 判据必须抓得住 ---------- */

/*
 * 造一棵假的 node_modules：顶层一份 18、嵌套一份 19，
 * 判据若认不出来，说明它自己失明了 —— 那"0 份"就是假绿。
 *
 * 用 os.tmpdir() 而不是仓库内目录：不往工作区留垃圾，
 * 也避免落进 sweep 的扫描范围（第 7 节 fixedScratchDirs 那条）。
 */
const scratch = join(tmpdir(), 'nexus-dup-react-selfcheck');
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, 'node_modules', 'react'), { recursive: true });
mkdirSync(join(scratch, 'node_modules', 'react-dom'), { recursive: true });
mkdirSync(join(scratch, 'node_modules', 'demo-pkg', 'node_modules', 'react'), { recursive: true });
writeFileSync(join(scratch, 'node_modules', 'react', 'package.json'), '{"version":"18.3.1"}');
writeFileSync(join(scratch, 'node_modules', 'react-dom', 'package.json'), '{"version":"18.3.1"}');
writeFileSync(join(scratch, 'node_modules', 'demo-pkg', 'node_modules', 'react', 'package.json'),
  '{"version":"19.3.1"}');

const fakeCopies = findCopies(join(scratch, 'node_modules'));
const fakeNested = fakeCopies.filter((c) => !isTopLevel(c.path));
t('自检：能识别出伪造的嵌套副本（否则第 2 节恒绿）', fakeNested.length === 1,
  `识别出 ${fakeNested.length} 份 → ${fakeNested.map((c) => c.path.replace(scratch + '/', '')).join(',') || '（没认出来，第 2 节是假绿）'}`);
t('自检：能读出嵌套副本的版本号', fakeNested.length === 1 && fakeNested[0].version === '19.3.1',
  fakeNested.length === 1 ? String(fakeNested[0].version) : '—');
rmSync(scratch, { recursive: true, force: true });
t('自检：临时样本用完即撤', !existsSync(scratch), '已删除');

/* ---------- 第 4 节：反向说明 ---------- */

/*
 * 症状说明（不作为断言 —— 用 `t(..., true, ...)` 写说明是占位式恒真，
 * 会被断言卫生守卫判成"冒充通过"；说明就该是注释，不该占一条通过）：
 *   react-markdown 用副本造元素 → 顶层 react-dom 渲染 →
 *   "Objects are not valid as a React child"
 * 所以判据盯的是"有没有第二份"，而不是"渲染报不报错"。
 */

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
