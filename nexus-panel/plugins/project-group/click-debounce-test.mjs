/**
 * 单击折叠/双击改名（#251） + 连锁发送防抖（#207），零依赖
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/click-debounce-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const R = (n) => strip(fs.readFileSync(path.join(HERE, n), 'utf8'));

const groups = R('components/StackedGroups.tsx');
const chain = R('hooks/useChainActions.ts');
/* 注释类断言要看**未剥注释**的原文：R() 会把 /* *​/ 块注释全剥掉，
   拿剥过的文本去查注释里的话必然失败（断言静默为 false）。 */
const groupsRaw = fs.readFileSync(path.join(HERE, 'components/StackedGroups.tsx'), 'utf8');

console.log('\n=== 1. #251 单击折叠要延后，好让双击取消它 ===');
{
  /* 不延后的话双击改名会先折叠再展开：净效果为零，但界面明显闪一下 */
  const btn = groups.slice(groups.indexOf('className="fpx-stack-name"'));
  const seg = btn.slice(0, btn.indexOf('</button>'));
  t('单击走 setTimeout', /window\.setTimeout\(\(\) => \{/.test(seg));
  t('双击先清定时器', /onDoubleClick=\{\(\) => \{[\s\S]{0,200}?clearTimeout\(clickTimer\.current\)/.test(seg));
  t('双击再进改名', /setDraft\(t\.name\);\s*\n\s*setEditing\(i\);/.test(seg));
  t('提示写明两种操作', /单击折叠 \/ 双击重命名/.test(seg));
  /* 延后时长要有说明，别留裸数字 */
  t('延后时长有注释说明代价', /代价是单击折叠慢 220ms/.test(groupsRaw));
}

console.log('\n=== 2. 定时器必须能回收（最容易漏）===');
{
  /* 定时器晚于组件卸载触发会 setState，表现为"切走再回来某分类自己折叠了" */
  t('用 ref 存定时器 id', /clickTimer = useRef<number \| null>\(null\)/.test(groups));
  t('卸载时清理', /useEffect\(\(\) => \(\) => \{[\s\S]{0,200}?clearTimeout\(clickTimer\.current\)/.test(groups));
  t('执行后置回 null', /clickTimer\.current = null;/.test(groups));
}

console.log('\n=== 3. #207 连锁发送防抖 ===');
{
  t('有防抖常量', /const SEND_DEBOUNCE_MS = 400;/.test(chain));
  t('键含动作 + 目标', /\$\{actionId\}\\u0000\$\{kind\}\\u0000\$\{path\}/.test(chain) || /actionId\}[^\n]*kind\}[^\n]*path\}/.test(chain));
  t('窗口内丢弃', /now - prev < SEND_DEBOUNCE_MS/.test(chain));
  /* 只按「动作+目标」去重，不按动作：对 A 发完立刻对 B 发是正常操作 */
  t('键含目标（不是只按动作）', /actionId\}[^\n]*path\}/.test(chain));
}

console.log('\n=== 4. 失败必须能立刻重试（关键）===');
{
  /*
   * 若失败也留着时间戳，用户看到失败后立刻重试会被防抖拦掉 ——
   * 表现为"再点一次什么都没发生"，那比连发更让人困惑：
   * 他会以为重试没生效、继续点，最后干脆放弃。
   */
  const body = chain.slice(chain.indexOf('const sendAction'));
  const seg = body.slice(0, body.indexOf('\n  };'));
  t('失败分支清时间戳', /lastSentAt\.current\.delete\(key\);/.test(seg));
  /*
   * 顺序断言必须**两端都判存在**：
   * 某端找不到时 indexOf 返回 -1，而 `-1 < 任意正数` 恒真 ——
   * 断言会**空跑**：锚点被改没了，它照样报绿，你以为在验次序，其实什么都没验。
   * 这类空跑靠"剥注释"扫不出来（锚点是代码不是注释），只能显式判 >= 0。
   */
  /*
   * **两处都要清**，缺一处就漏掉一半的失败：
   *   · catch  —— 命令本身抛错（后端 Err）
   *   · try 内 —— 命令**正常返回**但 `ok: false`（客户端没唤起、复制也没成）
   *
   * 后者正是用户会看到失败提示、最可能立刻重试的那一支。
   * 只清 catch 的话，他再点一次被 400ms 防抖静默丢弃，
   * 表现为"重试毫无反应" —— 比连发更让人困惑。
   */
  const iCatch = seg.indexOf('catch');
  t('catch 里清时间戳',
    iCatch >= 0 && /lastSentAt\.current\.delete\(key\)/.test(seg.slice(iCatch)));
  t('try 内 ok=false 分支也清时间戳',
    /if \(!r\.ok\) lastSentAt\.current\.delete\(key\)/.test(seg));
  /* 成功分支不能清 */
  t('成功时不删（保留防抖）', !/pushLog\(r\.message[\s\S]{0,80}?lastSentAt\.current\.delete/.test(seg));
}

done();
