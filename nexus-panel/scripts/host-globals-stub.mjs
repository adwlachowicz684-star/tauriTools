/** 最小宿主全局 stub：只覆盖 host.js 顶层与行为层实际触碰的 API。 */
export function installHostGlobals() {
  const store = new Map();
  const localStorage = {
    getItem: k => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
    key: i => [...store.keys()][i] ?? null,
    get length() { return store.size },
  };
  const mkEl = () => ({
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, setAttribute() {},
    getAttribute() { return null }, innerHTML: '', textContent: '',
    querySelector() { return null }, querySelectorAll() { return [] }, remove() {},
  });
  const document = {
    createElement: mkEl, body: mkEl(), documentElement: mkEl(), head: mkEl(),
    addEventListener() {}, removeEventListener() {}, querySelector() { return null },
    querySelectorAll() { return [] }, getElementById() { return null },
    cookie: '', readyState: 'complete',
  };
  const location = { href: 'http://localhost/index.html', origin: 'http://localhost', pathname: '/index.html', search: '', hash: '' };
  const window = {
    document, location, localStorage, addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: f => setTimeout(f, 0), cancelAnimationFrame: id => clearTimeout(id),
    setTimeout, clearTimeout, getComputedStyle: () => ({}), navigator: { userAgent: 'node' },
  };
  globalThis.window = window; globalThis.document = document;
  globalThis.localStorage = localStorage; globalThis.location = location;
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
  globalThis.matchMedia = window.matchMedia;
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  return window;
}
