import type { FileRef } from './files';
import { FILE_FIELD_NAMES } from './files';

/**
 * 节点输出参数。
 *
 * CLI 节点的产出是自然语言文本，下游想精确拿到其中某个值
 * （比如"改了哪个文件"）就得靠参数声明，而不是让每个下游各自写正则。
 */
export type ParamSource =
  | 'files'   /** 取识别到的文件路径 */
  | 'regex'   /** 用自定义正则从输出里捕获 */
  | 'manual'; /** 固定值，相当于给下游起个常量别名 */

export const PARAM_SOURCE_META: Record<ParamSource, {
  label: string;
  hint: string;
  /** 是否需要填 pattern / value */
  needs: 'none' | 'pattern' | 'value';
}> = {
  files: {
    label: '文件路径',
    hint: '取本节点识别到的文件。序号填 0 或不填表示全部（换行分隔）',
    needs: 'none',
  },
  regex: {
    label: '正则捕获',
    hint: '从本节点输出里正则提取。有捕获组时取第一个组，否则取整段匹配',
    needs: 'pattern',
  },
  manual: {
    label: '固定值',
    hint: '直接指定内容，可作为常量传给下游',
    needs: 'value',
  },
};

export type NodeParam = {
  id: string;
  /** 参数名，下游用 {{nodeId.参数名}} 引用 */
  name: string;
  source: ParamSource;
  /** regex 的正则；语法错误时该参数取空串 */
  pattern?: string;
  /** manual 的固定值 */
  value?: string;
  /**
   * 取第几个（1 起）。
   * 0 或省略 = 全部（换行分隔）；超出范围时取空串
   */
  index?: number;
  enabled?: boolean;
};

export type ParamResolveCtx = {
  /** 节点的原始输出文本 */
  output: string;
  /** 已识别到的文件（已拼好 workdir） */
  refs: FileRef[];
};

/** 按 index 取一项或全部。index 从 1 起，<=0 表示全部 */
function pickAt(values: string[], index?: number): string {
  if (values.length === 0) return '';
  const i = index ?? 0;
  if (i <= 0) return values.join('\n');
  return values[i - 1] ?? '';
}

/**
 * 解析一个参数。
 *
 * 非法正则不抛异常 —— 否则一个手误就能让整条流水线挂掉，
 * 而参数只是"锦上添花"的信息，取空串继续跑更合适。
 */
export function resolveParam(param: NodeParam, ctx: ParamResolveCtx): string {
  if (!param || param.enabled === false) return '';

  switch (param.source) {
    case 'manual':
      return param.value ?? '';

    case 'files':
      return pickAt(ctx.refs.map((r) => r.abs), param.index);

    case 'regex': {
      const p = (param.pattern ?? '').trim();
      if (!p) return '';
      try {
        const re = new RegExp(p, 'g');
        const values: string[] = [];
        let m: RegExpExecArray | null;
        // 防止用户写一个能匹配空串的正则导致死循环
        while ((m = re.exec(ctx.output)) !== null) {
          values.push(m[1] !== undefined ? m[1] : m[0]);
          if (m[0] === '') re.lastIndex += 1;
          if (values.length > 500) break;
        }
        return pickAt(values, param.index);
      } catch {
        return '';
      }
    }
    default:
      return '';
  }
}

/** 批量解析；同名参数后者覆盖前者（界面上会提示重名） */
export function resolveParams(
  params: NodeParam[] | undefined,
  ctx: ParamResolveCtx,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of params ?? []) {
    if (!p || p.enabled === false) continue;
    const name = (p.name ?? '').trim();
    if (!name) continue;
    out[name] = resolveParam(p, ctx);
  }
  return out;
}

export type ParamIssue = { level: 'warn' | 'error'; message: string };

/**
 * 校验一个参数配置。
 *
 * 重点是"配了但拿不到值"的情况 —— 这类问题运行时静默返回空串，
 * 下游拿到空值还以为成功了，只能靠编辑时提示。
 */
export function validateParam(param: NodeParam): ParamIssue[] {
  const issues: ParamIssue[] = [];
  if (!param) return issues;

  const name = (param.name ?? '').trim();
  if (!name) {
    issues.push({ level: 'error', message: '参数名为空，下游无法引用' });
  } else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    // 模板变量只认这个字符集，别的写法会被当成别的节点 id
    issues.push({
      level: 'error',
      message: `参数名「${name}」含非法字符，只能用字母/数字/下划线且不以数字开头`,
    });
  } else if (name === 'output') {
    issues.push({ level: 'error', message: 'output 是节点主输出的保留名，请换一个' });
  } else if (FILE_RESERVED.has(name)) {
    issues.push({ level: 'warn', message: `与内置文件字段「${name}」同名，自定义参数会覆盖它` });
  }

  if (param.source === 'regex') {
    const p = (param.pattern ?? '').trim();
    if (!p) {
      issues.push({ level: 'warn', message: '正则为空，这个参数永远取不到值' });
    } else {
      try {
        new RegExp(p);
      } catch (err) {
        issues.push({
          level: 'error',
          message: `正则写错了：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  if (param.source === 'manual' && !(param.value ?? '').trim()) {
    issues.push({ level: 'warn', message: '固定值为空，下游会拿到空串' });
  }

  return issues;
}

/**
 * 内置文件字段。自定义参数若同名会覆盖它们 ——
 * 直接复用 files.ts 的定义，避免两处各写一份而悄悄分叉。
 */
export const FILE_RESERVED: Set<string> = new Set(FILE_FIELD_NAMES);

/** 校验整组参数，额外检查重名 */
export function validateParams(params: NodeParam[] | undefined): ParamIssue[] {
  const issues: ParamIssue[] = [];
  const seen = new Map<string, number>();

  (params ?? []).forEach((p, i) => {
    for (const it of validateParam(p)) issues.push(it);
    const name = (p?.name ?? '').trim();
    if (!name) return;
    if (seen.has(name)) {
      issues.push({
        level: 'warn',
        message: `参数名「${name}」重复（第 ${seen.get(name)! + 1} 与第 ${i + 1} 条），后者会覆盖前者`,
      });
    } else {
      seen.set(name, i);
    }
  });

  return issues;
}

let paramSeq = 0;
export function makeParam(partial: Partial<NodeParam> = {}): NodeParam {
  paramSeq += 1;
  return {
    id: partial.id ?? `p${paramSeq}_${Date.now().toString(36)}`,
    name: partial.name ?? `arg${paramSeq}`,
    source: partial.source ?? 'files',
    pattern: partial.pattern ?? '',
    value: partial.value ?? '',
    index: partial.index ?? 0,
    enabled: partial.enabled ?? true,
  };
}
