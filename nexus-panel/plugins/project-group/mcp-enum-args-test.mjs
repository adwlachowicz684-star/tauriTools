/**
 * MCP「枚举型参数」必须校验，不能静默降级（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/mcp-enum-args-test.mjs
 *
 * tools/list 里声明了 `enum` 的参数，运行时**必须**对非法值报错。
 * 不校验的后果分两种，都不报错，只是做成了另一件事：
 *
 *   · 静默落到默认值 —— backup 传 "Group" 会去备份**项目**（想备份的
 *     项目组一个没动），而 summary() 不含类别，回包里没有任何字段
 *     能让人发现备份错了对象。等要恢复时才发现备份里没有。
 *
 *   · 走到没有 else 的并列 if —— scan_content 传 "skills" 时三个
 *     `if all || kind == "x"` 全不匹配，返回**空数组**。空数组是断言性
 *     的：AI 读成"这个项目组下没有任何 skill"，可能据此再去建一个，
 *     而真相只是参数拼错。
 *
 * 两者的共同点、也是本轮的主题：**回包主动给出了与事实相反的判断**。
 * 比什么都不返回更糟 —— 后者调用方还会重试，前者他直接照着错结论行动。
 *
 * 正确模板就在 create_folder 里（三分支 match + return Err），
 * add_card 上轮已按它补齐；本轮补 backup 与 scan_content。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RS = path.join(HERE, '..', '..', 'src-tauri', 'src', 'fpx');
const { t, done } = makeT();

const read = (f) => fs.readFileSync(path.join(RS, f), 'utf8');
/** 剥块注释：断言只看真代码，否则会被注释里的同名字样喂饱（踩过多次）。 */
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');

const MCP = read('mcp.rs');
const MCPC = strip(MCP);
const CONTENT = strip(read('content.rs'));

/** 从 start 起按大括号配平切出一段（分支体 / 函数体）。
 *  不配平会切进下一个分支或下一个函数（本文件踩过多次）。 */
