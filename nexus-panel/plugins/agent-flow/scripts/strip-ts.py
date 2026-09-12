#!/usr/bin/env python3
"""
把 TypeScript 源码剥离成可运行的 JavaScript（ESM）。

用途：沙盒里装不全 tsc/tsx 时，用它把 src/engine 下的纯逻辑转成 .mjs，
再用 node --test 跑真正的单元测试。只处理本项目用到的 TS 语法子集。

用法：python3 scripts/strip-ts.py <in.ts> <out.mjs> [--import-map from=to ...]
"""
import re
import sys


# 这些字符（或行首）之后出现的 / 才是正则字面量的开头，而不是除号。
# 注意不能含 < ：JSX 的 </div> 会被误判。
_REGEX_PREV = set('(,=:[!&|?{};+-*%~^')


def _starts_regex(src: str, i: int) -> bool:
    """判断 src[i] == '/' 是否开启一个正则字面量"""
    j = i - 1
    while j >= 0 and src[j] in ' \t':
        j -= 1
    if j < 0:
        return True  # 行首
    return src[j] in _REGEX_PREV


def remove_comments(src: str) -> str:
    """
    去掉 // 与 /* */ 注释，且不影响字符串 / 模板串 / 正则字面量的内容。

    必须识别正则字面量，否则会被里面的引号带偏状态机：
        /rel\s*=\s*["']alternate["']/i
    朴素实现会把 ["'] 当成字符串开始，之后一路错位，
    最终把某个 URL 里的 // 当注释删掉（如 'https://...' 被切成 'https:）。
    """
    out = []
    i, n = 0, len(src)
    state = None
    quote = ''
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ''
        if state is None:
            if c == '/' and nxt == '*':
                state = 'block'; i += 2; continue
            if c == '/' and nxt == '/':
                state = 'line'; i += 2; continue
            if c == '/' and nxt not in ('/', '*') and _starts_regex(src, i):
                # 正则字面量：整段照抄，直到未转义的 / 结束（不跨行）
                out.append(c); i += 1
                in_class = False
                while i < n:
                    ch = src[i]
                    if ch == '\\':
                        out.append(src[i:i + 2]); i += 2; continue
                    if ch == '\n':
                        break
                    if ch == '[':
                        in_class = True
                    elif ch == ']':
                        in_class = False
                    elif ch == '/' and not in_class:
                        out.append(ch); i += 1; break
                    out.append(ch); i += 1
                while i < n and src[i].isalpha():   # flags
                    out.append(src[i]); i += 1
                continue
            if c in '"\'':
                state = 'str'; quote = c; out.append(c); i += 1; continue
            if c == '`':
                state = 'tpl'; out.append(c); i += 1; continue
            out.append(c); i += 1; continue
        if state == 'block':
            if c == '*' and nxt == '/':
                state = None; i += 2; continue
            if c == '\n':
                out.append('\n')
            i += 1; continue
        if state == 'line':
            if c == '\n':
                state = None; out.append('\n')
            i += 1; continue
        if state == 'str':
            out.append(c)
            if c == '\\':
                if i + 1 < n:
                    out.append(src[i + 1]); i += 2; continue
            elif c == quote:
                state = None
            i += 1; continue
        if state == 'tpl':
            out.append(c)
            if c == '\\':
                if i + 1 < n:
                    out.append(src[i + 1]); i += 2; continue
            elif c == '`':
                state = None
            i += 1; continue
    return ''.join(out)


def clean_import_types(src: str) -> str:
    """
    去掉 import 语句里的内联 type 修饰符：import { a, type B } -> import { a }

    必须按"整个 import 语句"处理，不能只看以 import 开头的那一行：
        import {
          a,
          type B,          <- 这一行不以 import 开头
        } from './x';
    只处理单行的话 type B 会被留下，生成的 .mjs 里就是裸标识符，直接语法错误。
    """
    lines = src.split('\n')
    out = []
    in_import = False
    for line in lines:
        starts = re.match(r'^\s*import\s', line) is not None
        if starts:
            in_import = '{' in line and '}' not in line
        is_type_only = re.match(r'^\s*import\s+type\s', line) is not None

        if starts or in_import:
            line = re.sub(r'\btype\s+[A-Za-z_]\w*\s*,\s*', '', line)
            line = re.sub(r',\s*\btype\s+[A-Za-z_]\w*\s*', '', line)
            line = re.sub(r'\{\s*\btype\s+[A-Za-z_]\w*\s*\}', '{}', line)
            # 整行只剩一个 type 项的情况
            if re.match(r'^\s*type\s+[A-Za-z_]\w*\s*,?\s*$', line):
                line = ''
            if in_import and '}' in line:
                in_import = False

        out.append(line)
    src = '\n'.join(out)
    # 多行 import 里被清空后可能出现 `, ,`
    src = re.sub(r',(\s*\n\s*),', r',\1', src)
    void = is_type_only
    del void
    return src


