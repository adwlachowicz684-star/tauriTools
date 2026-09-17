# 服务插件调用指南

> 目标：**一行调起、拿到结果就走**，调用方不需要做额外工作。

## 统一约定

| 返回方式 | 含义 | 调用方要处理吗 |
|---|---|---|
| `resolve(值)` | 用户选了 | 用这个值 |
| `resolve(null)` | **用户取消**（正常流程） | 判空即可 |
| `reject(错误)` | 真出错（没装/挂载失败/超时/崩溃） | 可选 try/catch |

**取消不抛异常**是关键。取消是最常见的结果之一，用异常表达会逼得每个调用方都写 `try/catch`，漏了就是 unhandled rejection。

## 一行调起

```js
// 取色 —— 取消返回 null
const hex = await ctx.services.color.pick('#3E63DD');
if (hex) apply(hex);

// 选图标 —— 取消返回 null
const icon = await ctx.services.icon.browse('上传');
if (icon) setIcon(icon.url);

// 编辑 Markdown —— 取消返回 null
const text = await ctx.services.md.edit(body, '节点说明');
if (text !== null) save(text);
```

调用方**不需要**做的：

- 不需要先挂载服务（宿主懒加载，谁被调才挂谁）
- 不需要处理浮层显示/收回（宿主按 `interactive` 自动做，且在 `finally` 里收回）
- 不需要为「取消」写 try/catch

## 实时预览（可选）

想让外面跟着拖动手势变，传 `previewEvent` 并订阅：

```js
const off = ctx.on('tag-preview', (hex) => setPreview(hex));
const hex = await ctx.services.color.pick(cl, { previewEvent: 'tag-preview' });
off();
```

## 其它方法

```js
await ctx.services.color.normalize('#abc');   // → '#AABBCC'，非法 → null
await ctx.services.color.presets();           // → 24 个预设色
await ctx.services.color.hsv('#3E63DD');      // → { h, s, v }
await ctx.services.icon.list();               // → 图标名清单
await ctx.services.icon.url('foo');           // → URL
await ctx.services.md.render('# 标题');        // → HTML（只要渲染，不开面板）
```

## 第三方服务

通用入口，不用改 SDK：

```js
const r = await ctx.services.call('my-service', 'myMethod', { foo: 1 });
const list = await ctx.services.list();       // 已注册的服务
```

服务侧：

```js
// 原生 JS
import { bootServicePlugin } from '../../js/plugin-sdk.js';
bootServicePlugin({
  async describe() { return { name: '我的服务', version: '1.0.0', methods: ['describe', 'myMethod'] }; },
  async myMethod(args, ctx) { return { ok: true }; },
});

// React
import { bootServiceReactPlugin } from '../../src/nexus-react';
bootServiceReactPlugin(() => <MyPanel />, { async myMethod(args, ctx) { /* ... */ } });
```

**第三方服务请遵守同一套返回约定**（取消 → `resolve(null)`），
这样调用方换个服务也不用改写法。

## 注册

`plugins/registry.js` 里加 `kind: 'service'`；需要用户看得见的（色盘/图标/编辑器）加 `interactive: true`。

```js
{ id: 'my-service', name: '我的服务', kind: 'service', interactive: true,
  type: 'iframe', entry: './plugins/my-service/index.html' }
```
