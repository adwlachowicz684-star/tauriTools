/*
 * ==================================================================
 * 图片来源那两张卡的**共享部分**
 *
 * ================= 为什么单独一个文件 =================
 *
 * 参数卡片层是 `nodes/paramCards.ts`，但它是 **.ts**：
 * 一旦出现 JSX（手写面板的 render），就必须放进 .tsx。
 *
 * 而 tests/ 是在 node 下跑的（见 scripts/run-tests.sh），
 * **不能把 components/ 拉进测试的运行期依赖** ——
 * 实测过：测试里 import components/inspectors/fields 会直接失败。
 * 让 paramCards 去 import 它，等于让每张卡的守卫都跑不起来。
 *
 * 所以带 JSX 的部分放这里，只被 defs/ 下的节点引用
 * （defs 在测试里只被**读源码**，不会被 import）。
 *
 * ================= 这里放什么、不放什么 =================
 *
 * 只放 **render 与 when**，不放整张卡（spec / key 仍写在节点上）。
 *
 * 因为参数文档生成器（scripts/gen-node-docs.mjs）是**按字面量块**
 * 从 nodes/defs/*.tsx 里读参数的：整张卡搬到这个文件之后，
 * 生成器在 def 里只看到一个 `imageUrlCard()` 调用、认不出它是参数，
 * 于是 `url` / `path` 两项会从参数表里**整个消失**（实测如此，不报错）。
 *
 * 这正是"节点层与参数层分开"最容易漏的一处：
 * 改了节点、漏了读节点的那个人。
 *
 * 而 spec.keys 留在节点上反而是对的：它是**契约与文档取参数名的唯一
 * 来源**，写在节点里能被 tests/paramCards.test.ts 逐块对账
 * （key 必须属于 spec.keys）。以前 ocr 那份正是把 spec.keys 抄错了 ——
 * 地址那块写成 ['path']、本地路径那块写成 ['prompt','detail']，
 * 于是文档里"图片地址"被写成 path，真正的 path 反而没出现。
 *
 * ==================================================================
 */
import { canReadImage } from '../lib/tauri';
import {
  Field, VarBar, upstreamTokens, upstreamFileTokens, type FieldRenderProps,
} from '../components/inspectors/fields';

/** 「图片地址」那一行 —— llmChat 与 ocr 共用 */
export function renderImageUrl(p: FieldRenderProps) {
  return (
    <Field label="图片地址">
      <VarBar
        title="可引用："
        tokens={upstreamTokens(p)}
        onInsert={(t) => p.onChange(String(p.d.url ?? '') + t)}
      />
      <input
        className="p-input mono"
        value={String(p.d.url ?? '')}
        placeholder="https://.../image.png"
        onChange={(e) => p.onChange(e.target.value)}
      />
    </Field>
  );
}

/** 「本地路径」那一行 —— llmChat 与 ocr 共用 */
export function renderImagePath(p: FieldRenderProps) {
  return (
    <Field
      label="本地路径"
      hint={!canReadImage() ? '浏览器模式不能读本地图片，请用桌面端运行' : undefined}
    >
      <VarBar
        title="可引用："
        tokens={upstreamFileTokens(p.upstream).filter((t) => t.text.endsWith('.file}}'))}
        onInsert={(t) => p.onChange(String(p.d.path ?? '') + t)}
      />
      <input
        className="p-input mono"
        value={String(p.d.path ?? '')}
        placeholder="/path/to/screenshot.png"
        onChange={(e) => p.onChange(e.target.value)}
      />
    </Field>
  );
}
