/**
 * 静态检查：相对导入路径是否存在、关键命名导出是否齐全。
 * 在没有 tsc 的环境里，这是守住"改了文件名忘了改引用"的第一道防线。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const files = [...walk('src'), ...(existsSync('tests') ? walk('tests') : [])];
let problems = 0;
let checked = 0;

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const re = /from\s+['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    checked++;
    const base = resolve(dirname(f), m[1]);
    const cands = [base, base + '.ts', base + '.tsx', join(base, 'index.ts')];
    if (!cands.some((c) => existsSync(c) && statSync(c).isFile())) {
      console.log(`✗ ${f}  →  ${m[1]}  (找不到)`);
      problems++;
    }
  }
}
console.log(`检查了 ${files.length} 个文件、${checked} 条相对导入`);

const need = {
  'src/types.ts': ['Graph', 'TaskNodeData', 'CliKind', 'CLI_META', 'makeNode', 'GraphEdge',
                   'Trigger', 'TriggerKind', 'TriggerConfig', 'TRIGGER_META', 'makeTrigger',
                   'DEFAULT_TRIGGER_CONFIG'],
  'src/engine/runner.ts': ['runGraph', 'Executor', 'RunEvent', 'RunSummary'],
  'src/engine/topo.ts': ['topoLayers'],
  'src/engine/template.ts': ['renderTemplate'],
  'src/engine/cron.ts': ['parseCron', 'nextRun', 'validateCron', 'cronMatches', 'describeCron'],
  'src/engine/triggers.ts': ['TriggerScheduler'],
  'src/lib/tauri.ts': ['runCli', 'killCli', 'startWatch', 'canWatch', 'DonePayload'],
  'src/flowTypes.ts': ['TaskFlowNode'],
};

for (const [file, names] of Object.entries(need)) {
  if (!existsSync(file)) { console.log(`✗ 缺少文件 ${file}`); problems++; continue; }
  const src = readFileSync(file, 'utf8');
  for (const n of names) {
    const re = new RegExp(`export\\s+(default\\s+)?(async\\s+)?(type\\s+|const\\s+|function\\s+|class\\s+)?${n}\\b`);
    if (!re.test(src)) { console.log(`✗ ${file} 未导出 ${n}`); problems++; }
  }
}

// 组件默认导出（供 App.tsx import 使用）
for (const f of ['src/components/TaskNode.tsx', 'src/components/Inspector.tsx',
                 'src/components/Sidebar.tsx',
                 'src/components/CanvasTabs.tsx',
                 'src/components/TriggerNode.tsx',
                 'src/components/ParallelNode.tsx', 'src/App.tsx']) {
  if (!existsSync(f)) { console.log(`✗ 缺少 ${f}`); problems++; continue; }
  const src = readFileSync(f, 'utf8');
  if (!/export\s+default\s+/.test(src)) { console.log(`✗ ${f} 缺少 export default`); problems++; }
}

console.log(problems === 0 ? '✓ 全部通过：导入路径有效、关键导出齐全' : `✗ ${problems} 处问题`);
process.exit(problems ? 1 : 0);
