/**
 * 连锁客户端清单回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：存成 nexus-panel/plugins/project-group/chain-clients-test.mjs，然后
 *         node plugins/project-group/chain-clients-test.mjs
 *
 * 测的是后端 chain.rs::CLIENTS 这份清单本身（#41）。
 * 它看着只是一张常量表，但两处会悄悄腐化：
 *   · id 重复 → 下拉里出现两个同名项，选中的和发出的不是同一个
 *   · scheme 与 id 不一致 → 安装检测（has_scheme）查的是 scheme，
 *     对不上就永远检测不到，客户端"明明装了却不出现在列表里"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '../..');
const { t, done } = makeT();

const rsPath = path.join(ROOT, 'src-tauri/src/fpx/chain.rs');
if (!fs.existsSync(rsPath)) {
  console.log('（跳过：未找到 chain.rs）');
  done();
}
const rs = fs.readFileSync(rsPath, 'utf8');

/** 抓 CLIENTS 数组里的三元组 */
function parseClients(src) {
  const m = src.match(/pub const CLIENTS: &\[\(&str, &str, &str\)\] = &\[([\s\S]*?)\n\];/);
  if (!m) return null;
  const out = [];
  const re = /\("([^"]+)",\s*"([^"]+)",\s*"([^"]+)"\)/g;
  let x;
  while ((x = re.exec(m[1])) !== null) out.push({ id: x[1], name: x[2], scheme: x[3] });
  return out;
}

const CLIENTS = parseClients(rs);

console.log('\n=== 1. 清单解析 ===');
t('能解析出 CLIENTS 数组', Array.isArray(CLIENTS) && CLIENTS.length > 0,
  `${CLIENTS ? CLIENTS.length : 0} 项`);
if (!CLIENTS) { done(); }

console.log('\n=== 2. 唯一性与格式 ===');
{
  const ids = CLIENTS.map((c) => c.id);
  t('id 无重复', new Set(ids).size === ids.length,
    ids.filter((x, i) => ids.indexOf(x) !== i).join(',') || '无');
  const schemes = CLIENTS.map((c) => c.scheme);
  t('scheme 无重复', new Set(schemes).size === schemes.length,
    schemes.filter((x, i) => schemes.indexOf(x) !== i).join(',') || '无');
  t('每条都有名字', CLIENTS.every((c) => c.name.trim()));
  t('id 都是小写连字符风格', CLIENTS.every((c) => /^[a-z][a-z0-9-]*$/.test(c.id)),
    CLIENTS.filter((c) => !/^[a-z][a-z0-9-]*$/.test(c.id)).map((c) => c.id).join(',') || '无');
  t('scheme 不为空格', CLIENTS.every((c) => c.scheme.trim() && !/\s/.test(c.scheme)));
}

console.log('\n=== 3. #41 WorkBuddy 在册 ===');
{
  const wb = CLIENTS.find((c) => c.id === 'workbuddy');
  t('workbuddy 在清单里', !!wb);
  t('显示名为 WorkBuddy', wb?.name === 'WorkBuddy', wb?.name);
  t('scheme 为 workbuddy', wb?.scheme === 'workbuddy', wb?.scheme);
  /* 关键：installed() 对非 vscode 的客户端是按 **scheme** 检测注册情况的
     （has_scheme(def.2)）。scheme 写错 = 永远检测不到 = 装了也不出现在列表里。 */
  t('scheme 与 id 一致（检测走 scheme，写错就永远查不到）',
    wb?.scheme === wb?.id, `${wb?.id} / ${wb?.scheme}`);
  t('注明了它只做导航、走降级路径',
    /只做界面导航|不接收任务/.test(rs));
}

console.log('\n=== 4. 已知的九个原有客户端仍在 ===');
for (const id of ['opencode', 'trae', 'trae-cn', 'cursor', 'vscode',
  'chatgpt', 'claude', 'windsurf', 'kimi']) {
  t(`${id} 仍在册`, CLIENTS.some((c) => c.id === id));
}

console.log('\n=== 5. 与发送逻辑的一致性 ===');
{
  /* send() 只给 opencode / cursor / vscode 写了专门分支，其余走 _ => paste_and_open。
     新增内置客户端若忘了这一点不会报错，只是静默走降级 —— 所以这里确认
     降级路径存在且会用到 scheme。 */
  t('存在 paste_and_open 降级路径', /fn paste_and_open/.test(rs));
  t('降级路径会尝试 scheme://', /open_url\(&format!\("\{\}:\/\/", def\.2\)\)/.test(rs));
  t('降级路径会先复制指令', /let copied = set_clipboard\(prompt\);/.test(rs));
  /* def_of 找不到时回退 opencode —— 清单里必须真有 opencode，否则回退到不存在的客户端 */
  t('def_of 的兜底项 opencode 确实在清单里',
    /unwrap_or\(\("opencode", "opencode", "opencode"\)\)/.test(rs)
    && CLIENTS.some((c) => c.id === 'opencode'));
}

console.log('\n=== 6. 清单规模 ===');
{
  /* 顺手钉住总数：加/删客户端时这里会响，提醒同步前端说明与文档 */
  t('共 10 个内置客户端', CLIENTS.length === 10, `${CLIENTS.length} 个`);
}

done();
