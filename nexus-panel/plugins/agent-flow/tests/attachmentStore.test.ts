import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyAttachments, parseAttachments, serializeAttachments,
  kindOf, extOf, baseNameOf, newAttachId, nextFreeAttachId,
  addAttachment, removeAttachment, updateAttachment,
  attachmentsOf, looseAttachments, mergeAttachments,
  type AttachmentItem, type AttachmentFile,
} from '../engine/attachmentStore';

const item = (patch: Partial<AttachmentItem> = {}): AttachmentItem => ({
  id: patch.id || 'a1',
  owner: patch.owner ?? 't1',
  ownerTitle: patch.ownerTitle ?? '设计表结构',
  path: patch.path ?? '/work/a.md',
  name: patch.name ?? 'a.md',
  note: patch.note ?? '',
  addedBy: patch.addedBy ?? 'ai',
  addedAt: patch.addedAt ?? 1,
});

const withItems = (list: AttachmentItem[]): AttachmentFile => {
  let f = emptyAttachments('p1', '项目甲');
  for (const it of list) f = addAttachment(f, it).file;
  return f;
};

/* ---------- 归类 ---------- */

test('kindOf: md / 图片 / 视频 / 音频 按扩展名分', () => {
  assert.equal(kindOf('说明.md'), 'md');
  assert.equal(kindOf('README.markdown'), 'md');
  assert.equal(kindOf('截图.PNG'), 'image', '大小写不敏感');
  assert.equal(kindOf('录屏.mp4'), 'video');
  assert.equal(kindOf('录屏.webm'), 'video');
  assert.equal(kindOf('配音.mp3'), 'audio');
  assert.equal(kindOf('数据.xlsx'), 'other');
});

test('extOf: 没有扩展名返回空串，不抛', () => {
  assert.equal(extOf('README'), '');
  assert.equal(extOf('a.'), '');
  assert.equal(extOf('归档.tar.gz'), 'gz', '取最后一段');
});

test('baseNameOf: Windows 的反斜杠也认', () => {
  assert.equal(baseNameOf('/a/b/c.md'), 'c.md');
  assert.equal(baseNameOf('D:\\项目\\说明.md'), '说明.md');
  assert.equal(baseNameOf('只有名字.md'), '只有名字.md');
});

/* ---------- 解析：手改过的文件也要能开 ---------- */

test('parseAttachments: 缺字段补默认，不是整个打不开', () => {
  const f = parseAttachments(JSON.stringify({
    order: ['x'],
    items: { x: { path: '/a/b.md' } },
  }));
  const x = f.items.x;
  assert.ok(x);
  assert.equal(x.name, 'b.md', 'name 没写就从 path 里切出来');
  assert.equal(x.owner, '');
  assert.equal(x.note, '');
});

test('parseAttachments: 既没路径也没名字的条目丢弃（留着就是一行点不开的东西）', () => {
  const f = parseAttachments(JSON.stringify({
    order: ['bad', 'ok'],
    items: { bad: {}, ok: { path: '/a.md' } },
  }));
  assert.equal(f.items.bad, undefined);
  assert.ok(f.items.ok);
  assert.deepEqual(f.order, ['ok']);
});

test('parseAttachments: 没写进 order 的补到末尾（否则根本不显示）', () => {
  const f = parseAttachments(JSON.stringify({
    order: ['a'],
    items: { a: { path: '/a.md' }, b: { path: '/b.md' } },
  }));
  assert.deepEqual(f.order, ['a', 'b']);
});

test('parseAttachments: order 里指向不存在条目的会被清掉', () => {
  const f = parseAttachments(JSON.stringify({
    order: ['a', '不存在'],
    items: { a: { path: '/a.md' } },
  }));
  assert.deepEqual(f.order, ['a']);
});

test('parseAttachments: 非 JSON 返回空清单，不抛', () => {
  assert.deepEqual(parseAttachments('不是 json').items, {});
  assert.deepEqual(parseAttachments(null).items, {});
});

test('序列化后再解析内容一致（往返）', () => {
  const f = withItems([item(), item({ id: 'a2', name: 'b.png', path: '/b.png' })]);
  assert.deepEqual(parseAttachments(serializeAttachments(f)).items, f.items);
});

/* ---------- 增删 ---------- */

test('addAttachment: 追加到末尾并出现在清单里', () => {
  const f = withItems([item()]);
  assert.equal(f.order.length, 1);
  assert.deepEqual(attachmentsOf(f, 't1').map((x) => x.id), ['a1']);
});

