/**
 * ctx.invoke 命令白名单 —— 接线与行为测试
 *
 * 只检查接线与判定逻辑，不能替代真实的 Tauri 调用验证。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkInvoke, PLUGIN_COMMANDS, HARD_DENY } from './js/invoke-policy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  if (cond) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.log(`❌ ${name}`); }
};

console.log('=== 1. 白名单本身 ===');
t('白名单非空', Object.keys(PLUGIN_COMMANDS).length > 0);
t('home 只声明了它真实用到的命令',
  JSON.stringify(PLUGIN_COMMANDS.home) === JSON.stringify(['rust_ping', 'app_version']));
t('settings 拿到 af_fs_*（授权目录管理是它的职责）',
  PLUGIN_COMMANDS.settings.includes('af_fs_allow_root')
  && PLUGIN_COMMANDS.settings.includes('af_fs_list_roots'));
t('project-group 拿到 fpx_* 全套（它确实要用）',
  PLUGIN_COMMANDS['project-group'].includes('fpx_bootstrap')
  && PLUGIN_COMMANDS['project-group'].includes('fpx_save_config'));

console.log('\n=== 2. 判定逻辑：默认拒绝 ===');
t('未登记插件 → 全部拒绝（默认拒绝，不是默认放行）',
  checkInvoke('some-unknown-plugin', 'rust_ping').ok === false);
t('空命令名 → 拒绝', checkInvoke('home', '').ok === false);
t('undefined 命令 → 拒绝', checkInvoke('home', undefined).ok === false);
t('已声明命令 → 放行', checkInvoke('home', 'rust_ping').ok === true);
t('未声明命令 → 拒绝', checkInvoke('home', 'fs_op').ok === false);

console.log('\n=== 3. 关键安全口子被挡住 ===');
/*
 * 这几条是本次的**起因**：此前无条件透传，插件可以调后端任意命令。
 * 现在每个插件只拿到自己声明的那几个。
 */
t('home 调 fs_op（写删文件）被挡', checkInvoke('home', 'fs_op').ok === false);
t('home 调 run_node（拉子进程）被挡', checkInvoke('home', 'run_node').ok === false);
t('mindmap 调 af_fs_allow_root（给自己授权目录=提权）被挡',
  checkInvoke('mindmap', 'af_fs_allow_root').ok === false);
t('project-group 调 af_fs_allow_root 被挡（授权只归 settings）',
  checkInvoke('project-group', 'af_fs_allow_root').ok === false);
t('demo-iframe 调 fpx_backup 被挡', checkInvoke('demo-iframe', 'fpx_backup').ok === false);
t('agent-flow 调 fs_op 放行（它确实要用）', checkInvoke('agent-flow', 'fs_op').ok === true);
t('settings 调 fs_op 被挡（它没声明）', checkInvoke('settings', 'fs_op').ok === false);

console.log('\n=== 4. 全局硬禁止闸门 ===');
t('HARD_DENY 存在（即使为空也保留闸门）', HARD_DENY instanceof Set);
/* 往里塞一条验证它真的生效 —— 否则这个闸门就是摆设 */
HARD_DENY.add('__test_deny__');
t('硬禁止优先级高于插件声明',
  checkInvoke('home', '__test_deny__').ok === false);
HARD_DENY.delete('__test_deny__');

console.log('\n=== 5. 接线：iframe 侧（host.js）===');
const host = src('js/host.js');
t('host.js 引入 checkInvoke', /import \{ checkInvoke \} from '\.\/invoke-policy\.js'/.test(host));
t('校验发生在真正 invoke **之前**', (() => {
  const i = host.indexOf("case 'invoke': {");
  const seg = host.slice(i, i + 1400);
  const jv = seg.indexOf('checkInvoke(');
  const ji = seg.indexOf('tauri.invoke(');
  return jv >= 0 && ji >= 0 && jv < ji;
})());
t('拒绝时也回包（不漏回，否则调用方挂到超时）',
  /if \(!verdict\.ok\) \{[\s\S]{0,200}reply\(false, null, verdict\.reason\)/.test(host));
t('传入的是 manifest.id（按插件判定）', /checkInvoke\(manifest\.id, payload\?\.cmd\)/.test(host));

console.log('\n=== 6. 接线：同页模块侧（plugin-sdk.js）===');
const sdk = src('js/plugin-sdk.js');
t('plugin-sdk.js 引入 checkInvoke',
  /import \{ checkInvoke \} from '\.\/invoke-policy\.js'/.test(sdk));
t('同页侧也校验', /const v = checkInvoke\(manifest\?\.id, payload\?\.cmd\)/.test(sdk));
/* 诚实标注：同文档下插件可绕过，这层是纵深防御不是硬边界 */
t('注释说明了同页侧不是硬边界（不夸大）',
  /真正的硬边界在 iframe 侧/.test(sdk));

console.log('\n=== 7. 宿主内部调用不受影响 ===');
/*
 * 外壳自己调 window_action 是**直接** tauri.invoke，不走 ctx.invoke，
 * 不该被插件白名单挡住 —— 否则标题栏按钮全会失效。
 */
t('宿主内部 window_action 不走 ctx.invoke 通道',
  /await tauri\.invoke\('window_action', \{ action \}\)/.test(host));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
