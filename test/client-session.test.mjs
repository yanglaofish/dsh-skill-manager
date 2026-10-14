import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const source = process.env.SKM_CLIENT_BASELINE
  ? execFileSync('git', ['show', 'HEAD:lib/client.js'], { encoding: 'utf8', windowsHide: true })
  : readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// 仅替换 React 的宿主边界；完整加载真实 Client bundle，保留组件与事件处理函数。
function harness(fetch) {
  let exports, index = 0, dirty = false, props, tree;
  const cells = [], effects = [];
  const equal = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const react = {
    Component: class {}, Fragment: 'fragment',
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) {
      const cell = cells[index++] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [cell.value, (next) => {
        const value = typeof next === 'function' ? next(cell.value) : next;
        if (!Object.is(value, cell.value)) { cell.value = value; dirty = true; }
      }];
    },
    useRef(initial) { return cells[index++] ??= { current: initial }; },
    useCallback(fn, deps) {
      const slot = index++;
      if (!equal(cells[slot]?.deps, deps)) cells[slot] = { deps, fn };
      return cells[slot].fn;
    },
    useEffect(fn, deps) {
      const slot = index++;
      if (!equal(cells[slot]?.deps, deps)) {
        const previous = cells[slot];
        cells[slot] = { deps };
        effects.push(() => { previous?.cleanup?.(); cells[slot].cleanup = fn(); });
      }
    },
  };
  vm.runInNewContext(source, { URLSearchParams, fetch, console, setTimeout, clearTimeout,
    window: { __ModuleLoader__: { load(bundle) { exports = bundle.factory((name) => name === 'react' ? react : {}); } } },
  });
  function render(next = props) {
    props = next; index = 0; dirty = false;
    tree = exports.WorkspaceSkillsPanel(props);
    for (const effect of effects.splice(0)) effect();
  }
  async function settle() {
    for (let i = 0; i < 12; i++) { await new Promise((resolve) => setImmediate(resolve)); if (dirty) render(); }
  }
  function rows(node = tree, output = []) {
    if (Array.isArray(node)) { for (const child of node) rows(child, output); }
    else if (node && typeof node === 'object') {
      if (node.type?.name === 'SkillRow') output.push(node.props);
      rows(node.props?.children, output);
    }
    return output;
  }
  return { render, settle, rows, text: () => JSON.stringify(tree) };
}
const payload = (id) => ({ ok: true, session: { id, cwd: `C:/project-${id}`, explicit: false }, workspaces: [],
  skills: [{ name: `skill-${id}`, description: id, origin: 'user', layer: 'global', sessionEnabled: false }] });
const response = (data) => ({ ok: true, status: 200, json: async () => data });

test('切换会话后旧响应不能覆盖新视图，勾选只写新会话且不携带旧 cwd', async () => {
  const requests = [];
  let releaseA;
  const slowA = new Promise((resolve) => { releaseA = resolve; });
  const h = harness(async (url, options) => {
    requests.push({ url, options });
    if (options?.method === 'POST') return response({ ok: true });
    const id = new URL(url, 'http://localhost').searchParams.get('sessionId');
    return id === 'a' ? slowA : response(payload(id));
  });
  h.render({ initialSessionId: 'a', embed: true });
  h.render({ initialSessionId: 'b', embed: true });
  await h.settle();
  releaseA(response(payload('a')));
  await h.settle();
  assert.deepEqual(h.rows().map((row) => row.name), ['skill-b']);
  await h.rows()[0].onToggle(true);
  const writes = requests.filter((r) => r.options?.method === 'POST');
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].options.body), { sessionId: 'b', enabled: ['skill-b'], explicit: true });
});

test('工作区设置页按选择的 cwd 查询，不绑定当前聊天的会话选择', async () => {
  const queries = [];
  const h = harness(async (url) => { queries.push(new URL(url, 'http://localhost')); return response({ ...payload('a'), session: { cwd: 'C:/chosen' } }); });
  h.render({ initialSessionId: 'current-chat', cwd: 'C:/chosen', embed: false });
  await h.settle();
  assert.ok(queries.every((url) => url.searchParams.get('cwd') === 'C:/chosen'));
  assert.ok(queries.every((url) => !url.searchParams.has('sessionId')));
});

test('旧会话的保存完成后不能重新查询并覆盖当前会话', async () => {
  const queries = [];
  let releaseSave;
  const slowSave = new Promise((resolve) => { releaseSave = resolve; });
  const h = harness(async (url, options) => {
    if (options?.method === 'POST') return slowSave;
    const id = new URL(url, 'http://localhost').searchParams.get('sessionId');
    queries.push(id);
    return response(payload(id));
  });
  h.render({ initialSessionId: 'a', embed: true });
  await h.settle();
  const save = h.rows()[0].onToggle(true);
  h.render({ initialSessionId: 'b', embed: true });
  await h.settle();
  const count = queries.length;
  releaseSave(response({ ok: true }));
  await save;
  await h.settle();
  assert.deepEqual(h.rows().map((row) => row.name), ['skill-b']);
  assert.equal(queries.length, count, '旧保存不能发起旧会话的刷新');
});

test('成功保存的同步广播不能吞掉自身 dropped 提示', async () => {
  const h = harness(async (url, options) => options?.method === 'POST'
    ? response({ ok: true, dropped: ['已删除技能'] }) : response(payload('a')));
  h.render({ initialSessionId: 'a', embed: true });
  await h.settle();
  await h.rows()[0].onToggle(true);
  await h.settle();
  assert.match(h.text(), /已更新，但有 1 个技能不在技能库中/);
  assert.match(h.text(), /已删除技能/);
});
