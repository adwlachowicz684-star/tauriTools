/**
 * 备份结果汇报的真值测试（零依赖，跑真身）
 * ------------------------------------------------------------------
 *   node plugins/project-group/backup-report-truth-test.mjs
 *
 * 守的是"备份回包说了什么"这件事。后端 `BackupResult::summary()` 自带
 * 「异常 N 条」，MCP 回包用的正是它；而界面日志此前**自己拼了一句不带异常数的
 * 「完成」** —— 同一件事两个说法，且界面那个是会说谎的：
 *
 *   1. 有 30 处枚举/复制失败（备份**不完整**）→ 日志仍写「备份项目完成」
 *      用户关掉弹窗后只看到"完成"，要等真的去找那份备份才发现少了一块
 *   2. 后端"已有备份正在进行，本次未执行"回的是 sources=0 + 一条 [跳过]，
 *      界面照样写「完成：0 个源，新增 0、更新 0」—— 一个文件都没动
 *   3. 只把前 5 条错误转进日志、结果区只列前 20 条，都不说还有多少
 *
 * 另含日志上限那处：把上限从 500 改到 50 后，已有日志不会被截断，
 * 界面显示成 "300/50"（当前条数比上限还大，且会自己往下掉）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, stripTS } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

const panel = fs.readFileSync(path.join(HERE, 'components/ToolsPanel.tsx'), 'utf8');
const useFpx = fs.readFileSync(path.join(HERE, 'hooks/useFpx.ts'), 'utf8');

/* ---------------- 把 run() 真身切出来跑 ---------------- */

/** 从 anchor 起按大括号配平切出函数体（含 `const run = ...` 尾巴上的分号） */
function sliceFn(src, anchor) {
  const i = src.indexOf(anchor);
  if (i < 0) return '';
  let d = 0;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') {
      d--;
      if (d === 0) return src.slice(i, j + 1);
    }
  }
  return '';
}

const RAW = sliceFn(panel, 'const run = async (kind: CardKind) => {');
t('切到 run() 真身', RAW.includes('api.backup(') && RAW.includes('onLog('),
  RAW ? `${RAW.length} 字符` : '（没切到）');

/** 剥类型 + 把 `const run = ` 去掉，只留箭头函数，交给 new Function 注入闭包变量 */
const BODY = stripTS(RAW).replace(/^const run =\s*/, '').replace(/;$/, '');

const makeRun = () => {
  const logs = [];
  const calls = { saved: 0 };
  const st = { busy: null, result: null };
  const run = new Function(
    /* errText 也是闭包变量（catch 分支用），漏注入的话失败路径直接 ReferenceError */
    'api', 'dir', 'appendOnly', 'onLog', 'onSaved', 'setBusy', 'setResult', 'kind', 'errText',
    `return (${BODY})().then(() => 0);`,
  );
  return {
    logs,
    exec: (kind, backupResult, opts = {}) => {
      const api = { backup: async () => backupResult };
      return run(
        api,
        opts.dir ?? '',
        opts.appendOnly ?? false,
        (m, isError) => logs.push({ m, isError: !!isError }),
        () => { calls.saved++; },
        (v) => { st.busy = v; },
        (v) => { st.result = v; },
        kind,
        (e) => String(e?.message ?? e),
      );
    },
    st,
    calls,
  };
};

/* 字段名是前端 camelCase（types.ts 里 BackupResult 就是这么写的）——
   写成 snake_case 会静默得到 undefined，断言看着在跑其实没验到数 */
const R = (over = {}) => ({
  target: 'D:\\bak',
  sources: 50, missingSources: 0,
  newFiles: 100, updatedFiles: 5, deletedFiles: 0, skippedLinks: 0,
  errors: [],
  ...over,
});

console.log('\n=== 1. 无异常：照常说完成，且不带异常字样、不标红 ===');
{
  const h = makeRun();
  await h.exec('project', R());
  const first = h.logs[0];
  t('写了一句「完成」', /^备份项目完成/.test(first?.m ?? ''), first?.m);
  t('不带「异常」字样', !/异常/.test(first?.m ?? ''));
  t('不标红', first?.isError === false, String(first?.isError));
  t('带源数与新增数', /50 个源/.test(first?.m ?? '') && /新增 100/.test(first?.m ?? ''));
}

