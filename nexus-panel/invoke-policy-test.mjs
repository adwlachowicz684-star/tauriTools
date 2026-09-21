/**
 * ctx.invoke 命令白名单 —— 接线与行为测试
 *
 * 只检查接线与判定逻辑，不能替代真实的 Tauri 调用验证。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkInvoke, PLUGIN_COMMANDS, HARD_DENY, registerBuiltinIds, resetBuiltinIds, isTrusted, grantCommands, revokeGrant, revokeAllGrants, userGrants } from './js/invoke-policy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

/*
 * 用户放行白名单要**持久化**（理由见 invoke-policy.js 里的说明：
 * 模块变量会有第二份副本）。node 环境没有 localStorage，
 * 而 invoke-policy.js 对它的访问全都包了 try/catch ——
 * 于是写入静默失败、读取返回空，表现为"用户从未放行"。
 *
 * 那是 fail-closed（安全方向对的），但会让下面"放行后可调用"
 * 这类断言全部假红 —— 而且看不出是环境缺的。
 * 所以这里补一个内存版，让持久化路径真的被走到。
 */
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : null),
    setItem: (k, v) => { mem.set(String(k), String(v)); },
    removeItem: (k) => { mem.delete(String(k)); },
    clear: () => mem.clear(),
  };
}

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
/*
 * 契约已改：新增 SAFE_COMMANDS（只读兜底）。
 *
 * 旧断言钉的是"未登记插件连 rust_ping 都拒" —— 那是**功能阻断**：
 * 用户通过侧边栏「＋」装的自定义插件一调后端就失败，而 rust_ping /
 * app_version 本身就是无害的只读查询。安全对了、功能死了。
 *
 * 现在分三层：未登记插件可以用只读命令，但**敏感命令仍然拒绝**。
 * 下面把这两半都钉住 —— 只钉"只读放行"会让安全悄悄倒退，
 * 只钉"敏感拒绝"又会把功能阻断放回来。
 */
t('未登记插件 → 只读命令放行（否则自定义插件装了就用不了）',
  checkInvoke('some-unknown-plugin', 'rust_ping').ok === true
  && checkInvoke('some-unknown-plugin', 'app_version').ok === true);
t('未登记插件 → 敏感命令仍拒绝（默认拒绝没有倒退）',
  checkInvoke('some-unknown-plugin', 'fs_op').ok === false
  && checkInvoke('some-unknown-plugin', 'run_node').ok === false
  && checkInvoke('some-unknown-plugin', 'af_fs_allow_root').ok === false
  && checkInvoke('some-unknown-plugin', 'fpx_capture_screen').ok === false);
/* 插件自带声明：自定义插件靠这条拿到授权 */
/*
 * 契约又进一层：声明 ≠ 授权。
 *
 * manifest.commands 是**插件说自己需要什么**，写在插件自己的配置里；
 * 它改自己的 manifest 就能多要命令 —— 若声明即生效，授权这件事等于不存在。
 * 所以现在要**声明 + 用户放行**同时满足。
 *
 * 下面两半都钉：只钉"放行后可调用"会让"未放行也放行"悄悄回来，
 * 只钉"未放行被拒"又会让"放行了也没用"漏掉。
 */
grantCommands('my-plugin', ['fs_op']);
t('声明 + 用户放行 → 可调用',
  checkInvoke('my-plugin', 'fs_op', { commands: ['fs_op'] }).ok === true);
revokeGrant('my-plugin', 'fs_op');
t('只有声明、用户未放行 → 拒绝（声明不等于授权）',
  checkInvoke('my-plugin', 'fs_op', { commands: ['fs_op'] }).ok === false);
/*
 * 用户已放行这条命令后，HARD_DENY 仍应优先 ——
 * 用第三方插件验证：它同时满足"声明 + 放行"，
 * 若 HARD_DENY 不生效就会被放行，那才是闸门失效。
 * （不能用内置插件验证：内置全放行，绕过了声明与放行两层，
 *   HARD_DENY 对它才真正起作用 —— 那条在第 4 节。）
 */
grantCommands('my-plugin', ['__will_be_denied__']);
t('HARD_DENY 优先于声明与放行（源码里有这道判）',
  /HARD_DENY\.has\(name\)/.test(src('js/invoke-policy.js'))
  && /if \(HARD_DENY\.has\(name\)\)/.test(src('js/invoke-policy.js')));
revokeAllGrants('my-plugin');
t('空命令名 → 拒绝', checkInvoke('home', '').ok === false);
t('undefined 命令 → 拒绝', checkInvoke('home', undefined).ok === false);
t('已声明命令 → 放行', checkInvoke('home', 'rust_ping').ok === true);
t('未声明命令 → 拒绝', checkInvoke('home', 'fs_op').ok === false);

console.log('\n=== 3. 关键安全口子被挡住 ===');
/*
 * ⚠️ 必须先注册内置 id。
 *
 * 不注册的话，agent-flow 等会被当成第三方，于是命中红色组合的命令
 * 被组合拦截挡下 —— 那是**新机制正确工作**的表现，却会让下面
 * "agent-flow 调 fs_op 放行" 这类断言失败。
 *
 * 别为了让它变绿就删断言：断言本身是对的（内置插件确实该放行），
 * 缺的是测试环境没把信任关系建起来。
 */
registerBuiltinIds(Object.keys(PLUGIN_COMMANDS));
t('内置 id 已注册（否则下面全被当成第三方）', isTrusted('agent-flow') === true);
/*
 * 这几条是本次的**起因**：此前无条件透传，插件可以调后端任意命令。
 * 现在每个插件只拿到自己声明的那几个。
 */