def remove_as(src: str) -> str:
    """移除 X as <Type> 断言，支持对象类型 { ... } 与泛型数组后缀 []"""
    out = []
    i, n = 0, len(src)
    while i < n:
        if src.startswith('as', i) and (i == 0 or src[i - 1] in ' \n\t(') \
           and (i + 2 >= n or src[i + 2] in ' \n\t{'):
            j = i + 2
            while j < n and src[j] == ' ':
                j += 1
            if j >= n:
                break
            if src[j] == '{':
                depth, k = 0, j
                while k < n:
                    if src[k] == '{':
                        depth += 1
                    elif src[k] == '}':
                        depth -= 1
                        if depth == 0:
                            k += 1
                            break
                    k += 1
            else:
                k, depth = j, 0
                # 类型断言若是联合类型（as X | undefined），
                # 只删 `as X` 会留下 `| undefined` 变成按位或运算，
                # 例如 `(n?.data as Partial<T> | undefined)?.kind` 会变成
                # `(n?.data | undefined)?.kind` → 恒为 0，静默改变语义。
                # 这里一路扫到联合结束，整体移除。
                while k < n:
                    c = src[k]
                    if c == '<':
                        depth += 1
                    elif c == '>':
                        if depth > 0:
                            depth -= 1
                        else:
                            break
                    elif depth == 0 and c in ' ,;).=!\n\t':
                        break
                    k += 1
            # 吃掉数组后缀 [] 等
            while k < n and src[k] == '[':
                close = src.find(']', k)
                if close == -1:
                    break
                k = close + 1
            i = k
            continue
        out.append(src[i])
        i += 1
    return ''.join(out)


