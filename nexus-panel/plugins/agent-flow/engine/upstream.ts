/**
 * "上游给了什么" —— 透传型节点与自动取上游的节点的共同依据。
 *
 * 抽出来的直接原因：这段逻辑此前在 log / extract / condition / parallel
 * 四个执行器里**各写了一份**。其中 extract 里的注释还写着
 * "写成一处是为了三边行为一致，各写一份迟早会分叉"，
 * 结果 log 里又抄了一份 —— 注释说的是对的，只是没真做到。
 *
 * 改透传之后会有更多节点用它（wait / beep / playAudio），
 * 那时就是 7 份。先收口，再往上加。
 */

export type EdgeLike = { source: string; target: string };

/**
 * 取上游输出；没有上游则回落到工作流全局输入。
 *
 * @param join 多条入边时的连接方式。默认换行 ——
 *   多数情况下拼的是多段文本，空格连会糊成一坨看不出层次。
 */
export function upstreamText(
  edges: EdgeLike[],
  id: string,
  outputs: Record<string, string>,
  globalInput: string | undefined,
  join = '\n',
): string {
  const ups = edges.filter((e) => e.target === id).map((e) => e.source);
  if (ups.length === 0) return globalInput ?? '';
  return ups.map((u) => outputs[u] ?? '').join(join);
}

/** 有没有上游（没有时一些节点会改用全局输入或报错） */
export function hasUpstream(edges: EdgeLike[], id: string): boolean {
  return edges.some((e) => e.target === id);
}
