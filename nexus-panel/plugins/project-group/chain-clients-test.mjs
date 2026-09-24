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

console.log('\n=== 6. URL 唤起失败时必须真的把指令放进剪贴板 ===');
{
  /*
   * opencode / cursor 走「把指令拼进 URL 直接唤起」这条路，
   * 成功时不需要剪贴板 —— 但**失败**时此前是直接返回：
   *     ok: true, needs_paste: true, "指令已复制"
   * 却**没有调用 set_clipboard**。
   *
   * 后果（最坏的一类静默失败）：
   *   · 用户按提示去粘贴，粘出来的是剪贴板里的**旧内容**；
   *   · ok:true → 前端走成功通道（绿 toast、日志不计错），
   *     看起来完全正常，要等他把错内容粘进 AI 对话框才发现。
   *
   * 所以断言钉的是「失败分支必须真的复制」，而不是「文案里写了已复制」。
   */
  /*
   * 右界用**代码**（下一个顶层函数），不能用 `/// 把模板里的` 这类文档注释：
   * 注释一改写就返回 -1，切片变成空串，而断言看起来还在跑
   * （断言卫生第 2 节专门钉这个）。
   */
  const from = rs.indexOf('pub fn send(');
  const to = rs.indexOf('pub fn fill_template(', from);
  const send = rs.slice(from, to > 0 ? to : undefined);
  t('send 段落取到了', send.includes('opencode'));

  /*
   * 两个专门分支的 else 都必须落到 paste_and_open（那里才真的复制）。
   *
   * 切片**按下一个分支名取界**，不能写死 700 字符：失败分支里那段
   * 说明注释比代码长得多，写死长度会把 paste_and_open 那行切在界外，
   * 于是断言恒假 —— 而它假得毫无声息，看起来像"确实没走降级"。
   */
  for (const [id, next] of [['opencode', '"cursor" =>'], ['cursor', '"vscode" =>']]) {
    const a = send.indexOf(`"${id}" =>`);
    const b = send.indexOf(next, a);
    const block = send.slice(a, b);
    t(`${id} 分支切到了`, b > a && block.length > 0);
    /*
     * 必须在**剥掉注释后**判：那段说明注释里也写了 paste_and_open 五个字，
     * 不剥的话把真实调用删掉、注释留着，这条照样通过（空跑）。
     * 这正是断言卫生第 1 节钉的那一类。
     */
    const blockNC = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    t(`${id} 失败分支走 paste_and_open（代码层，非注释）`,
      /paste_and_open\(def, directory, prompt\)/.test(blockNC));
    /* 反面证据：失败分支里不许再直返一个 ChainSendResult */
    t(`${id} 失败分支不再直返结果`, !/else \{\s*ChainSendResult \{/.test(blockNC));
  }

  /*
   * **反面证据**：整个 match id 里不许再出现"声称已复制却没复制"的直返。
   *
   * 范围**必须限定在 match id 之内** —— 上面自定义客户端那段也有
   * `ok: true ... needs_paste: true ... 指令已复制`，但它在那之前
   * 真的调了 set_clipboard，是合法写法。不限定范围就是误报。
   */
  const matchBlock = send.slice(send.indexOf('match id {'), send.indexOf('fn def_of') > 0 ? send.length : send.length);
  t('match id 内没有谎报"已复制"的直返',
    !/ok: true,[\s\S]{0,160}?needs_paste: true,[\s\S]{0,160}?指令已复制/.test(matchBlock));

  /* 兜底路径本身仍是诚实的：先复制，再按 (opened, copied) 分别出文案 */
  t('paste_and_open 先复制再判成败',
    /fn paste_and_open[\s\S]*?let copied = set_clipboard\(prompt\);[\s\S]*?ok: copied \|\| opened/.test(rs));
}

console.log('\n=== 7. 清单规模 ===');
{
  /* 顺手钉住总数：加/删客户端时这里会响，提醒同步前端说明与文档 */
  t('共 10 个内置客户端', CLIENTS.length === 10, `${CLIENTS.length} 个`);
}

done();
