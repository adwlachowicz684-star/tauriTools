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
 * 依赖：**typescript**（项目已有的 devDependency）。
 * 它原生解析 JS / JSX / TS / TSX，不引入任何新依赖。
 *
 * 已知局限（诚实列出，别把"没扫到"当成"没问题"）
 * ------------------------------------------------------------
 * 1. **解构后调用绕得过**：
 *      const { define } = customElements; define('x', class{});
 *    callee 是裸标识符，不做作用域分析就认不出来。
 *    （要堵需上作用域分析，成本与收益不成比例；iframe 兜底。）
 * 2. **只在构建/CI 期跑，不做运行时校验**：
 *    typescript 编译器进不了前端产物（体积），
 *    所以这一层是**开发期闸门**，运行时的不可信插件仍靠 iframe 隔离。
 *    这正是分级模型的含义：L1 可信（CI 扫过）+ L2 不可信（沙箱）。
 */
/*
 * 解析器选型：**用 typescript 而不是 acorn + esbuild**。
 *
 * 第一版用了 acorn（解析）+ esbuild（TS/TSX 转 JS），但实测发现
 * acorn **不在项目依赖里**（vite 依赖 esbuild，rollup 的 acorn 是内置的），
 * 于是这个脚本在干净环境里直接跑不起来。
 * 而 typescript 是项目**已有**的 devDependency，且原生支持
 * JS / JSX / TS / TSX，一步到位，不需要二次转换。
 *
 * 选择依赖已经存在的解析器，比引入新依赖更可靠。
 */
import ts from 'typescript';

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

/** 把属性访问链渲染成 `window.document.body` 这样的点号串 */
export function renderMember(node) {
  const parts = [];
  let n = node;
  while (n) {
    if (ts.isIdentifier(n)) {
      parts.unshift(n.text ?? n.escapedText);
      break;
    }
    if (n.kind === ts.SyntaxKind.ThisKeyword) {
      parts.unshift('this');
      break;
    }
    if (ts.isPropertyAccessExpression(n)) {
      parts.unshift(n.name?.text ?? n.name?.escapedText ?? '?');
      n = n.expression;
      continue;
    }
    if (ts.isElementAccessExpression(n)) {
      /* 动态成员（a[b]）：静态无法判定，用 `[?]` 标记 */
      parts.unshift('[?]');
      n = n.expression;
      continue;
    }
    return null;
  }
  return parts.join('.');
}

/** 链的根是否是宿主全局对象 */
export function isGlobalRoot(node) {
  let n = node;
  while (n && (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))) {
    n = n.expression;
  }
  return !!n && ts.isIdentifier(n) && GLOBAL_ROOTS.has(n.text ?? n.escapedText);
}

/** 链里是否出现 X.prototype（原型修改 = 全局生效且影响其它插件） */
function hasPrototype(node) {
  let n = node;
  while (n && (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))) {
    if (ts.isPropertyAccessExpression(n) && (n.name?.text ?? n.name?.escapedText) === 'prototype') {
      return true;
    }
    n = n.expression;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                */
/* ------------------------------------------------------------------ */

/**
 * 扫一段源码（JS / JSX / TS / TSX 皆可）。
 *
 * @param {string} code
 * @param {{file?: string}} [opts]
 * @returns {{deny: object[], review: object[], error?: string}}
 */
export function scanCode(code, opts = {}) {
  const file = opts.file || 'inline.js';
  const deny = [];
  const review = [];
  const push = (arr, rule, node, detail) => {
    const pos = node ? ts.getLineAndCharacterOfPosition(sf, node.getStart(sf)) : { line: 0 };
    arr.push({ rule, file, line: pos.line + 1, detail });
  };

  const sf = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindOf(file),
  );

  /*
   * 语法错误：ts 不抛异常，而是产出诊断。必须**主动查** ——
   * 静默当成"解析成功"会让危险代码藏在解析不了的文件里，
   * 这是最大的假绿。
   */
  const diags = sf.parseDiagnostics || [];
  if (diags.length) {
    const first = diags[0];
    return { deny, review, error: `解析失败: ${ts.flattenDiagnosticMessageText(first.messageText, ' ')}` };
  }

  const visit = (node) => {
    /* ---------- 调用 ---------- */
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const path = renderMember(callee);
        if (path) {
          /* 自定义元素：**无法 undefine**，进程内永久残留 */
          if (/(^|\.)customElements\.define$/.test(path)) {
            push(deny, 'custom-element', node, path);
          } else if (/serviceWorker\.register$/.test(path)) {
            push(deny, 'service-worker', node, path);
          } else if (/^Object\.(defineProperty|defineProperties|freeze|seal)$/.test(path)) {
            const target = node.arguments?.[0];
            if (target && (isGlobalRoot(target) || hasPrototype(target))) {
              push(deny, 'define-property-host', node, renderMember(target) || path);
            }
          } else if (/^history\.(pushState|replaceState)$/.test(path)) {
            push(deny, 'history-navigate', node, path);
          } else if (/^location\.(assign|replace)$/.test(path)) {
            push(deny, 'location-navigate', node, path);
          } else if (path.includes('[?]') && isGlobalRoot(callee)) {
            /*
             * 根是宿主全局的动态调用（window[x].define(...)）。
             *
             * 只挑这类，不对所有 `obj[x]()` 都报 ——
             * 第一版太宽，一次扫出 23 条噪音（普通动态分发也算），
             * 噪音会淹没队列，等于没有队列。
             */
            push(review, 'unresolvable-call', node, path);
          } else if (/^(window|globalThis)\.(setInterval|setTimeout)$/.test(path)) {
            push(review, 'timer-via-owned', node, path);
          } else if (/^document\.(body|documentElement)\.appendChild$/.test(path)) {
            push(review, 'portal-via-owned', node, path);
          } else if (/^window\.open$/.test(path)) {
            push(review, 'window-open', node, path);
          }
        }
      }
    }

    /* ---------- 赋值 ---------- */
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
        if (hasPrototype(left)) {
          push(deny, 'prototype-mutation', node, renderMember(left) || '?');
        } else {
          const path = renderMember(left);
          if (path && /^((window|document|globalThis|top)\.)?location(\.href)?$/.test(path)) {
            push(deny, 'location-navigate', node, path);
          } else if (isGlobalRoot(left)) {
            const dynamic = path?.includes('[?]');
            push(review, dynamic ? 'global-write-dynamic' : 'global-write', node, path || '?');
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return { deny, review };
}

/** 按扩展名选 ScriptKind —— 让 TS 直接吃 TSX，不需要二次转换 */
function scriptKindOf(file) {
  const ext = (file.split('.').pop() || 'js').toLowerCase();
  if (ext === 'tsx' || ext === 'jsx') return ts.ScriptKind.TSX;
  if (ext === 'ts' || ext === 'mts' || ext === 'cts') return ts.ScriptKind.TS;
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.JS;
}

/* ------------------------------------------------------------------ */
/* 文件入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 扫一个文件。typescript 原生支持 JS/JSX/TS/TSX，直接解析即可，
 * 不需要先转成 JS —— 少一步就少一处"转换失败被当成没问题"的风险。
 */
export function scanFileText(code, file = '') {
  return scanCode(code, { file });
}

/** 准入判定：只要命中 deny 就拒绝 */
export function admit(result) {
  return { ok: (result?.deny?.length || 0) === 0, deny: result?.deny || [], review: result?.review || [] };
}
