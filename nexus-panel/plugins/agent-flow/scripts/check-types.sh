#!/usr/bin/env bash
# ==================================================================
# agent-flow 真实类型检查（严格模式）
#
# ================= 为什么还需要这个脚本 =================
#
# run-tests.sh 里的编译用的是 /tmp 下的测试专用配置：
#
#     "strict": false
#
# 非严格模式下，判别联合的窄化会失效 —— 于是 `change.id` 这种
# 「联合里只有一部分成员有 id」的写法不报错，值却是 undefined。
# 真实项目跑的是 strict: true，这类问题在**真实构建里是错误**，
# 而 2200 多项测试全绿。
#
# 这不是理论风险，已经踩过一次：
#   我一度以为项目里有 392 条类型错误，差点去改本来正确的代码。
#   实际是拿非严格配置下的产物当真，虚惊一场。
#   反过来 —— 严格模式下才暴露的真错误，同样会被这套测试放过。
#
# 所以「测试全绿」这个信号至少骗过我三次：
#   1. 测试不真编译（transpile-only，语法错也全绿）
#   2. 文档不真生成（断言的是上一轮留下的旧 md）
#   3. 生成器失败不中断（打印一句就继续）
# 这是第四次：编译用的不是项目真实配置。
#
# ================= 为什么只查 agent-flow =================
#
# 全项目（39 条）里绝大部分是别的插件的既有错误
# （settings 的重复标识符、project-group 的变量先用后声明……）。
# 那些不是本插件的范围，也不该由本插件的测试去拦。
#
# include 只给 agent-flow，但 tsc 会顺着 import 把外部文件拉进来
# 一起检查 —— 所以跨文件的类型问题照样查得出，不会漏。
#
# 用法：
#   bash scripts/check-types.sh            # 检查
#   AF_SKIP_TYPES=1 bash scripts/run-tests.sh   # 跳过（跑得快时用）
# ==================================================================
set -uo pipefail

if [ "${AF_SKIP_TYPES:-0}" = "1" ]; then
  echo "== 真实类型检查：已跳过（AF_SKIP_TYPES=1）=="
  exit 0
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# agent-flow 在 nexus-panel/plugins/ 下，真实 tsconfig 在 nexus-panel/
PANEL="$(cd "$HERE/../.." && pwd)"
TSCONFIG_REAL="$PANEL/tsconfig.json"
OUT="${AF_OUT:-/tmp/afts}"
mkdir -p "$OUT"

if [ ! -f "$TSCONFIG_REAL" ]; then
  echo "✗ 找不到项目 tsconfig：$TSCONFIG_REAL"
  exit 1
fi

TSC="${AF_TSC:-$(command -v tsc || echo /data/workspace/tsenv2/node_modules/.bin/tsc)}"
if ! command -v "$TSC" >/dev/null 2>&1 && [ ! -x "$TSC" ]; then
  echo "✗ 找不到 tsc（用 AF_TSC 指定路径）"
  exit 1
fi

# ------------------------------------------------------------------
# 生成「真实配置」：完全继承项目 tsconfig，只去掉环境相关的两项
#
#   types: ["vite/client"]  —— 沙盒没装 vite，报 TS2688
#   references              —— 指向 tsconfig.node.json，与本检查无关
#
# **不要**在这里改 strict / lib / moduleResolution：
# 改了就又变成"另一套配置"，这个项目已经吃过四次这种亏。
# ------------------------------------------------------------------
python3 - "$TSCONFIG_REAL" "$HERE" "$OUT" <<'PY'
import json, re, sys, os
src_path, here, out = sys.argv[1], sys.argv[2], sys.argv[3]
raw = open(src_path, encoding='utf-8').read()
raw = re.sub(r'(^|\s)//.*', '', raw)      # 去行注释（原文件里有 _comment）
cfg = json.loads(raw)
co = cfg.get('compilerOptions', {})
co.pop('types', None)                      # vite/client 只存在于装了 vite 的环境
cfg.pop('references', None)
cfg.pop('_comment', None)
co['noEmit'] = True
co['incremental'] = True
co['tsBuildInfoFile'] = os.path.join(out, '.tsbuildinfo.real')
cfg['include'] = [
    os.path.join(here, '**', '*.ts'),
    os.path.join(here, '**', '*.tsx'),
]
cfg['exclude'] = [
    os.path.join(here, 'tests', '**'),
    os.path.join(here, 'scripts', '**'),
]
json.dump(cfg, open(os.path.join(out, 'tsconfig.real.json'), 'w'), indent=2)
PY

