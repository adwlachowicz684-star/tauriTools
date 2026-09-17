/**
 * 插件静态准入（AST 级）
 * ============================================================
 * 白名单体系的**第一层**：加载前扫源码，命中不可撤销的行为就直接拒绝嵌合。
 *
 * 为什么必须用 AST 而不是正则
 * ------------------------------------------------------------
 * 正则扫 `customElements.define` 会被这些写法轻松绕过：
 *   · 字符串里提到它（注释、文案）
 *   · 动态成员 `window['custom' + 'Elements'].define(...)`
 *   · 换行/空格差异
 * AST 看的是**语义结构**，绕不过去。动态成员访问也逃不掉 ——
 * 它会被识别成"静态无法判定"，归到待人工确认，而不是当没看见。
 *
 * 分级（对应污染防控文档的绿/黄/红）
 * ------------------------------------------------------------
 *   deny   —— 不可撤销 / 危险，拒绝嵌合（降级 iframe 或拒绝加载）
 *   review —— 静态可判定但**不该直接做**（应走 owned 通道），
 *             不阻断，进"待分类队列"逐步归类
 *
 * 为什么 review 不阻断
 * ------------------------------------------------------------
 * 现有插件里有不少 `window.xxx =` / `document.body.appendChild`，
 * 一刀切拒绝会让它们全部挂掉 —— 那是"安全影响功能"。
 * review 的定位是**分诊队列**：先记下来，再逐个决定是补通道还是禁掉。
 *
 * 依赖：acorn（解析）+ acorn-walk（遍历）+ esbuild（TS/TSX → JS）。
 * 三者都是纯 JS / 项目既有工具链的一部分，不引入新的运行时负担。
 *
 * 已知局限（诚实列出，别把"没扫到"当成"没问题"）
 * ------------------------------------------------------------
 * 1. **解构后调用绕得过**：
 *      const { define } = customElements; define('x', class{});
 *    callee 是裸标识符，不做作用域分析就认不出来。
 *    （要堵需上作用域分析，成本与收益不成比例；iframe 兜底。）
 * 2. **只在构建/CI 期跑，不做运行时校验**：
 *    esbuild + acorn 进不了前端产物（体积），
 *    所以这一层是**开发期闸门**，运行时的不可信插件仍靠 iframe 隔离。
 *    这正是分级模型的含义：L1 可信（CI 扫过）+ L2 不可信（沙箱）。
 */
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import esbuild from 'esbuild';

/* ------------------------------------------------------------------ */
/* 规则表                                                              */
/* ------------------------------------------------------------------ */

/**
 * 宿主全局对象的根名字。
 * 命中它们说明操作落在**宿主文档**上，而不是插件自己的作用域里。
 */
const GLOBAL_ROOTS = new Set([
  'window', 'globalThis', 'self', 'top', 'parent', 'document',
  'navigator', 'location', 'history', 'screen', 'frames',
]);

export const SEVERITY = { DENY: 'deny', REVIEW: 'review' };

/* ------------------------------------------------------------------ */
/* AST 辅助                                                            */
/* ------------------------------------------------------------------ */

/** 把 MemberExpression 链渲染成 `window.document.body` 这样的点号串 */
export function renderMember(node) {
  const parts = [];
  let n = node;
  while (n) {
    if (n.type === 'Identifier') {
      parts.unshift(n.name);
      break;
    }
    if (n.type === 'ThisExpression') {
      parts.unshift('this');
      break;
    }
    if (n.type === 'MemberExpression') {
      if (n.computed) {
        /* 动态成员（a[b]）：静态无法判定，用 `[?]` 标记 */
        parts.unshift('[?]');
      } else if (n.property?.type === 'Identifier') {
        parts.unshift(n.property.name);
      } else {
        parts.unshift('?');
      }
      n = n.object;
      continue;
    }
    return null;
  }
  return parts.join('.');
}

/** 链的根是否是宿主全局对象 */
export function isGlobalRoot(node) {
  let n = node;
  while (n?.type === 'MemberExpression') n = n.object;
  return !!n && n.type === 'Identifier' && GLOBAL_ROOTS.has(n.name);
}

