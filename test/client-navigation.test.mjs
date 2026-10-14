import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function client(fetch = async () => ({ ok: true, json: async () => ({ ok: true }) })) {
  let exports;
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    .replace('exports.SkillManagerPanel =', 'exports.__api = api; exports.__subscribe = subscribeSkillChanges; exports.SkillManagerPanel =');
  const react = { Component: class {}, createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: (value) => [value, () => {}], useEffect: () => {} };
  vm.runInNewContext(source, { fetch, console, URLSearchParams,
    window: { __ModuleLoader__: { load: (bundle) => { exports = bundle.factory((name) => name === 'react' ? react : {}); } } } });
  return exports;
}

test('侧栏等待 main 和 panellist 均就绪，移除时先退出当前页面且支持重新注册', () => {
  const exports = client();
  const watchers = new Map(), active = new Map(), events = [];
  const ctx = { slots: {
    inject: (name, callback) => watchers.set(name, callback),
    register: (options, component) => {
      const id = `${options.name}:${options.key ?? options.id}`;
      assert.ok(!active.has(id), '不能重复注册');
      active.set(id, { options, component }); events.push(`add:${id}`);
      return () => { active.delete(id); events.push(`remove:${id}`); };
    },
  }, layout: { panelInfo: { getSnapshot: () => ({ activePanelId: 'skill-manager' }) }, selectPanel: (id) => events.push(`select:${id}`) } };
  exports.apply(ctx);
  assert.ok(watchers.has('settings.section'));
  assert.ok(watchers.has('conversation.view'));
  assert.ok(watchers.has('main'));
  const disposeList = watchers.get('sidebar.panellist')();
  assert.equal(active.size, 0);
  const disposeMain = watchers.get('main')();
  assert.equal(active.size, 2);
  assert.deepEqual(events.slice(0, 2), ['add:main:skill-manager', 'add:sidebar.panellist:skill-manager']);
  const wide = active.get('main:skill-manager').component();
  watchers.get('settings.section')();
  const compact = active.get('settings.section:skill-manager').component();
  // 两个入口包装同一个容器，业务组件保持同源。
  assert.equal(wide.type, compact.type);
  assert.equal(wide.props.presentation, 'panel');
  assert.equal(compact.props.presentation, 'settings');
  disposeMain();
  assert.ok(events.indexOf('select:null') < events.indexOf('remove:main:skill-manager'));
  assert.ok(!active.has('sidebar.panellist:skill-manager'));
  const disposeAgain = watchers.get('main')();
  assert.ok(active.has('sidebar.panellist:skill-manager'));
  disposeList(); disposeAgain();
  assert.equal(active.size, 1);
});

test('缺少原生页面槽和 layout 时，设置与会话入口仍可注册', () => {
  const exports = client();
  const names = [];
  exports.apply({ slots: {
    inject: (name, cb) => { if (['settings.section', 'conversation.view'].includes(name)) cb(); },
    register: ({ name }) => { names.push(name); return () => {}; },
  } });
  assert.deepEqual(names, ['settings.section', 'conversation.view']);
});

test('仅成功写入通知所有面板，读取和失败不通知，卸载后不再收到通知', async () => {
  let success = true;
  const exports = client(async () => ({ ok: success, json: async () => ({ ok: success }) }));
  const changes = [], other = [];
  const unsubscribe = exports.__subscribe((change) => changes.push(change));
  exports.__subscribe((change) => other.push(change));
  await exports.__api('/list');
  await exports.__api('/session/set', { method: 'POST', body: JSON.stringify({ sessionId: 'a' }) });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].sessionId, 'a');
  success = false;
  await exports.__api('/delete', { method: 'POST' });
  assert.equal(changes.length, 1);
  unsubscribe(); success = true;
  await exports.__api('/skill-file', { method: 'POST' });
  assert.equal(changes.length, 1);
  assert.equal(other.length, 2);
});