if [ $? -ne 0 ]; then
  echo "✗ 生成真实 tsconfig 失败"
  exit 1
fi

echo "== 真实类型检查（strict，取自 $TSCONFIG_REAL）=="
"$TSC" -p "$OUT/tsconfig.real.json" > "$OUT/tsc-real.log" 2>&1
RAW="$(grep -c 'error TS' "$OUT/tsc-real.log" || true)"

# ------------------------------------------------------------------
# 白名单：环境产物
#
# 每一条都必须写清**为什么它不是真问题**。
# 判据只有一个：换台装齐依赖的机器，这条还会不会报。会报 = 真问题。
#
# 匹配用 (文件, 错误码, 模块名) 三元组，不用行号 ——
# 行号随编辑漂移，而"这个文件 import 了这个模块"是稳定的事实。
# ------------------------------------------------------------------
python3 - "$OUT/tsc-real.log" "$HERE" <<'PY'
import re, sys, os
log_path, here = sys.argv[1], sys.argv[2]
log = open(log_path, encoding='utf-8').read()

WHY = {
    ('App.tsx', 'TS2882', '@xyflow/react/dist/style.css'):
        'CSS 副作用导入；vite 打包时由插件处理，装齐依赖后仍会报（属工具链约定）',
    ('main.tsx', 'TS2882', './styles.css'):
        '同上，本插件样式表的副作用导入',
    ('lib/channel.ts', 'TS2307', '@tauri-apps/api/core'):
        '沙盒未安装 @tauri-apps/api；CI 装了依赖就没有这条',
    ('lib/tauri.ts', 'TS2307', '@tauri-apps/api/core'):
        '同上',
    ('lib/tauri.ts', 'TS2307', '@tauri-apps/api/event'):
        '同上',
}

rows = []
for line in log.splitlines():
    m = re.match(r'^(.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$', line)
    if not m:
        continue
    path, code, msg = m.group(1), m.group(4), m.group(5)
    rel = os.path.relpath(path, here)
    mod = ''
    mm = re.search(r"'(.+?)'", msg)
    if mm:
        mod = mm.group(1)
    rows.append((rel, code, mod, m.group(2), msg))

unexpected = [r for r in rows if (r[0], r[1], r[2]) not in WHY]
extra = [k for k in WHY if not any((r[0], r[1], r[2]) == k for r in rows)]

if unexpected:
    print(f'✗ {len(unexpected)} 条不在白名单里（真类型错误）：')
    for rel, code, mod, ln, msg in unexpected:
        print(f'   {rel}:{ln}  {code}  {msg[:100]}')
    sys.exit(1)

if extra:
    # 白名单越积越宽是最危险的失效方式：它会把真错误也放过去。
    # 少了条目要么是真修好了（该删白名单），要么是环境变了 —— 都值得看一眼。
    print(f'✗ 白名单里有 {len(extra)} 条没对上（条目已失效，请核对）：')
    for k in extra:
        print(f'   {k[0]} {k[1]} {k[2]}')
    sys.exit(1)

print(f'✓ 严格模式通过（{len(rows)} 条均为已知环境产物，白名单恰好对上）')
PY

if [ $? -ne 0 ]; then
  echo "   完整日志：$OUT/tsc-real.log"
  exit 1
fi
