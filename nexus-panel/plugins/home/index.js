import { definePlugin, h } from '../../js/plugin-sdk.js';
import { isInsideTauri, getTauri } from '../../js/tauri-core.js';

export default definePlugin({
  name: '概览',
  async mount(ctx) {
    const host = ctx.root;

    const info = await probeEnv(ctx);

    host.appendChild(
      h('div.p-card', {},
        h('h2', {}, '运行环境'),
        h('div.p-grid', {},
          stat('插件总数', (window.__NEXUS__?.getPlugins() || []).length),
          stat('挂载模式', ctx.mode === 'iframe' ? '沙箱' : '同页'),
          stat('Tauri 环境', info.inside ? '已连接' : '浏览器'),
          stat('Rust 后端', info.rust || '未连接'),
        ),
        h('div.p-row', { style: { marginTop: '16px' } },
          h('button.p-btn.primary', {
            onclick: async (e) => {
              e.target.disabled = true;
              try {
                const r = await ctx.invoke('rust_ping', { payload: 'hello' });
                ctx.toast('Rust 返回：' + r, 'ok');
              } catch (err) {
                ctx.toast(String(err), 'err');
              } finally {
                e.target.disabled = false;
              }
            },
          }, '测试 Rust 通信 (rust_ping)'),
          h('span.p-muted', {}, '点击后会调用 src-tauri/src/main.rs 中的命令'),
        ),
      ),
    );

    // 插件清单
    const list = window.__NEXUS__?.getPlugins() || [];
    host.appendChild(
      h('div.p-card', {},
        h('h2', {}, '已安装插件'),
        h('div.p-grid', {}, ...list.map((p) =>
          h('div.p-stat', {
            style: { cursor: 'pointer' },
            onclick: () => ctx.openPlugin(p.id),
            title: '点击切换',
          },
            h('div.k', {}, `${p.icon || '◌'} ${p.name}`),
            h('div.v', { style: { fontSize: '13px', fontWeight: '400', color: 'var(--text-dim)' } },
              p.type === 'iframe' ? '沙箱挂载' : '同页挂载'),
            h('div.p-row', { style: { marginTop: '10px', gap: '6px' } },
              h('span.p-tag', {}, p.builtin ? '内置' : '自定义'),
              p.shadow ? h('span.p-tag', {}, 'Shadow DOM') : null,
            ),
          ),
        )),
      ),
    );

    // 快速上手
    host.appendChild(
      h('div.p-card', {},
        h('h2', {}, '开发一个新插件'),
        h('div.p-mono.p-muted', {
          html: `1. 在 <b>plugins/</b> 下新建目录，写入口文件<br>
2. 在 <b>plugins/registry.js</b> 里加一条配置<br>
3. Ctrl/⌘ + R 重载插件，无需重启应用`,
          style: { lineHeight: '2' },
        }),
        h('div.p-row', { style: { marginTop: '14px' } },
          h('button.p-btn', { onclick: () => ctx.openPlugin('demo-module') }, '看同页示例'),
          h('button.p-btn', { onclick: () => ctx.openPlugin('demo-iframe') }, '看沙箱示例'),
        ),
      ),
    );

    const off = ctx.on('demo:counter', (n) => ctx.setBadge(n));
    ctx.onDestroy(off);
  },
});

function stat(k, v) {
  return h('div.p-stat', {}, h('div.k', {}, k), h('div.v', {}, String(v)));
}

async function probeEnv(ctx) {
  const inside = isInsideTauri();
  let rust = '未连接';
  if (inside) {
    try {
      const tauri = await getTauri();
      rust = tauri ? (await tauri.invoke('app_version')) : '未连接';
    } catch { rust = '调用失败'; }
  }
  return { inside, rust };
}
