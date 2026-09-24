/**
 * 剪贴板三档兜底 + 连锁动作拉取失败的回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/clipboard-test.mjs
 *
 * 覆盖两处"失败却装作成功"：
 *
 * 1. utils/clipboard.ts 的三档顺序。**顺序错了不会报错**：
 *    · 把浏览器 API 放第一档 —— iframe 沙箱里没有 clipboard-write 权限，
 *      `navigator.clipboard.writeText` 会**静默失败**（点了完全没反应），
 *      而代码看起来"调用成功"了，于是永远轮不到后端那档；
 *    · 第 1 档失败就弹错误 toast —— 明明第 2 档能成，用户却先看到一个红
 *      提示，以为没复制，再点一次就真的写了两次。
 *
 * 2. App.tsx 拉取 chainActions 失败时**不再静默清空**（本轮修）。
 *    动作清单是 config 里的用户数据，拉不到就清空成"没有任何动作"：
 *    侧栏空、快捷键没反应、右键菜单一项都没有，且全程无提示 ——
 *    用户会以为是自己没配过，甚至去设置页重建一遍把正常数据覆盖掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, loadTs } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

const TS = fs.readFileSync(path.join(HERE, 'utils/clipboard.ts'), 'utf8');
/** 剥注释后再判：说明里也写了这些字样，不剥就是空跑 */
const CODE = TS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
const APP = fs.readFileSync(path.join(HERE, 'App.tsx'), 'utf8');
const APPCODE = APP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

console.log('=== 1. 三档顺序：后端必须在第一档 ===');
{
  const iBackend = CODE.indexOf('await api.copyText(text)');
  const iNav = CODE.indexOf('navigator.clipboard');
  const iExec = CODE.indexOf('document.execCommand');
  t('三档都在', iBackend > 0 && iNav > 0 && iExec > 0);
  t('后端在浏览器 API 之前', iBackend > 0 && iNav > iBackend);
  t('浏览器 API 在 execCommand 之前', iNav > 0 && iExec > iNav);
  /* 用结构类型而不是整个 FpxApi：utils 不能反向依赖 api，否则成环 */
  t('用结构类型 ClipboardApi（不 import api）',
    /interface ClipboardApi/.test(CODE) && !/from '\.\.\/api'/.test(CODE));
}

console.log('\n=== 2. 中途失败不许报 ===');
{
  /* 后端失败只能记日志、继续往下走，不能 toast 失败 */
  const first = CODE.slice(CODE.indexOf('try {'), CODE.indexOf('catch {'));
  t('后端失败只 log 不 toast', /log\(/.test(first) && !/toast\(['"]复制失败/.test(first));
  /* 失败必须"继续"而不是 return：return 掉就永远到不了第 2、3 档 */
  t('后端失败后没有提前 return', !/return false;?\s*\}/.test(first));
}

console.log('\n=== 3. 走真身：三档都失败才报失败 ===');
{
  const { copyText } = await loadTs(path.join(HERE, 'utils/clipboard.ts'));
  const mk = (apiResult, navOk, execOk) => {
    const toasts = [];
    const logs = [];
    globalThis.navigator = navOk
      ? { clipboard: { writeText: async () => {} } }
      : {};
    globalThis.document = {
      createElement: () => ({
        style: {}, select() {},
      }),
      body: { appendChild() {}, removeChild() {} },
      execCommand: () => execOk,
    };
    return {
      deps: {
        api: { copyText: async () => apiResult },
        toast: (m, k) => toasts.push([m, k]),
        log: (m, e) => logs.push([m, e]),
      },
      toasts, logs,
    };
  };

  {
    const { deps, toasts, logs } = mk(true, false, false);
    const r = await copyText(deps, 'x');
    t('后端成功 → 返回 true 且提示成功', r === true && toasts.length === 1 && toasts[0][1] === 'ok');
    t('后端成功时不再走后面两档', logs.length === 0);
  }
  {
    const { deps, toasts, logs } = mk(false, true, false);
    const r = await copyText(deps, 'x');
    t('后端失败 + 浏览器成功 → 仍算成功', r === true && toasts.some((x) => x[1] === 'ok'));
    t('后端失败要记日志（不能无声降级）', logs.some((x) => x[1] === true));
  }
  {
    const { deps, toasts } = mk(false, false, false);
    const r = await copyText(deps, 'x');
    t('三档全失败 → 返回 false 且提示失败', r === false && toasts.some((x) => x[1] === 'err'));
  }
}

console.log('\n=== 4. App 不再内联这段（已抽走）===');
{
  t('App 从 utils/clipboard 引入', /from '\.\/utils\/clipboard'/.test(APPCODE));
  /* 反面证据：不许还留着一份内联的三档 */
  t('App 里没有内联的 execCommand 兜底', !/document\.execCommand\(['"]copy['"]\)/.test(APPCODE));
  t('App 里没有内联的 navigator.clipboard 兜底', !/navigator\.clipboard/.test(APPCODE));
}

console.log('\n=== 5. chainActions 拉取失败必须说出来 ★ ===');
{
  /* 反面证据：不许再是 `.catch(() => ...)`（把错误吞掉） */
  t('不再是吞掉错误的 catch', !/\.catch\(\(\) => \{ if \(!cancelled\) setChainActions/.test(APPCODE));
  /*
   * 两处都要**限定在 chainActions 那一段里**判：
   *
   * App.tsx 里还有另一处 `.catch((e: unknown) => ctx.toast(...))`（添加卡片），
   * 全文件匹配的话，把这里改成吞掉错误的 `catch(() => ...)` 之后，
   * 那条断言仍被别处的 `(e: unknown)` 命中 → **空跑**（第 20 次）。
   *
   * 另：`catch\s*\(` 而不是 `catch \(` —— 实际写法 `.catch((e: unknown)`
   * 中间没有空格，写死空格就是恒假。
   */
  const iChain = APPCODE.indexOf('s.api.chainActions()');
  const chainBlock = APPCODE.slice(iChain, APPCODE.indexOf('return () => { cancelled = true; }', iChain));
  t('chainActions 段落取到了', iChain > 0 && chainBlock.includes('catch'));
  t('失败时带错误信息',
    /catch\s*\(\(e: unknown\)/.test(chainBlock) && /errText\(e\)/.test(chainBlock));
  t('失败时记错误日志', /读取连锁动作失败/.test(APPCODE) && /true\)/.test(APPCODE));
  /* 清空仍然要做：不清空界面会停在旧清单上，那也是错的 */
  t('失败时仍清空（不停在旧清单上）', /setChainActions\(\[\]\)/.test(APPCODE));
  /* 但必须说明"配置没动"，否则用户会以为配置丢了 */
  t('提示里说明配置本身未改动', /配置本身未改动/.test(APP));
  /* pushLog 进了依赖数组：useCallback 稳定成员，不加会 lint 报警 */
  t('依赖里带了 s.pushLog', /\[bootReady, s\.api, s\.pushLog, chainVersion\]/.test(APPCODE));
}

done();
