#!/usr/bin/env python3
"""
fast_push.py —— 只推指定文件，不回读远端文件内容。

与 PAT_push.py 的区别：PAT_push.py 会为**每个**文件调 contents API 拉远端
版本做三方比对；文件一大（mod.rs 已 1MB+）加上 base64，整体耗时常超过命令
超时，表现为 sandbox 502 —— 而此时脚本其实还在跑，并非失败。

本脚本省掉那次回读，改用「更新 ref 时带 base sha 做乐观锁」保证安全：
期间若有人先推，PATCH 会失败（非快进），绝不会静默覆盖。

前提（调用方负责确认）：
  · BASE 确实是远端最新 commit（推前刚回读过）
  · 待推文件的本地版就是要提交的版本（不冲突时使用）
"""
import os, sys, io, json, urllib.request

TOKEN = os.environ['GITHUB_TOKEN']
REPO  = os.environ.get('PAT_REPO', 'adwlachowicz684-star/tauriTools')
ROOT  = os.environ.get('PAT_ROOT', '/data/workspace/tauriTools')
API   = 'https://api.github.com/repos/' + REPO + '/'
BASE  = os.environ['PAT_BASE']
FILES = [f.strip() for f in os.environ['PAT_PUSH_FILES'].split(',') if f.strip()]
MSG   = os.environ.get('PAT_MSG', 'chore: 同步本地改动')


def api(path, data=None, method=None, tries=6):
    last = None
    for i in range(tries):
        try:
            r = urllib.request.Request(API + path, data=data, method=method)
            r.add_header('Authorization', 'Bearer ' + TOKEN)
            r.add_header('Accept', 'application/vnd.github+json')
            r.add_header('User-Agent', 'fast_push')
            with urllib.request.urlopen(r, timeout=120) as resp:
                return json.loads(resp.read())
        except Exception as e:
            last = e
            code = getattr(e, 'code', None)
            if code in (401, 403, 404, 409, 422):
                raise
            if i < tries - 1:
                import time; time.sleep(2)
    raise last


entries = []
for rel in FILES:
    p = os.path.join(ROOT, rel)
    if not os.path.exists(p):
        sys.exit('本地不存在: ' + rel)
    content = io.open(p, encoding='utf-8').read()
    blob = api('git/blobs', data=json.dumps(
        {'content': content, 'encoding': 'utf-8'}).encode(), method='POST')
    entries.append({'path': rel, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
    print('  blob %-52s %s' % (rel.split('/')[-1], blob['sha'][:10]))

# base_tree 必须是 **tree** sha，不是 commit sha（传 commit 会 422）。
c0 = api('git/commits/' + BASE)
tree = api('git/trees', data=json.dumps(
    {'base_tree': c0['tree']['sha'], 'tree': entries}).encode(), method='POST')
commit = api('git/commits', data=json.dumps(
    {'message': MSG, 'tree': tree['sha'], 'parents': [BASE]}).encode(), method='POST')

r = urllib.request.Request(API + 'git/refs/heads/main',
                           data=json.dumps({'sha': commit['sha'], 'force': False}).encode(),
                           method='PATCH')
r.add_header('Authorization', 'Bearer ' + TOKEN)
r.add_header('Accept', 'application/vnd.github+json')
r.add_header('User-Agent', 'fast_push')
try:
    with urllib.request.urlopen(r, timeout=120) as resp:
        json.loads(resp.read())
except urllib.error.HTTPError as e:
    body = e.read().decode()
    sys.exit('\n✗ 更新 ref 失败 HTTP %s（多半是远端已前进）: %s' % (e.code, body[:200]))

print('\n✅ 已推送 %s (%d 个文件)' % (commit['sha'][:10], len(entries)))