def strip_ts(src: str) -> str:
    lines = src.split('\n')
    out = []
    i = 0
    # 1) 删除 import type / type / export type / interface 声明（以分号结束）
    while i < len(lines):
        st = lines[i].strip()
        if re.match(r'^import\s+type\s', st) \
           or re.match(r'^export\s+type\s+\w+\s*(<[^>]*>)?\s*=', st) \
           or re.match(r'^type\s+\w+\s*(<[^>]*>)?\s*=', st) \
           or re.match(r'^export\s+interface\s', st) \
           or re.match(r'^export\s+type\s*\{', st):
            depth = 0
            j = i
            while j < len(lines):
                depth += lines[j].count('{') - lines[j].count('}')
                depth += lines[j].count('(') - lines[j].count(')')
                if depth <= 0 and lines[j].rstrip().endswith(';'):
                    break
                j += 1
            i = j + 1
            continue
        out.append(lines[i])
        i += 1
    src = '\n'.join(out)

    # 1.5) 非空断言（放最前，避免 `let x!: T;` 这类被后续规则漏掉）
    src = re.sub(r'([\w\)])!(?=[;).,\s\}\)\]:])', r'\1', src)

    # 1.9) 函数声明的泛型参数：function foo<A, B>(  ->  function foo(
    # 只处理紧跟在函数名后的 <...>，避免误伤箭头函数体
    src = re.sub(r'(\bfunction\s+\w+)\s*<[^<>]*>\s*\(', r'\1(', src)

    # 2) 泛型实例化
    # 泛型实参可能是嵌套的（如 Map<string, Set<string>>），
    # 旧写法 [^<>]* 匹配不到，会残留 `<...>` 导致 "Missing initializer"。
    # 这里允许一层嵌套：  < 普通段 ( <普通段> 普通段 )* >
    _NESTED = r'[^<>]*(?:<[^<>]*>[^<>]*)*'
    src = re.sub(r'new\s+(Set|Map)<' + _NESTED + r'>\(\)', r'new \1()', src)
    src = re.sub(r'new\s+(Set|Map)<' + _NESTED + r'>\(', r'new \1(', src)

    # 3) 访问修饰符
    src = re.sub(r'\b(private|readonly|public|protected)\s+', '', src)

    # 3.2) 变量声明注解（带初始化）
    src = re.sub(r'\b(const|let|var)\s+(\w+)\s*:\s*[A-Za-z_][\w.<>\[\]|\s,]*?(?=\s*=\s*[^=])', r'\1 \2', src)

    # 3.4) 复杂类型注解（含 Record<...>/{...} 等），括号平衡扫描到赋值等号
    def strip_complex_annotations(src):
        out = []
        i, n = 0, len(src)
        pat = re.compile(r'(?:export\s+)?(?:const|let|var)\s+(\w+)\s*:')
        while i < n:
            m = pat.match(src, i)
            if not m:
                out.append(src[i]); i += 1; continue
            # 从冒号后开始扫描，深度归零时遇到的第一个单独 = 即赋值
            j = m.end()
            depth = 0
            found = -1
            while j < n:
                c = src[j]
                # 索引签名 DeleteResult<N,E>['x'] 带引号，
                # 必须整段跳过字符串，否则引号被当括号会让 depth 错乱
                if c in "'\"":
                    q = c
                    j += 1
                    while j < n and src[j] != q:
                        if src[j] == '\\':
                            j += 1
                        j += 1
                    j += 1
                    continue
                if c in '<{([\'"`':
                    depth += 1
                elif c in '>})]':
                    depth -= 1
                elif c == '=' and depth <= 0:
                    if j + 1 < n and src[j + 1] != '=':
                        found = j
                        break
                elif c == '\n' and depth <= 0:
                    break  # 换行且不在类型内部 → 不是初始化声明
                j += 1
            if found != -1:
                # 冒号(含)到等号之间整段删掉，保留后置空格
                out.append(m.group(0)[:-1] + ' ')
                i = found
                continue
            out.append(src[i]); i += 1
        return ''.join(out)

    src = strip_complex_annotations(src)

    # 3.5) 变量声明注解（无初始化）
    src = re.sub(r'\b(const|let|var)\s+(\w+)\s*:\s*[A-Za-z_][\w.<>\[\]|\s,]*?;', r'\1 \2;', src)

    # 3.6) 无初始化且类型含 => 的变量（如 let release!: () => void;）
    src = re.sub(r'\b(const|let|var)\s+(\w+)\s*:\s*(?:[^;=\n]|=>)*;', r'\1 \2;', src)

    # 4) 类字段
    # 注意 (?<![=!<>]) 与 (?![=>])：避免把 ===、>=、!= 当赋值等号吃掉
    src = re.sub(r'^(\s*)(\w+)\s*:\s*[A-Za-z_][\w.<>\[\]|\s{}]*?(?<![=!<>])=(?![=>])', r'\1\2 = ', src, flags=re.M)
    src = re.sub(r'^(\s*)(\w+)\s*:\s*[A-Za-z_][\w.<>\[\]|\s{}]*?;\s*$', '', src, flags=re.M)

    # 5) 函数返回类型（含对象字面量类型 / 联合类型）
    src = re.sub(r'\)\s*:\s*[A-Za-z_{][\w.<>\[\]|\s,{};:\'"-]*?\s*\{\s*$', ') {', src, flags=re.M)

    # 5.5) 箭头函数返回类型：): Type =>   ->  ) =>
    src = re.sub(r'\)\s*:\s*[^=\n]{0,200}?=>', ') =>', src)

    # 6) 参数注解：平衡括号扫描，避免被 new Date() 截断
    def is_body(src, j):
        k = j + 1
        while k < len(src) and src[k] in ' \n\t':
            k += 1
        return src.startswith('{', k) or src.startswith('=>', k)

    def clean_param_list(inner):
        parts, depth, cur = [], 0, ''
        for ch in inner:
            if ch in '([{<':
                depth += 1
            elif ch in ')]}>':
                depth -= 1
            if ch == ',' and depth == 0:
                parts.append(cur); cur = ''
            else:
                cur += ch
        parts.append(cur)
        res = []
        for p in parts:
            p = p.strip()
            if not p:
                continue
            idx = p.find(':')
            if idx != -1:
                name = p[:idx].strip().replace('?', '')
                rest = p[idx + 1:]
                # 找默认值等号：跳过 == 和 =>（函数类型里常见）
                eq = -1
                k = 0
                while k < len(rest):
                    if rest[k] == '=' and (k + 1 >= len(rest) or rest[k + 1] not in '=>'):
                        eq = k
                        break
                    k += 1
                if eq != -1:
                    name = name + ' = ' + rest[eq + 1:].strip()
                p = name
            res.append(p)
        return ', '.join(res)

    def clean_all_params(src):
        out, i, n = [], 0, len(src)
        while i < n:
            if src[i] == '(':
                depth, j = 0, i
                while j < n:
                    if src[j] in '([{':
                        depth += 1
                    elif src[j] in ')]}':
                        depth -= 1
                        if depth == 0:
                            break
                    j += 1
                if j < n and is_body(src, j):
                    out.append('(' + clean_param_list(src[i + 1:j]) + ')')
                    i = j + 1
                    continue
            out.append(src[i]); i += 1
        return ''.join(out)

    src = clean_all_params(src)

    # 7) 非空断言


    # 8) as 断言
    src = remove_as(src)

    # 9) 孤立残留类型行（大写开头）
    src = re.sub(r'^\s*[A-Z][\w.<>\[\]|\s,]*;\s*$', '', src, flags=re.M)

    return src


def main():
    args = sys.argv[1:]
    inp = outp = None
    imports = {}
    i = 0
    while i < len(args):
        if args[i] == '--import-map':
            k, v = args[i + 1].split('=', 1)
            imports[k] = v
            i += 2
        elif inp is None:
            inp = args[i]; i += 1
        elif outp is None:
            outp = args[i]; i += 1
        else:
            i += 1

    s = open(inp, encoding='utf-8').read()
    s = remove_comments(s)
    s = clean_import_types(s)
    s = strip_ts(s)
    for k, v in imports.items():
        s = s.replace(f"from '{k}'", f"from '{v}'")
    open(outp, 'w', encoding='utf-8').write(s)
    print(f'OK {inp} -> {outp}')


if __name__ == '__main__':
    main()