function balanced(src, start) {
  let i = src.indexOf('{', start);
  if (i < 0) return '';
  let d = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') {
      d--;
      if (d === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

/** 按大括号配平切出 `"工具名" => { ... }` 的分支体。 */
function branch(src, name) {
  const a = src.indexOf(`"${name}" =>`);
  return a < 0 ? '' : balanced(src, a);
}

/** 切出 `pub fn 名(` 的函数体（含签名）。 */
function fnBody(src, sig) {
  const a = src.indexOf(sig);
  return a < 0 ? '' : balanced(src, a);
}

console.log('\n=== 1. backup：kind 必须二选一（静默降级会备份错对象）===');
{
  const b = branch(MCPC, 'backup');
  t('分支体定位成功', b.length > 0 && b.includes('backup::run'));

  /*
   * 反面证据：不得再有 `if s("kind") == "group" {…} else {…}` 这种形状。
   * 它是"静默降级"的原型 —— 传 Group / 项目组 一律落 project。
   */
  t('不含 == "group" 的 if/else 降级（反面证据）',
    !/if\s+s\("kind"\)\s*==\s*"group"/.test(b));
  t('用 match 做三分支判据', /match\s+kind_raw\.as_str\(\)/.test(b));
  t('非法值 return Err', /"project"\s*\|\s*"group"\s*=>/.test(b)
    && /other\s*=>\s*return\s+Err/.test(b));
  t('报错文案列出可选值', /kind 只能是 project 或 group/.test(b));

  /* 顺序：校验必须在 run 之前。放后面等于已经备份完了才说参数不对。 */
  const atK = b.indexOf('match kind_raw.as_str()');
  const atRun = b.indexOf('backup::run(');
  t('顺序：校验在 backup::run 之前（两端都存在才比）',
    atK >= 0 && atRun >= 0 && atK < atRun);
}

console.log('\n=== 2. backup：回包必须带类别（否则备份错对象无从发现）===');
{
  const b = branch(MCPC, 'backup');
  /*
   * summary() 只说"源 N 个：新增 X…"，**不含类别**。
   * 所以类别只能在回包这层补 —— 这里是唯一能让调用方看见的地方。
   */
  t('回包含类别 label', /let label = if kind == "group"/.test(b));
  t('回包把 label 拼进文案', /format!\("已备份\{label\}：/.test(b));

  /* 整体未执行（sources==0 且带原因）时不能仍说"已备份"。
     判据与前端 ToolsPanel 一致 —— 两处说法必须相同，否则又是一边说
     跳过、一边说完成的局面。 */
  t('sources==0 带原因时改说"未执行"', /r\.sources == 0 && !r\.errors\.is_empty\(\)/.test(b));
  t('未执行分支文案是"未执行备份"', /未执行备份/.test(b));
  t('仍成功时才说"已备份"', /已备份\{label\}：\{\}/.test(b));
}

console.log('\n=== 3. scan_content：kind 必须白名单校验（否则返回空数组谎报"没有"）===');
{
  const b = branch(MCPC, 'scan_content');
  t('分支体定位成功', b.length > 0 && b.includes('content::scan'));

  /*
   * 反面证据：不得再把 s("kind") 原样传给 scan。
   * 原写法 `if s("kind").is_empty() { "all" } else { s("kind") }`
   * 就是让任意值直达 scan() 的通道。
   */
  t('不再把原样 kind 直传（反面证据）',
    !/else\s*\{\s*s\("kind"\)\s*\}/.test(b));
  t('调 content::is_scan_kind 校验', /content::is_scan_kind\(&kind_raw\)/.test(b));
  t('非法值 return Err', /if\s+!super::content::is_scan_kind/.test(b)
    && /return\s+Err/.test(b));
  t('报错文案列出可选值', /kind 只能是 \{?\}/.test(b) || /kind 只能是/.test(b));
  t('用 SCAN_KINDS.join 生成文案（不另抄一份表）', /SCAN_KINDS\.join/.test(b));

  const atK = b.indexOf('is_scan_kind');
  const atScan = b.indexOf('content::scan(');
  t('顺序：校验在 content::scan 之前', atK >= 0 && atScan >= 0 && atK < atScan);

  /* 空串仍等同 all：历史语义，前端 scan("all") 与不传都走这里，
     改成报错会让"不传 kind"的既有调用方全部失败。 */
  t('空串仍等同 all（不误伤既有调用）', /kind_raw\.is_empty\(\)\s*\{\s*"all"/.test(b));
}

console.log('\n=== 4. scan() 的形状：没有 else 兜底（所以校验只能在外面）===');
{
  const body = fnBody(CONTENT, 'pub fn scan(');
  t('scan() 定位成功', body.length > 0);
  t('是并列 if 而非 match（未知值会落到空数组）',
    /if all \|\| kind == "agent"/.test(body) && !/match kind/.test(body));
  /* 反面证据：scan() 自己没有 else。有 else 就说明未知值会被兜成 all，
     那时外面的校验就成了"多此一举" —— 反过来也说明判据变了，要重评。 */
  t('无 else 兜底（反面证据）', !/\}\s*else\s*\{/.test(body));
  /* 切段必须精确：scan() 正下方的 scan_flat 里有
     `if kind == "agent" { … } else { … }`，切过头会把它的 else 算进来。 */
  t('切段没越到下一个函数（反面证据）', !body.includes('fn scan_flat'));
}

console.log('\n=== 5. SCAN_KINDS 是唯一来源，且与 scan() 的实现一致 ===');
{
  /*
   * 注意 `[^;]*` 不能用：常量声明里写的是 `[&str; 4]`，中间就有分号，
   * 用分号截断会只拿到 `pub const SCAN_KINDS: [&str;` —— 一个值都取不到，
   * 于是"含 all/agent/..."那条恒假，而"没有表外类别"却把所有值都当成了
   * 表外（kinds 为空）。两条一起假，看着像"常量写错了"。
   */
  const m = CONTENT.match(/pub const SCAN_KINDS[^=]*=\s*\[([^\]]*)\]/);
  t('常量存在', !!m);
  const kinds = m ? [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]) : [];
  t('含 all / agent / skill / rule',
    ['all', 'agent', 'skill', 'rule'].every((k) => kinds.includes(k)), kinds.join(','));

  const body = fnBody(CONTENT, 'pub fn scan(');
  for (const k of kinds.filter((x) => x !== 'all')) {
    t(`scan() 确实认 "${k}"`, body.includes(`kind == "${k}"`));
  }
  /* 反面证据：scan() 里不得出现常量表之外的类别。
     出现就说明两份已经漂移（常量没跟上实现，或实现多了一个没声明的）。 */
  const used = [...body.matchAll(/kind == "([a-z]+)"/g)].map((x) => x[1]);
  const extra = used.filter((k) => !kinds.includes(k));
  t('scan() 没有常量表之外的类别（反面证据）', extra.length === 0, extra.join(','));

  t('is_scan_kind 用的是同一份常量', /SCAN_KINDS\.contains/.test(CONTENT));
  t('is_scan_kind 认空串（等同 all）', /kind\.is_empty\(\)/.test(CONTENT));
}

console.log('\n=== 6. 兜底：schema 里声明了 enum 的参数都要在运行时校验 ===');
{
  /*
   * 这份清单从 tools/list 的 schema 里**解析**出来，不是手写 ——
   * 手写会过时，而过时的兜底等于没有兜底（本轮这两处就是这样漏掉的：
   * schema 都写了 enum，运行时一个没校验）。
   *
   * 以后新增带 enum 的参数却忘了校验，这里会红并**指名是哪个工具**。
   */
  /*
   * 必须**先按 tool 切段**再在段内找 enum。
   * 直接用 /tool\("x"[\s\S]*?"enum"/ 的话，`[\s\S]*?` 会跨过整个 tool 定义
   * 吃到**下一个** tool 的 enum —— 于是工具名与字段错配（第一版就报出了
   * "read_file.kind""set_lock.path" 这种根本不存在的组合）。
   */
  const idxs = [...MCP.matchAll(/\btool\("/g)].map((m) => m.index);
  const enumFields = [];
  for (let i = 0; i < idxs.length; i++) {
    const seg = MCP.slice(idxs[i], i + 1 < idxs.length ? idxs[i + 1] : idxs[i] + 2500);
    const toolName = (seg.match(/^tool\("([a-z_]+)"/) || [])[1];
    if (!toolName) continue;
    for (const em of seg.matchAll(/"enum":\s*\[/g)) {
      const head = seg.slice(0, em.index);
      const fm = [...head.matchAll(/"([a-zA-Z]+)":\s*\{/g)];
      const field = fm.length ? fm[fm.length - 1][1] : '?';
      enumFields.push({ toolName, field });
    }
  }
  t('解析到带 enum 的参数', enumFields.length >= 4, JSON.stringify(enumFields));

  const missing = [];
  for (const { toolName, field } of enumFields) {
    const b = branch(MCPC, toolName);
    if (!b) { missing.push(`${toolName}.${field}(分支没找到)`); continue; }
    /*
     * 判据：分支内出现"只能是"且紧跟着该字段名（措辞统一），
     * 或者用 match 走 `other =>` 兜底。
     * 只判"分支里有 Err"太宽松 —— 每个分支本来就有别的 Err。
     */
    const ok = new RegExp(`"${field}"[^\\n]{0,40}只能是|${field} 只能是`).test(b)
      || /_other\s*=>|other\s*=>\s*return\s+Err/.test(b);
    if (!ok) missing.push(`${toolName}.${field}`);
  }
  t(`带 enum 的参数全部有运行时校验（共 ${enumFields.length} 个）`,
    missing.length === 0, missing.length ? `未校验：${missing.join('、')}` : '');
  t('enum 参数清单本身没被改短', enumFields.length >= 4);
}

done();
