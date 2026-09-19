#!/usr/bin/env python3
"""
清掉编译产物里的"孤文件"：源文件已经删了、但上次编译留下的 .js。

为什么必须有：
  增量编译（tsc --incremental）**不会**删除这些产物。
  于是删掉一个测试文件后，它的 .js 还躺在产物目录里继续被跑，
  表现为"我明明删了，测试里怎么还有它"。

  这类幽灵测试最坑的是它还会失败，
  而失败信息指向一个已经不存在的文件 —— 排查方向完全是错的。

用法：python3 scripts/prune-orphans.py <源码根> <产物目录>
"""
import os
import sys


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    here, out = sys.argv[1], sys.argv[2]
    if not os.path.isdir(out):
        return 0

    removed = 0
    for dirpath, _dirs, files in os.walk(out):
        for f in files:
            if not f.endswith('.js'):
                continue
            js = os.path.join(dirpath, f)
            rel = os.path.relpath(js, out)
            stem = rel[:-3]
            # 产物 a/b.js 对应源码 a/b.ts 或 a/b.tsx
            if not any(os.path.exists(os.path.join(here, stem + ext))
                       for ext in ('.ts', '.tsx')):
                os.remove(js)
                removed += 1
    if removed:
        print(f"   清掉 {removed} 个孤产物（源文件已删）")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
