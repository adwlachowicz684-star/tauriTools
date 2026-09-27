/**
 * MCP 访问令牌不得被「保存设置」抹掉（零依赖，只读源码）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/mcp-token-keep-test.mjs
 *
 * 令牌是 MCP server **启动时**才生成的：发现配置里没有就现生成一把写盘。
 * 而前端 bootstrap 通常发生在这之前，于是前端草稿里的 mcpToken 恒为 null ——
 * 它从未拿到过这把钥匙。
 *
 * `core_save_config` 是整份覆盖（`*cfg = config.clone()`）。若不保住磁盘值：
 *   · 用户改一次设置 → 令牌被抹成 null
 *   · 下次启动 server 又生成一把**新的**
 *   · 地址没变、钥匙变了 → 已配好的 AI 客户端从此 401
 *   · 界面从不展示令牌、日志也不提 → 用户完全无从知道该去改哪里
 *
 * 同一函数里 editor_pick_cache 早就是这么保的，mcp_token 此前漏了这一手。
 * 这里守的是「漏了这一手」不会再退回去。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RS = path.join(HERE, '../../src-tauri/src/fpx');
const { t, done } = makeT();

/** 只剥行注释与块注释：护栏要求「名字不含注释字样的断言必须匹配剥注释后的源码」。 */
function stripComments(text) {
  const out = []; let inb = false;
  for (const line of text.split('\n')) {
    const s = line.replace(/^\s+/, '');
    if (inb) { if (s.includes('*/')) inb = false; continue; }
    if (s.startsWith('/*')) { if (!s.slice(2).includes('*/')) inb = true; continue; }
    if (s.startsWith('//')) continue;
    out.push(line);
  }
  return out.join('\n');
}

const modRaw = fs.readFileSync(path.join(RS, 'mod.rs'), 'utf8');
const mod = stripComments(modRaw);
const model = fs.readFileSync(path.join(RS, 'model.rs'), 'utf8');
const mcp = stripComments(fs.readFileSync(path.join(RS, 'mcp.rs'), 'utf8'));

/* 只在 core_save_config 函数体内判：文件里还有别的 with_config 调用点，
   整份匹配会被它们满足（改掉保存那处也照样全绿）。 */
const iFn = mod.indexOf('fn core_save_config');
const iEnd = iFn < 0 ? -1 : mod.indexOf('\n}', iFn);
const body = iFn >= 0 && iEnd > iFn ? mod.slice(iFn, iEnd) : '';

console.log('\n=== 1. 切片有效性 ===');
t('定位到 core_save_config', iFn >= 0);
t('取到函数体（非空）', body.length > 0, String(body.length));

console.log('\n=== 2. 保存时保住磁盘上的令牌 ===');
{
  const iTake = body.indexOf('cfg.mcp_token.take()');
  const iOver = body.indexOf('*cfg = config.clone()');
  const iSet = body.indexOf('cfg.mcp_token =');

  /* 两端都判存在：indexOf 找不到返回 -1，而 -1 < 正数恒真 —— 那是空跑。 */
  t('覆盖前先取走磁盘值', iTake >= 0, String(iTake));
  t('仍在整份覆盖', iOver >= 0, String(iOver));
  t('覆盖后回填令牌', iSet >= 0, String(iSet));
  t('取发生在覆盖之前（顺序有意义）',
    iTake >= 0 && iOver >= 0 && iTake < iOver, `${iTake} < ${iOver}`);
  t('回填发生在覆盖之后（顺序有意义）',
    iSet >= 0 && iOver >= 0 && iSet > iOver, `${iSet} > ${iOver}`);

  t('回填走 .or(token)（磁盘值兜底）', /\.or\(token\)/.test(body));
  t('空串不算有效值（trim 后判空再 or）',
    /filter\(\|s\| !s\.is_empty\(\)\)/.test(body));

  /* 反面证据：只写「存在 cfg.mcp_token =」是不够的 ——
     直接照抄前端值也能命中，那等于没保住。 */
  t('不得直接照抄前端值（那样等于没保住）',
    !/cfg\.mcp_token\s*=\s*config\.mcp_token\.clone\(\)/.test(body));
  t('不得把令牌无条件清空',
    !/cfg\.mcp_token\s*=\s*None/.test(body));
}

console.log('\n=== 3. 令牌确实由后端独家维护 ===');
{
  t('FpxConfig 有 mcp_token 字段', /pub mcp_token: Option<String>/.test(model));

  /* 证据链的另一半：令牌是**后端**在 server 启动时生成并写盘的。
     若它其实是前端生成的，那"前端草稿里恒为 null"这个前提就不成立，
     上面那一整套保活也就没有意义了。 */
  const iTx = mcp.indexOf('with_config(&dir');
  const iGen = mcp.indexOf('cfg.mcp_token = Some(');
  t('后端会自行生成令牌', iGen >= 0, String(iGen));
  t('生成后写进配置（事务内，不是 load/save 各一次）',
    iTx >= 0 && iGen >= 0 && iGen > iTx, `${iTx} < ${iGen}`);

  t('editor_pick_cache 仍单独保住（没被顺手合并掉）',
    /cfg\.editor_pick_cache = cache;/.test(body));
}

done();
