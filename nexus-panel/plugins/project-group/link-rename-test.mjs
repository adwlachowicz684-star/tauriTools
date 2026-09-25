/**
 * 链接名改名的输入反馈（#63，零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/link-rename-test.mjs
 *
 * #63 真正的价值不是"做成弹窗"，而是修掉一个**显示与实际不一致**的 bug：
 *   此前用 defaultValue（不受控）+ 一个全局 err ——
 *   校验失败时函数直接 return，但**输入框里的非法值不会回滚**。
 *   界面提示"名称含有非法字符"，框里却还留着那个非法值，
 *   而实际生效的仍是原名。用户以为改成功了。
 *
 * 另一个问题：全局只有一个 err，多行同时出错时**定位不到是哪一行**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const src = strip(fs.readFileSync(path.join(HERE, 'components/LinkPanel.tsx'), 'utf8'));
const css = strip(fs.readFileSync(path.join(HERE, 'style.css'), 'utf8'));
/* 校验判据已抽到 utils/ 下（改名与"添加自定义"共用一份），字符集合字面量在那里 */
const ua = strip(fs.readFileSync(path.join(HERE, 'utils/linkAgents.ts'), 'utf8'));

console.log('\n=== 1. 受控输入（不再用 defaultValue）===');
{
  t('改名框是受控的', /className="p-input fpx-rename"[\s\S]{0,300}?value=\{renameDraft\[p\.original\] \?\? p\.shown\}/.test(src));
  /* defaultValue 是"值不回滚"的根源 */
  t('改名框不再用 defaultValue', !/className="p-input fpx-rename"[\s\S]{0,200}?defaultValue/.test(src));
  t('有每行草稿状态', /useState<Record<string, string>>\(\{\}\)[\s\S]{0,80}?useState<Record<string, string>>/.test(src));
  t('onChange 写草稿', /onChange=\{\(e\) => setRenameDraft\(/.test(src));
}

console.log('\n=== 2. 校验失败要回滚显示值 ===');
{
  /* **无论成败都清草稿**：成功回落到新名，失败回滚到旧名 */
  t('onBlur 后清草稿', /onBlur=\{\(e\) => \{\s*\n\s*rename\(p\.original, p\.shown, e\.target\.value\);/.test(src));
  /* 在 onBlur 块内断言"rename 之后紧接着清草稿"。
     终点必须**从起点之后**找：文件里前面就有别的 onKeyDown（添加自定义那个），
     直接用 indexOf 会拿到更早的位置 → 切片为空 → 断言静默失败。 */
  const bStart = src.indexOf('onBlur={(e) => {');
  const blur = src.slice(bStart, src.indexOf('onKeyDown={(e) => {', bStart));
  t('清草稿在 rename 之后无条件执行',
    /rename\(p\.original, p\.shown, e\.target\.value\);[\s\S]*delete n\[p\.original\]/.test(blur));
  t('rename 返回是否成功', /const rename = \(original: string, currentShown: string, to: string\): boolean/.test(src));
  t('失败时 return false', /return false;/.test(src));
  t('成功时 return true', /return true;\s*\n  \};/.test(src));
}

console.log('\n=== 3. 错误就地显示（不是全局一个）===');
{
  t('有每行错误状态', /const \[renameErr, setRenameErr\]/.test(src));
  t('错误按原名索引', /setRenameErr\(\(x\) => \(\{ \.\.\.x, \[original\]:/.test(src));
  t('渲染在对应行', /\{renameErr\[p\.original\] && \(/.test(src));
  t('错误有样式', /\.fpx-rename-err \{/.test(css));
  /* 全局 err 仍留给"添加自定义" */
  t('全局 err 仍存在（给添加自定义用）', /const \[err, setErr\] = useState\(''\)/.test(src));
  /* 改名**不再**写全局 err —— 否则又混在一起 */
  t('改名不写全局 err', !/setErr\(`「\$\{next\}」已被占用`\)/.test(src));
}

console.log('\n=== 4. 校验项齐全 ===');
{
  t('查重名', /allNames\.includes\(next\)/.test(src) && /已被占用/.test(src));
  /*
   * 判据在 utils/ 下（改名与"添加自定义"共用一份），组件侧只钉"两条入口都用了它"。
   * 只钉"出现过"会漏：任一入口漏掉就仍可绕过，而另一处存在让断言照样通过。
   */
  t('查非法字符', /名称含有非法字符/.test(src) && ua.includes('*?"<>|'));
  t('两条入口都用同一判据（缺一即可绕过）', (src.match(/usableLinkName\(/g) || []).length >= 2);
  /* `.` / `..` 不含非法字符，却永远建不出链接 —— 只查字符集合拦不住 */
  t('判据含前导点规则', ua.includes('/^\\.+/'));
  /* #91：与"添加自定义"同一判据，否则改名能绕过 */
  t('查大小写重名（#91 同一判据）', /hasNameCI\(allNames, next\)/.test(src));
  t('清空=恢复原名', /const next = name \|\| original;/.test(src));
}

console.log('\n=== 5. Esc 取消 ===');
{
  t('Esc 清草稿（回到当前值）', /e\.key === 'Escape'/.test(src));
  t('Esc 同时清掉这行错误', /clearRenameErr\(p\.original\)/.test(src));
  t('Enter 提交', /e\.key === 'Enter'/.test(src));
}

done();
