import { definePlugin, h } from '../../js/plugin-sdk.js';

/**
 * 同页挂载（module）示例
 * 特点：与主页面共享 JS 环境 → 可直接 ctx.invoke 调 Rust、性能最好。
 * ctx.addStyle 会自动加作用域前缀，CSS 不会污染其他插件。
 */
export default definePlugin({
  name: '示例·同页插件',
  async mount(ctx) {
    const removeStyle = ctx.addStyle(`
      .hero { padding: 18px; border-radius: var(--r);
              box-shadow: inset 4px 4px 8px var(--sh-dark), inset -4px -4px 8px var(--sh-light); }
      .hero .num { font-size: 40px; font-weight: 700; color: var(--accent); line-height: 1.1; }
      .log { max-height: 160px; overflow: auto; font-family: Menlo, Consolas, monospace; font-size: 11.5px; }
    `);

    // 持久化状态
    let count = await ctx.store.get('count', 0);
    const numEl = h('div.num', {}, String(count));
    const logEl = h('div.log.p-mono.p-muted', {});

    const log = (msg) => {
      const t = new Date().toLocaleTimeString();
      logEl.prepend(h('div', {}, `[${t}] ${msg}`));
    };

    // 定时器演示清理
    const timer = setInterval(() => log('心跳 tick'), 5000);
    ctx.onDestroy(() => clearInterval(timer));
    ctx.onDestroy(removeStyle);

    // 监听其他插件事件
    const off = ctx.on('demo:ping', (payload) => {
      log('收到事件 demo:ping → ' + JSON.stringify(payload));
      ctx.toast('收到跨插件事件');
    });
    ctx.onDestroy(off);

    const bump = async () => {
      count++;
      numEl.textContent = String(count);
      await ctx.store.set('count', count);
      ctx.emit('demo:counter', count);   // 广播给其他插件（概览会把角标更新）
      ctx.setBadge(count);
      log(`count = ${count}（已持久化）`);
    };

    ctx.root.appendChild(
      h('div.p-card', {},
        h('h2', {}, '计数器（持久化 + 事件广播）'),
        h('div.hero', { style: { textAlign: 'center' } },
          numEl,
          h('div.p-muted', { style: { marginTop: '4px' } }, 'ctx.store 自动隔离，只属于本插件'),
        ),
        h('div.p-row', { style: { marginTop: '16px', justifyContent: 'center' } },
          h('button.p-btn.primary', { onclick: bump }, '＋ 1'),
          h('button.p-btn', { onclick: async () => { count = 0; numEl.textContent = '0'; await ctx.store.set('count', 0); ctx.setBadge(0); } }, '重置'),
          h('button.p-btn', { onclick: () => ctx.emit('demo:ping', { from: ctx.id, at: Date.now() }) }, '广播 demo:ping'),
        ),
      ),
    );

    ctx.root.appendChild(
      h('div.p-card', {},
        h('h2', {}, '调用 Rust 后端'),
        h('div.p-row', {},
          h('button.p-btn', {
            onclick: async () => {
              try {
                const r = await ctx.invoke('rust_ping', { payload: '来自同页插件' });
                log('rust_ping → ' + r);
                ctx.toast('调用成功', 'ok');
              } catch (e) { log('错误：' + e); ctx.toast(String(e), 'err'); }
            },
          }, 'invoke("rust_ping")'),
          h('button.p-btn', {
            onclick: async () => {
              const r = await ctx.invoke('app_version').catch((e) => 'ERR ' + e);
              log('app_version → ' + r);
            },
          }, 'invoke("app_version")'),
        ),
      ),
    );

    ctx.root.appendChild(
      h('div.p-card', {},
        h('h2', {}, '运行日志'),
        logEl,
      ),
    );

    log(`插件已挂载，mode = ${ctx.mode}`);

    // 返回卸载函数（可选）
    return () => console.log('[demo-module] 已卸载');
  },
});