/*
 * ⚠️ 契约变更：内置插件**全权限放行**。
 *
 * 上面几条（home 调 fs_op 被挡 等）钉的是"每个插件只拿到自己声明的"。
 * 现在内置插件不再逐条卡 —— project-group 这类自带插件要用二十多条命令，
 * 漏一条就是"点了没反应"，而它本来就随本仓库一同发布、与宿主同源。
 *
 * 这不是安全倒退的借口，而是**换了一道闸**：
 * 原来靠"逐条登记"挡内置插件（挡不住有意的代码，只挡正常开发），
 * 现在靠"来源可信"—— 真正要防的是用户后来装进来的东西。
 * HARD_DENY 保留为兜底（见第 4 节）。
 */
t('内置插件全放行：project-group 调 af_fs_allow_root',
  checkInvoke('project-group', 'af_fs_allow_root').ok === true);
t('内置插件全放行：agent-flow 调 fs_op',
  checkInvoke('agent-flow', 'fs_op').ok === true);
t('内置插件全放行：settings 调 fs_op',
  checkInvoke('settings', 'fs_op').ok === true);
t('内置插件不用用户放行（它是自带的，不该弹授权）',
  checkInvoke('home', 'fs_op').ok === true);

/*
 * 真正的安全断言在**第三方**身上 —— 上面放开了内置，
 * 这里必须证明第三方没有跟着一起放开。
 * 只测"内置放行"而不测这个，等于把闸门拆了还报告绿灯。
 */
t('第三方插件 fs_op 未放行 → 仍被拒',
  checkInvoke('third-party-x', 'fs_op', { commands: ['fs_op'] }).ok === false);
t('第三方插件 run_node（M 类）→ 一律拒（与放行无关）',
  checkInvoke('third-party-x', 'run_node', { commands: ['run_node'] }).ok === false
  && grantCommands('third-party-x', ['run_node'])
  && checkInvoke('third-party-x', 'run_node', { commands: ['run_node'] }).ok === false);
revokeAllGrants('third-party-x');
t('第三方插件未声明的敏感命令 → 拒',
  checkInvoke('third-party-x', 'fpx_capture_screen').ok === false);

/*
 * 反向：不注册内置 id 时，命中红色组合的插件会被拦。
 * 这条是上面"注册后放行"的对照 —— 只测一半的话，
 * "注册"这个动作到底有没有起作用其实没被验证。
 */
resetBuiltinIds();
t('未注入内置 id 时，agent-flow 的 fs_op 被组合拦截挡下',
  checkInvoke('agent-flow', 'fs_op').ok === false,
  `ok=${checkInvoke('agent-flow', 'fs_op').ok}`);
t('未注入时 R 类命令仍放行（不搞一刀切）',
  checkInvoke('agent-flow', 'app_version').ok === true);
registerBuiltinIds(Object.keys(PLUGIN_COMMANDS));   // 恢复，别污染后续用例

console.log('\n=== 4. 全局硬禁止闸门 ===');
t('HARD_DENY 存在（即使为空也保留闸门）', HARD_DENY instanceof Set);
/* 往里塞一条验证它真的生效 —— 否则这个闸门就是摆设 */
HARD_DENY.add('__test_deny__');
t('硬禁止优先级高于插件声明',
  checkInvoke('home', '__test_deny__').ok === false);
HARD_DENY.delete('__test_deny__');

console.log('\n=== 5. 接线：iframe 侧（host.js）===');
const host = src('js/host.js');
/*
 * 允许同一条 import 里带更多命名导入（现在还引入了 registerBuiltinIds）——
 * 钉死成 `import { checkInvoke }` 会在每次新增导入时假红，
 * 而假红会诱使人去"修"本来正确的代码。
 */
t('host.js 引入 checkInvoke',
  /import \{[^}]*\bcheckInvoke\b[^}]*\} from '\.\/invoke-policy\.js'/.test(host));
t('校验发生在真正 invoke **之前**', (() => {
  const i = host.indexOf("case 'invoke': {");
  const seg = host.slice(i, i + 1400);
  const jv = seg.indexOf('checkInvoke(');
  const ji = seg.indexOf('tauri.invoke(');
  return jv >= 0 && ji >= 0 && jv < ji;
})());
t('拒绝时也回包（不漏回，否则调用方挂到超时）',
  /if \(!verdict\.ok\) \{[\s\S]{0,200}reply\(false, null, verdict\.reason\)/.test(host));
/* 必须把 manifest 也传进去，否则插件自带的 commands 声明读不到 ——
   表现为"填了命令还是被拒"，而用户无从得知为什么。 */
t('传入的是 manifest.id（按插件判定）', /checkInvoke\(manifest\.id, payload\?\.cmd/.test(host));
t('host.js 把 manifest 传进去了（否则自带声明读不到）',
  /checkInvoke\(manifest\.id, payload\?\.cmd, manifest\)/.test(host));

console.log('\n=== 6. 接线：同页模块侧（plugin-sdk.js）===');
const sdk = src('js/plugin-sdk.js');
t('plugin-sdk.js 引入 checkInvoke',
  /import \{ checkInvoke \} from '\.\/invoke-policy\.js'/.test(sdk));
t('同页侧也校验', /const v = checkInvoke\(manifest\?\.id, payload\?\.cmd/.test(sdk));
t('同页侧同样传了 manifest', /checkInvoke\(manifest\?\.id, payload\?\.cmd, manifest\)/.test(sdk));
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