test('attachmentsOf: 只取该任务的，且按清单顺序', () => {
  const f = withItems([
    item({ id: 'a1', owner: 't1' }),
    item({ id: 'a2', owner: 't2' }),
    item({ id: 'a3', owner: 't1' }),
  ]);
  assert.deepEqual(attachmentsOf(f, 't1').map((x) => x.id), ['a1', 'a3']);
  assert.deepEqual(attachmentsOf(f, 't2').map((x) => x.id), ['a2']);
});

test('looseAttachments: 没挂任务的那批（AI 可能先写附件、任务还没建）', () => {
  const f = withItems([item({ id: 'a1', owner: '' }), item({ id: 'a2', owner: 't1' })]);
  assert.deepEqual(looseAttachments(f).map((x) => x.id), ['a1']);
});

test('nextFreeAttachId: 撞了就加后缀', () => {
  const f = withItems([item({ id: 'a1' })]);
  assert.equal(nextFreeAttachId(f, 'a1'), 'a1_2');
  assert.equal(nextFreeAttachId(f, '全新'), '全新');
});

test('newAttachId: 带 att_ 前缀，人（和 AI）看得懂', () => {
  assert.match(newAttachId(), /^att_/);
});

test('removeAttachment: 只删清单这一条，顺序里也去掉', () => {
  let f = withItems([item({ id: 'a1' }), item({ id: 'a2' })]);
  f = removeAttachment(f, 'a1');
  assert.equal(f.items.a1, undefined);
  assert.deepEqual(f.order, ['a2']);
});

test('updateAttachment: 改备注不动别的字段', () => {
  let f = withItems([item()]);
  f = updateAttachment(f, 'a1', { note: '初版' });
  assert.equal(f.items.a1.note, '初版');
  assert.equal(f.items.a1.path, '/work/a.md');
});

test('改动都会推进 updatedAt（外部看得出这份是新的）', () => {
  const f = withItems([item()]);
  assert.ok(updateAttachment(f, 'a1', { note: 'x' }).updatedAt >= f.updatedAt);
});

/* ---------- 与外部改动合并 ---------- */

const withNote = (f: AttachmentFile, id: string, note: string): AttachmentFile => ({
  ...f,
  items: { ...f.items, [id]: { ...f.items[id], note } },
});

test('mergeAttachments: 只有我改 → 用我的', () => {
  const base = withItems([item()]);
  const mine = withNote(base, 'a1', '我写的');
  const out = mergeAttachments(base, mine, base);
  assert.equal(out.file.items.a1.note, '我写的');
  assert.deepEqual(out.overwritten, []);
});

test('mergeAttachments: 只有外部改 → 用外部的', () => {
  const base = withItems([item()]);
  const theirs = withNote(base, 'a1', 'AI 写的');
  const out = mergeAttachments(base, base, theirs);
  assert.equal(out.file.items.a1.note, 'AI 写的');
});

test('mergeAttachments: 两边都改 → 外部优先，并记进 overwritten', () => {
  const base = withItems([item()]);
  const mine = withNote(base, 'a1', '我写的');
  const theirs = withNote(base, 'a1', 'AI 写的');
  const out = mergeAttachments(base, mine, theirs);
  assert.equal(out.file.items.a1.note, 'AI 写的', 'AI 改文件是主路径，不能让它无声失效');
  assert.deepEqual(out.overwritten, ['a1']);
});

test('mergeAttachments: 外部新增的进来并记进 added', () => {
  const base = withItems([item()]);
  const theirs = withItems([item(), item({ id: 'a2', name: 'b.png' })]);
  const out = mergeAttachments(base, base, theirs);
  assert.ok(out.file.items.a2);
  assert.deepEqual(out.added, ['a2']);
});

test('mergeAttachments: 我新增的留着', () => {
  const base = withItems([item()]);
  const mine = withItems([item(), item({ id: 'a2' })]);
  const out = mergeAttachments(base, mine, base);
  assert.ok(out.file.items.a2);
});

test('mergeAttachments: 两边改成同一份不算冲突', () => {
  const base = withItems([item()]);
  const same = withNote(base, 'a1', '一样的');
  const out = mergeAttachments(base, same, same);
  assert.deepEqual(out.overwritten, []);
});

test('mergeAttachments: 只剩路径的孤立条目不会被丢（它可能是 AI 刚写的）', () => {
  const base = emptyAttachments('p1', '项目甲');
  const theirs = withItems([item({ id: 'a1' })]);
  const out = mergeAttachments(base, base, theirs);
  assert.ok(out.file.order.indexOf('a1') >= 0);
});
