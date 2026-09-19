#!/usr/bin/env bash
# 跑 agent-flow 的单元测试。
#
# ============ 为什么用 tsc 编译，而不是正则剥离 ============
#
# 以前用 scripts/strip-ts.py（600 行正则）把 .ts 剥成 .mjs。
# 它累计踩了 12 个坑，而且每一类都是**静默产出坏代码**：
#   · 默认参数里的字符串 ',' 被改成 ', ' → CSV 往返悄悄坏掉
#   · 泛型参数列表 <T> 剥不掉 → 生成的文件直接语法错误
#   · 跨行类型断言剥不干净 → SyntaxError
#   · 注释里的 /* 被当成边界 → 字面量正则失效
# 每加一个新函数都可能撞上，代价是持续的。
#
# 而 typescript 本来就是项目的 devDependency —— 用真正的编译器
# 取代正则，那些坑**整体消失**，顺带还能顺手抓出类型错误。
#
# ============ 为什么编译成 CommonJS ============
#
# 测试用 `node --test`，它支持 CJS。
# 而 CJS 的 require 天然支持无扩展名路径（'../engine/stack'），
# 于是**不再需要 import-map 那套手工映射** ——
# 以前每个新模块都要去 build-tests.sh 里补一条 --import-map，
# 漏一条就是 ERR_MODULE_NOT_FOUND。
#
# ============ 用法 ============
#   bash scripts/run-tests.sh             # 跑全部
#   bash scripts/run-tests.sh stackDrop   # 只跑名字含 stackDrop 的
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${AF_OUT:-/tmp/afts}"
TSCONFIG="${AF_TSCONFIG:-/tmp/tsconfig.aftest.json}"

# 源码守卫类测试要靠 AF_SRC 找到仓库里的源文件（它们检查的是源码本身）
export AF_SRC="$(pwd -W 2>/dev/null || pwd)"

# ------------------------------------------------------------------
# 生成测试专用的 tsconfig。
#
# 放在 /tmp 而不是仓库里：这是**沙盒验证用**的配置，
# 项目本身跑的是 vite build + smoke-test，不需要它。
# ------------------------------------------------------------------
cat > "$TSCONFIG" <<JSON
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "moduleResolution": "node",
    "rootDir": "$HERE",
    "outDir": "$OUT",
    "jsx": "react-jsx",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmitOnError": false,
    "incremental": true,
    "tsBuildInfoFile": "$OUT/.tsbuildinfo",
    "types": [],
    "strict": false
  },
  "include": [
    "$HERE/tests/**/*.ts",
    "$HERE/engine/**/*.ts",
    "$HERE/types.ts"
  ]
}
JSON

# ------------------------------------------------------------------
# 清掉"孤产物"：源文件已经删了、但上次编译留下的 .js
# （详见 scripts/prune-orphans.py）
# ------------------------------------------------------------------
python3 "$HERE/scripts/prune-orphans.py" "$HERE" "$OUT"

echo "== 编译（tsc）=="
TSC="${AF_TSC:-$(command -v tsc || echo /data/workspace/tsenv2/node_modules/.bin/tsc)}"
"$TSC" -p "$TSCONFIG" > /tmp/afts-tsc.log 2>&1
# noEmitOnError=false，有类型错误也会照常输出 JS；
# 但编译本身失败（语法错）就没有产物了，要拦住
if [ ! -d "$OUT/tests" ]; then
  echo "✗ 编译没有产出，错误如下："
  head -30 /tmp/afts-tsc.log
  exit 1
fi
echo "   产物在 $OUT"

# ------------------------------------------------------------------
# 跑测试
# ------------------------------------------------------------------
cd "$OUT"
if [ $# -gt 0 ]; then
  echo "== 跑测试（筛选：$*）=="
  node --test --test-name-pattern="$1" tests/ 2>&1
else
  echo "== 跑测试 =="
  node --test tests/ 2>&1
fi
