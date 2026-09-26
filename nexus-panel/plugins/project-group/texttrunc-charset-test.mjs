/**
 * 文本截断 / 名称长度必须按**字符**算，不能按字节（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/texttrunc-charset-test.mjs
 *
 * 两处都是同一个错：`String::len()` 给的是**字节数**，而判据的语义是
 * "最多多少个字符"。中文一个字 3 字节，于是：
 *
 *   · 内容预览：2 万字的中文文件被判成超长，再按字节截到 20000，
 *     实际只剩约 6600 字 —— 界面上同样写着「内容过长，已截断」，
 *     用户只拿到应有的 1/3，而没有任何线索说明为什么这么短。
 *   · 新建名称：40 个汉字就超限，报错却写「上限 120 字符」——
 *     用户数着自己打了 50 个字却被告知超过 120，报错指向不了真原因。
 *
 * 这类"报错与事实不符"不崩溃、不抛异常，只能靠这里钉住。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RS = (n) => path.join(HERE, '../../src-tauri/src/fpx', n);
const { t, done } = makeT();

const content = fs.readFileSync(RS('content.rs'), 'utf8');
const sys = fs.readFileSync(RS('sys.rs'), 'utf8');

/** 剥掉块注释与整行注释，避免断言命中「说明文字」而不是真实代码 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('\n=== 1. 内容预览：按字符判定 ===');
{
  const fn = content.slice(content.indexOf('pub fn read_preview'), content.indexOf('pub fn skill_md_of'));
  const code = strip(fn);
  t('判定用 chars().count()', /text\.chars\(\)\.count\(\) > max/.test(code));
  /* 反面证据：不能再拿字节数跟字符上限比 */
  t('不再用 text.len() > max（反面证据）', !/text\.len\(\) > max/.test(code));
  /* 截断点也必须按字符下标取字节位置，直接拿 max 当字节下标会回到原错 */
  t('截断点按字符下标取字节位置', /text\.char_indices\(\)\.nth\(max\)/.test(code));
  t('不再调 safe_truncate_at（它是按字节的）', !/safe_truncate_at/.test(code));
  t('截断后才追加提示', /text\.push_str\("\\n\\n…（内容过长，已截断）"\)/.test(code));
  /* 字节预算仍按 max*4 折算：预算要够装下 max 个多字节字符 */
  t('读盘预算按 max 折算字节', /max\.saturating_mul\(4\)/.test(code));
}

console.log('\n=== 2. 新建名称：按字符算长度 ===');
{
  const fn = sys.slice(sys.indexOf('pub fn validate_name'), sys.indexOf('pub fn create_folder'));
  const code = strip(fn);
  t('判定用 chars().count()', /name\.chars\(\)\.count\(\) > 120/.test(code));
  /* 反面证据 */
  t('不再用 name.len() > 120（反面证据）', !/name\.len\(\) > 120/.test(code));
  t('报错文案仍说「字符」（与判据一致）', /上限 120 字符/.test(sys));
}

console.log('\n=== 3. 不受影响的那处（按字节是对的，别误改）===');
{
  /* mcp.rs 里给生成的名字限 60 **字节**：那里是标识符长度，字节语义是有意的，
     且注释已写明"中文每字 3 字节，硬切片会 panic"。断言钉住它没被顺手改成字符。 */
  const mcp = fs.readFileSync(RS('mcp.rs'), 'utf8');
  t('mcp 那处仍是按字节截断', /if trimmed\.len\(\) > 60 \{/.test(strip(mcp)));
  t('且先退到字符边界（不会 panic）', /safe_truncate_at\(&trimmed, 60\)/.test(strip(mcp)));
}

done();