console.log('\n=== 2. 有异常：必须说出条数，不能只说"完成" ===');
{
  const errs = Array.from({ length: 30 }, (_, i) => `[失败] 复制 file${i}.txt：权限不足`);
  const h = makeRun();
  await h.exec('project', R({ errors: errs }));
  const first = h.logs[0];
  t('仍说「完成」（备份确实做完了）', /^备份项目完成/.test(first?.m ?? ''), first?.m);
  t('**带异常条数**', /有 30 处异常/.test(first?.m ?? ''), first?.m);
  t('说明"备份不完整"', /不完整/.test(first?.m ?? ''));
  t('标红', first?.isError === true, String(first?.isError));
  /* 只转 5 条却不说明还有多少 → 用户以为就这 5 个 */
  const errLines = h.logs.filter((l) => /权限不足/.test(l.m));
  t('错误明细转了 5 条', errLines.length === 5, `${errLines.length} 条`);
  t('**说明还有 25 条并指向结果区**',
    h.logs.some((l) => /还有 25 条异常/.test(l.m) && /结果区/.test(l.m)),
    h.logs.find((l) => /还有/.test(l.m))?.m);
}

console.log('\n=== 3. 整体未执行（并发跳过）：不能说"完成" ===');
{
  const h = makeRun();
  await h.exec('project', R({
    sources: 0, new_files: 0, updated_files: 0,
    errors: ['[跳过] 已有备份正在进行（手动 / 自动 / MCP 入口之一），本次未执行'],
  }));
  const first = h.logs[0];
  t('说「未执行」而不是「完成」', /未执行/.test(first?.m ?? ''), first?.m);
  t('不带「完成」字样', !/完成/.test(first?.m ?? ''), first?.m);
  t('把后端给的原因带出来', /已有备份正在进行/.test(first?.m ?? ''));
  t('标红', first?.isError === true);
}

console.log('\n=== 4. 结果区：折叠标题说 N 条，就别只列 20 条 ===');
{
  const seg = panel.slice(panel.indexOf('异常 {result.errors.length} 条'),
    panel.indexOf('</details>', panel.indexOf('异常 {result.errors.length} 条')));
  t('切片非空（锚点命中）', seg.length > 0, `${seg.length} 字符`);
  t('列出前 20 条', /slice\(0, 20\)/.test(seg));
  t('**超出时说明还有多少未列出**',
    /result\.errors\.length > 20/.test(seg) && /未列出/.test(seg),
    seg.includes('未列出') ? '' : '（没写"未列出"，数与内容会对不上）');
}

console.log('\n=== 5. 日志上限改小后要立刻截断（否则显示 300/50） ===');
{
  /* 关键：pushLog 只在新增时 slice，改小上限必须有个 effect 补刀 */
  /* 两端都必须是**代码**锚点。用 `/** 清空日志` 这种注释当终点，
     注释一改/一挪切片就落到别处（断言卫生护栏会直接判这条不合格）。 */
  const seg = useFpx.slice(useFpx.indexOf('const pushLog = useCallback'),
    useFpx.indexOf('const clearLog = useCallback'));
  t('切片非空', seg.length > 0, `${seg.length} 字符`);

  const hasEffect = /setLog\(\(l\) => \(l\.length > max \? l\.slice\(0, max\) : l\)\)/.test(seg);
  t('**有截断 effect**', hasEffect,
    hasEffect ? '' : '（没有 → 界面会显示"当前条数 > 上限"）');

  /*
   * 依赖数组必须从**截断语句之后**开始找。
   * 直接全段 match 的话，先命中的是上面 pushLog 的 `}, []);` ——
   * 它的依赖本来就该是空，于是这条断言恒假（看着在验，其实验的是别的函数）。
   */
  const effAt = seg.indexOf('l.length > max');
  const after = effAt < 0 ? '' : seg.slice(effAt);
  const depM = after.match(/\},\s*\[([^\]]*)\]\)/);
  const deps = depM?.[1] ?? '';
  t('**找到截断语句的依赖数组**', !!depM, deps || '（没找到 → 断言无从谈起）');
  t('依赖含 logMaxLines（改配置才会重跑）', /logMaxLines/.test(deps), deps);
  t('依赖不是空数组', !/^\s*\}\s*,\s*\[\s*\]\s*\)/.test(after),
    '（写 [] 的话只跑一次，之后改配置不生效）');

  /* 保留 pushLog 自身的截断：两者职责不同，缺一不可 */
  t('pushLog 仍按上限截断（新增路径）',
    /\[\{ at: now\(\), text, isError \}, \.\.\.l\]\.slice\(0, max\)/.test(useFpx));
}

done();
