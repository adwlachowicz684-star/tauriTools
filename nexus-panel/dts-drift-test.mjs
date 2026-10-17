/**
 * d.ts 漂移守卫：TS/React 侧 import 的东西，类型声明里必须真的有
 * ================================================================
 * 起因（2026-10 实测）：
 *   js/plugin-config.js 早就导出了 savePluginConfig（界面要用它才知道
 *   "到底存没存成"），src/components/SandboxSection.tsx 第 3 行 import 了它，
 *   但 js/plugin-config.d.ts 里**没有这条声明**。后果是硬失败：
 *
 *     src/components/SandboxSection.tsx(3,27): error TS2724:
 *       '"../../js/plugin-config.js"' has no exported member named
 *       'savePluginConfig'. Did you mean 'setPluginConfig'?
 *
 *   —— **React 侧直接编译不过**，界面整片起不来。
 *   而它之所以能一直躺着：项目里虽有 `npm run typecheck`（tsc --noEmit），
 *   但它不以 `test:` 开头 → sweep 只收 test:* → **从来没被跑过**。
 *
 * 为什么这里不直接跑 tsc
 * ------------------------------------------------------------
 * tsc 在沙盒里会因缺 @types/react 报 TS7016 / TS7026（JSX 命名空间缺失）
 * 一大片环境噪声，真缺陷混在里面没人看；且一次全量约 280 秒，做不了常驻。
 * 这里只做**机械可判定**的那一层：TSX import 了谁、对应 .d.ts 声明没声明。
 *
 * ⚠️ 两条不能越界的判据（都是"把写法当意图"的反面教材）：
 *  1. **只查"TSX 真 import 了的"，不查"js 导出但 d.ts 没声明"。**
 *     host.d.ts 是**有意裁剪过的**公开面（155 行手写，host.js 还有几十个
 *     内部导出不声明）。按"导出必须全声明"扫会报出 9 处，全是误报 ——
 *     逼着补声明等于把内部实现塞进公开类型。
 *  2. **只查"旁边有 .d.ts 的"。**没有 .d.ts 时 tsc 走 allowJs，
 *     是最宽松的隐式 any，不会报错；硬要求补 .d.ts 同样是拿格式当目的。
 *
 * 运行：node dts-drift-test.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsJs } from './test-scan-utils.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/* 汇总行：与 sweep / cwd-invariant 共用同一套解析，不在这里另写一份。 */
let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` → ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` → ${detail}` : ''}`); }
};

/** 递归收集源码文件（跳过 node_modules / 产物目录） */
function walk(dir, out = []) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'runtime-plugins' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/* 具名 import：`import { a, b } from './x.js'` / `import type { a } from '...'`
 * 具名里的 `type` 前缀（`import { type X, y }`）也要剥掉。
 *
 * ⚠️ 剥注释必须在 split 之前：import 花括号里嵌多行注释是常见写法
 * （说明"为什么这几个名字要同源"），不剥的话第一个"名字"会变成
 * 「注释 + 换行 + 真名」，declaredIn 判不出 → 假漂移。
 * 2026-10-17 实测：src/App.tsx 的存储键 import 就这么中过。 */
const IMPORT_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;

/** .d.ts 里"声明了 X"的判据：export 后面的各种形态都算 */
const declaredIn = (dts, name) =>
  new RegExp(`export\\s+(?:declare\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|const|let|var|class|interface|type|enum|namespace)\\s+${name}\\b`)
    .test(dts);

const files = [...walk(join(HERE, 'src')), ...walk(join(HERE, 'plugins'))];
t('扫到了 TS/TSX 源文件（扫描本身没落空）', files.length > 0, `files=${files.length}`);

const drift = [];   // 真漂移：import 了但 .d.ts 没声明
let checkedImports = 0, checkedPairs = 0;

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(src))) {
    const names = stripCommentsJs(m[1]).split(',')
      .map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    const spec = m[2];
    // 只管相对路径、且指向 .js（.ts/.tsx 自带类型，不需要 .d.ts）
    if (!spec.startsWith('.') || !/\.js$/.test(spec)) continue;
    const target = resolve(dirname(f), spec);
    const dts = target.replace(/\.js$/, '.d.ts');
    // 判据 2：没有 .d.ts 就不管（tsc 走 allowJs，本来就不报错）
    if (!existsSync(dts)) continue;
    checkedPairs++;
    const dtsSrc = readFileSync(dts, 'utf8');
    for (const n of names) {
      checkedImports++;
      if (!declaredIn(dtsSrc, n)) {
        drift.push(`${relative(HERE, f)} → ${spec} : ${n}（${relative(HERE, dts)} 里没有）`);
      }
    }
  }
}

t('确实核对到了"有 .d.ts 的 import 对"（范围没被收成空集）',
  checkedPairs > 0 && checkedImports > 0, `pairs=${checkedPairs} imports=${checkedImports}`);

t('TS/React import 的每个名字，对应 .d.ts 里都声明了（漏了就是 TS2724，编译不过）',
  drift.length === 0, drift.join(' | '));

/* ---------------- 元断言：判据本身不能是空转 ----------------
 * 上面那条"drift.length === 0"在**样本被删光**时照样绿 —— 集合空了，
 * 断言恒真。所以必须钉住"已知的那一处确实能被判出来"。
 *
 * 用真实文件做样本：plugin-config.d.ts 现在**有** savePluginConfig，
 * 从声明文本里把它抠掉再判，判据必须认不出来（说明它真在比对着名字），
 * 而不是比对着别的东西。少了这条，判据写错也永远绿。
 */
const PC_DTS = join(HERE, 'js/plugin-config.d.ts');
if (existsSync(PC_DTS)) {
  const dtsSrc = readFileSync(PC_DTS, 'utf8');
  const withIt = declaredIn(dtsSrc, 'savePluginConfig');
  const without = dtsSrc.replace(/export function savePluginConfig\(/g, 'export function __removed__(');
  t('判据认得出现有声明 savePluginConfig（剥掉后必须认不出，判据没在空转）',
    withIt === true && declaredIn(without, 'savePluginConfig') === false);
} else {
  t('判据认得出现有声明 savePluginConfig（剥掉后必须认不出，判据没在空转）', false, 'js/plugin-config.d.ts 不见了');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