/** 链里是否出现 X.prototype（原型修改 = 全局生效且影响其它插件） */
function hasPrototype(node) {
  let n = node;
  while (n?.type === 'MemberExpression') {
    if (!n.computed && n.property?.type === 'Identifier' && n.property.name === 'prototype') {
      return true;
    }
    n = n.object;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                */
/* ------------------------------------------------------------------ */

/**
 * 扫一段 JS 源码。
 *
 * @param {string} code
 * @param {{file?: string}} [opts]
 * @returns {{deny: object[], review: object[], error?: string}}
 */
export function scanCode(code, opts = {}) {
  const file = opts.file || '';
  const deny = [];
  const review = [];
  const push = (arr, rule, node, detail) => {
    arr.push({
      rule,
      file,
      line: node?.loc?.start?.line ?? 0,
      detail,
    });
  };

  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'module', locations: true });
  } catch (e) {
    return { deny, review, error: `解析失败: ${e.message}` };
  }

  walk.full(ast, (node) => {
    /* ---------- 调用 ---------- */
    if (node.type === 'CallExpression') {
      const callee = node.callee;
      if (callee?.type === 'MemberExpression') {
        const path = renderMember(callee);
        if (!path) return;

        /* 自定义元素：**无法 undefine**，进程内永久残留 */
        if (/(^|\.)customElements\.define$/.test(path)) {
          push(deny, 'custom-element', node, path);
          return;
        }

        /* Service Worker：注册到 origin，**跨会话残留** */
        if (/serviceWorker\.register$/.test(path)) {
          push(deny, 'service-worker', node, path);
          return;
        }

        /* Object.defineProperty 到宿主对象：可能把宿主 API 锁死 */
        if (/^Object\.(defineProperty|defineProperties|freeze|seal)$/.test(path)) {
          const target = node.arguments?.[0];
          const tp = target?.type === 'MemberExpression' ? renderMember(target) : null;
          if (target && (isGlobalRoot(target) || hasPrototype(target))) {
            push(deny, 'define-property-host', node, tp || path);
            return;
          }
        }

        /* 主面板被导航走 */
        if (/^history\.(pushState|replaceState)$/.test(path)) {
          push(deny, 'history-navigate', node, path);
          return;
        }
        if (/^location\.(assign|replace)$/.test(path)) {
          push(deny, 'location-navigate', node, path);
          return;
        }

        /*
         * 动态成员调用，如 `window['custom' + 'Elements'].define(...)`。
         *
         * 静态**证明不了它安全** —— 正则会直接放行（漏），
         * 而这里必须把它挑出来进分诊队列。
         * 「无法判定」绝不等于「没问题」：后者是最大的假绿来源。
         */
        /*
         * 只挑**根是宿主全局**的动态调用（window[x].define(...)）。
         *
         * 第一版对**所有**动态成员调用都报（handlers[type]() 这种
         * 普通动态分发也算），一次扫出 23 条噪音 ——
         * 噪音会淹没队列，等于没有队列。
         * 真正需要在意的是"往宿主全局上做静态看不懂的事"。
         */
        if (path.includes('[?]') && isGlobalRoot(callee)) {
          push(review, 'unresolvable-call', node, path);
          return;
        }

        /* 应走 owned 通道的（不阻断，进分诊队列） */
        if (/^(window|globalThis)\.(setInterval|setTimeout)$/.test(path)) {
          push(review, 'timer-via-owned', node, path);
          return;
        }
        if (/^document\.(body|documentElement)\.appendChild$/.test(path)) {
          push(review, 'portal-via-owned', node, path);
          return;
        }
        if (/^window\.open$/.test(path)) {
          push(review, 'window-open', node, path);
          return;
        }
      }
      return;
    }

    /* ---------- 赋值 ---------- */
    if (node.type === 'AssignmentExpression') {
      const left = node.left;
      if (left?.type !== 'MemberExpression') return;

      /* 原型修改：全局生效，影响其它插件，且无法撤销 */
      if (hasPrototype(left)) {
        push(deny, 'prototype-mutation', node, renderMember(left) || '?');
        return;
      }

      /* location.href = / window.location = —— 主面板被导航走 */
      const path = renderMember(left);
      if (path && /^((window|document|globalThis|top)\.)?location(\.href)?$/.test(path)) {
        push(deny, 'location-navigate', node, path);
        return;
      }

      /* 往宿主全局挂属性：应走 owned，不阻断 */
      if (isGlobalRoot(left)) {
        /* 动态成员（window[name] = ...）静态判定不了 ——
           归到 review 并标注，绝不当成"没看见" */
        const dynamic = path?.includes('[?]');
        push(review, dynamic ? 'global-write-dynamic' : 'global-write', node, path || '?');
        return;
      }
    }
  });

  return { deny, review };
}

/* ------------------------------------------------------------------ */
/* 文件入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * TS / TSX / JSX 先经 esbuild 转成 JS，再由 acorn 解析。
 * 直接让 acorn 吃 TSX 会解析失败 —— 而**解析失败若被当成"没问题"
 * 就是最大的假绿**：危险代码恰好藏在解析不了的文件里。
 */
export function toJs(code, file = '') {
  const ext = (file.split('.').pop() || 'js').toLowerCase();
  if (!['ts', 'tsx', 'jsx', 'mts', 'cts'].includes(ext)) return { code, error: null };
  try {
    const r = esbuild.transformSync(code, {
      loader: ext === 'tsx' || ext === 'jsx' ? 'tsx' : 'ts',
      format: 'esm',
      jsx: 'transform',
      target: 'es2020',
    });
    return { code: r.code, error: null };
  } catch (e) {
    return { code: '', error: `转换失败: ${e.message}` };
  }
}

/** 扫一个文件（含 TS/TSX 转换） */
export function scanFileText(code, file = '') {
  const { code: js, error } = toJs(code, file);
  if (error) return { deny: [], review: [], error };
  return scanCode(js, { file });
}

/** 准入判定：只要命中 deny 就拒绝 */
export function admit(result) {
  return { ok: (result?.deny?.length || 0) === 0, deny: result?.deny || [], review: result?.review || [] };
}
