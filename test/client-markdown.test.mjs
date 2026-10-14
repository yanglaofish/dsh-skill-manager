import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 仅暴露私有组件作为测试入口，组件逻辑和请求路径保持原样。
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  .replace('exports.SkillManagerPanel = SkillManagerPanel;', 'exports.__detail = SkillDetailModal; exports.SkillManagerPanel = SkillManagerPanel;');
function harness(renderer, file = 'SKILL.md') {
  let exports, index = 0, dirty = false, tree;
  const cells = [], effects = [], writes = [];
  const initial = '---\nname: sample\ndescription: 测试\n---\n# 原文';
  const react = {
    Component: class {}, Fragment: 'fragment',
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) {
      const cell = cells[index++] ??= { value: initial };
      return [cell.value, (next) => { if (!Object.is(next, cell.value)) { cell.value = next; dirty = true; } }];
    },
    useRef(initial) { return cells[index++] ??= { current: initial }; },
    useEffect(fn, deps) {
      const slot = index++;
      if (!cells[slot] || deps.some((value, i) => value !== cells[slot][i])) { cells[slot] = deps; effects.push(fn); }
    },
  };
  vm.runInNewContext(source, {
    console, URLSearchParams, setTimeout, clearTimeout,
    window: { __ModuleLoader__: { load(bundle) {
      exports = bundle.factory((name) => name === 'react' ? react : name === '@deepseek-ai/dsh-client-ui-primitives' ? { MarkdownText: renderer } : {});
    } } },
    fetch: async (url, options) => {
      let data;
      if (options?.method === 'POST') { writes.push(JSON.parse(options.body)); data = { ok: true }; }
      else if (url.includes('/skill-files?')) data = { ok: true, files: [{ type: 'file', name: 'SKILL.md', path: file }] };
      else data = { ok: true, content: initial };
      return { ok: true, json: async () => data };
    },
  });
  function render() {
    index = 0; dirty = false;
    tree = exports.__detail({ skill: { name: 'sample' }, onClose() {} });
    for (const effect of effects.splice(0)) effect();
  }
  async function settle() { for (let i = 0; i < 10; i++) { await new Promise((resolve) => setImmediate(resolve)); if (dirty) render(); } }
  function nodes(predicate, node = tree, found = []) {
    if (Array.isArray(node)) for (const child of node) nodes(predicate, child, found);
    else if (node && typeof node === 'object') { if (predicate(node)) found.push(node); nodes(predicate, node.props?.children, found); }
    return found;
  }
  const button = (label) => nodes((node) => node.type === 'button' && node.props.children.flat().includes(label))[0];
  async function click(label) { const node = button(label); assert.ok(node, '缺少按钮：' + label); await node.props.onClick(); await settle(); }
  render();
  return { settle, nodes, button, click, writes, initial };
}

test('复用宿主 memo MarkdownText，预览未保存草稿，切回源码及保存不丢正文', async () => {
  const renderer = { $$typeof: Symbol.for('react.memo'), type() {} };
  const h = harness(renderer);
  await h.settle();
  assert.equal(h.nodes((node) => node.type === renderer).length, 1, '桌面宿主导出 memo 对象也必须识别');
  await h.click('✏ 编辑');
  const draft = h.initial + '\n\n| 列 |\n| --- |\n| **值** |\n\n```js\nconst x = 1;\n```';
  h.nodes((node) => node.type === 'textarea')[0].props.onChange({ target: { value: draft } });
  await h.settle();
  await h.click('预览');
  assert.equal(h.nodes((node) => node.type === renderer)[0].props.text, draft);
  assert.equal(h.writes.length, 0, '预览不能保存');
  await h.click('源码');
  assert.equal(h.nodes((node) => node.type === 'textarea')[0].props.value, draft);
  await h.click('预览');
  await h.click('保存 ✓');
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].content, draft);
  assert.equal(h.nodes((node) => node.type === renderer)[0].props.text, draft);
});

test('预览草稿后取消恢复已保存内容，再编辑默认回到源码', async () => {
  const renderer = () => null;
  const h = harness(renderer);
  await h.settle(); await h.click('✏ 编辑');
  h.nodes((node) => node.type === 'textarea')[0].props.onChange({ target: { value: '# 未保存' } });
  await h.settle(); await h.click('预览'); await h.click('取消');
  assert.equal(h.nodes((node) => node.type === renderer)[0].props.text, h.initial);
  await h.click('✏ 编辑');
  assert.equal(h.nodes((node) => node.type === 'textarea')[0].props.value, h.initial);
  assert.equal(h.writes.length, 0);
});

test('宿主渲染不可用或普通脚本文件，保留源码编辑且不提供无效预览', async () => {
  for (const [renderer, file] of [[undefined, 'SKILL.md'], [{}, 'SKILL.md'], [() => null, 'run.py']]) {
    const h = harness(renderer, file);
    await h.settle(); await h.click('✏ 编辑');
    assert.equal(h.button('预览'), undefined);
    assert.equal(h.nodes((node) => node.type === 'textarea').length, 1);
  }
});
