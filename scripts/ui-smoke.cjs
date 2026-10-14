// 本地 UI 验收：真实 React 与插件组件，API 全部使用内存样本，不读写用户技能。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assets = path.resolve(__dirname, '../../logs/skill-manager-ui');
const source = fs.readFileSync(path.resolve(__dirname, '../lib/client.js'), 'utf8');
const hostTheme = fs.readFileSync(process.env.SKM_HOST_THEME || path.join(assets, 'host-theme.css'), 'utf8');
let skills = [
  ['code-review', '审查代码变更，检查实现是否符合规范与需求，定位回归风险。'],
  ['design-taste-frontend', '优化现有界面的布局、层级与交互，保持产品的视觉一致性。'],
  ['diagnosing-bugs', '通过可复现的证据定位问题，从根因修复错误与性能回退。'],
  ['research', '调查技术问题，核对一手来源，将结论整理成可复用的资料。'],
  ['skill-creator', '编写和维护技能说明，组织脚本、参考资料与其他支持文件。'],
  ['documents', '创建、编辑和校验文档，保留结构、样式及版面细节。'],
  ['preset-example', '由当前智能体预设提供的技能，保留只读状态。'],
].map(([name, description]) => ({ name, description, origin: name.startsWith('preset') ? 'preset' : 'user', layer: 'global', enabled: true }));
const enabled = new Set();
let holdToggle = false, releaseToggle;
let importedBatch;
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
${hostTheme}
html,body,#root{height:100%;margin:0}body{font-family:Segoe UI,Microsoft YaHei,sans-serif;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}.compact{max-width:620px;margin:auto;padding:24px;box-sizing:border-box}.pair{display:grid;grid-template-columns:1fr 1fr;height:100%;gap:24px}.pair>div{overflow:auto;min-width:0;padding:20px}
</style><div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>
window.__ModuleLoader__={load(bundle){window.plugin=bundle.factory(name=>name==='react'?React:name==='react/jsx-runtime'?{}:{});}};
</script><script src="/client.js"></script><script>
const params=new URLSearchParams(location.search);document.body.toggleAttribute('data-ds-dark-theme', params.has('dark'));
const h=React.createElement, Panel=plugin.SkillManagerPanel;
const root=ReactDOM.createRoot(document.getElementById('root'));
if(params.has('pair'))root.render(h('div',{className:'pair'},h('div',{id:'wide'},h(Panel,{presentation:'panel'})),h('div',{id:'compact'},h(Panel,{presentation:'settings'}))));
else if(params.has('compact'))root.render(h('div',{className:'compact'},h(Panel,{presentation:'settings'})));
else root.render(h(Panel,{presentation:'panel'}));
</script></html>`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (data, type = 'application/json') => { res.setHeader('Content-Type', type + '; charset=utf-8'); res.end(type === 'application/json' ? JSON.stringify(data) : data); };
  if (url.pathname === '/') return send(html, 'text/html');
  if (url.pathname === '/client.js') return send(source, 'application/javascript');
  if (['/react.js', '/react-dom.js'].includes(url.pathname)) return send(fs.readFileSync(path.join(assets, url.pathname.slice(1))), 'application/javascript');
  let body = ''; for await (const chunk of req) body += chunk;
  const data = body ? JSON.parse(body) : {};
  const endpoint = url.pathname.replace('/skill-manager/api', '');
  if (endpoint === '/import/batch') {
    importedBatch = data.items;
    skills.push({ name: 'ui-import-example', description: '导入验收样本', origin: 'user', layer: 'global', enabled: true });
    return send({ ok: true, results: [{ ok: true, source: 'ui-import-example', name: 'ui-import-example', restored: 1 }] });
  }
  if (endpoint === '/delete') { skills = skills.filter((s) => s.name !== data.name); return send({ ok: true }); }
  if (endpoint === '/workspace/toggle') {
    if (data.enable) enabled.add(data.name); else enabled.delete(data.name);
    if (holdToggle) await new Promise((resolve) => { releaseToggle = resolve; });
    return send({ ok: true });
  }
  if (endpoint === '/list') return send({ ok: true, skills, stats: { total: skills.length, preset: 1, workspaceCount: 1 } });
  if (endpoint === '/view') return send({ ok: true, version: '2.0.1', skills: skills.map((s) => ({ ...s, layer: enabled.has(s.name) ? 'workspace' : s.layer })), workspaces: [{ cwd: 'E:/Projects/skills-demo', exists: true, enabledCount: enabled.size }], session: { cwd: 'E:/Projects/skills-demo', explicit: false } });
  if (endpoint === '/unmanaged') return send({ ok: true, items: [] });
  if (endpoint === '/search') return send({ ok: true, results: skills.filter((s) => (s.name + s.description).includes(url.searchParams.get('q')) ) });
  if (endpoint === '/get') return send({ ok: true, skill: skills.find((s) => s.name === url.searchParams.get('name')) });
  if (endpoint === '/skill-files') return send({ ok: true, files: [{ name: 'SKILL.md', path: 'SKILL.md', type: 'file' }] });
  if (endpoint === '/skill-file') return send({ ok: true, content: '# 示例技能\n\n技能说明与参考资料。' });
  send({ ok: true });
});
(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 1 });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    const url = `http://127.0.0.1:${server.address().port}`;
    const assertImportContrast = async (label) => {
      const colors = await page.locator('.dskm_primary').evaluate((el) => {
        const s = getComputedStyle(el);
        return { foreground: s.color, background: s.backgroundColor, disabled: el.querySelector('input').disabled };
      });
      assert.equal(colors.disabled, false, label + ' 导入按钮不应禁用');
      assert.ok(!colors.background.includes('rgba') || !colors.background.endsWith(', 0)'), label + ' 导入按钮背景不能透明：' + JSON.stringify(colors));
      const luminance = (color) => color.match(/[\d.]+/g).slice(0, 3).map((v) => {
        const channel = Number(v) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const a = luminance(colors.foreground), b = luminance(colors.background);
      assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5, label + ' 导入文字对比度不足：' + JSON.stringify(colors));
    };
    const themeColors = {};
    for (const [name, suffix, width] of [['wide-light', '', 1180], ['compact-light', '?compact', 650], ['compact-dark', '?compact&dark', 650], ['narrow', '?compact', 390]]) {
      await page.setViewportSize({ width, height: 900 }); await page.goto(url + suffix);
      await page.getByText('code-review', { exact: true }).waitFor();
      const chooserPromise = page.waitForEvent('filechooser');
      await page.locator('.dskm_headeractions label').filter({ hasText: '导入技能' }).click();
      const chooser = await chooserPromise;
      assert.equal(await chooser.element().getAttribute('webkitdirectory'), '');
      await page.evaluate(() => document.activeElement?.blur());
      themeColors[name] = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await page.screenshot({ path: path.join(assets, name + '.png'), fullPage: true });
      await assertImportContrast(name);
      await page.locator('.dskm_primary').hover();
      await assertImportContrast(name + ' 悬停');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, name + ' 不应横向溢出');
      const manager = page.locator('.dskm_manager');
      const overflowChild = await manager.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      assert.equal(overflowChild, false, name + ' 容器不应横向溢出');
    }
    assert.notEqual(themeColors['compact-light'], themeColors['compact-dark'], '必须实际切换宿主深色主题');
    const fixture = path.join(assets, 'ui-import-example');
    fs.mkdirSync(path.join(fixture, 'references'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'SKILL.md'), '---\nname: ui-import-example\ndescription: 导入验收样本\n---\n# 测试技能\n');
    fs.writeFileSync(path.join(fixture, 'references', 'guide.md'), '# 附属资料\n');
    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('.dskm_headeractions label').filter({ hasText: '导入技能' }).click();
    await (await chooserPromise).setFiles(fixture);
    await page.getByText('导入完成：成功 1 / 1', { exact: false }).waitFor();
    assert.deepEqual(importedBatch[0].files.map((file) => file.path).sort(), ['SKILL.md', 'references/guide.md']);
    assert.equal(Buffer.from(importedBatch[0].files.find((file) => file.path === 'references/guide.md').b64, 'base64').toString(), '# 附属资料\n');
    await page.getByText('ui-import-example', { exact: true }).waitFor();
    await page.setViewportSize({ width: 1400, height: 900 }); await page.goto(url + '?pair');
    await page.locator('#wide').getByText('code-review', { exact: true }).waitFor();
    await page.locator('#compact').getByText('code-review', { exact: true }).waitFor();
    page.on('dialog', (dialog) => dialog.accept());
    await page.locator('#wide .dskm_card').filter({ hasText: 'code-review' }).getByRole('button', { name: '删除', exact: true }).click();
    await page.locator('#compact').getByText('code-review', { exact: true }).waitFor({ state: 'detached' });
    await page.locator('#compact').getByRole('searchbox').fill('research');
    await page.locator('#compact').getByText('research', { exact: true }).waitFor();
    await page.locator('#wide .dskm_card').filter({ hasText: 'research' }).getByRole('button', { name: '删除', exact: true }).click();
    await page.locator('#compact').getByText('没有找到匹配', { exact: false }).waitFor();
    for (const id of ['wide', 'compact']) await page.locator('#' + id).getByRole('button', { name: '工作区配置', exact: true }).click();
    await page.locator('#wide .dskm_litem_off').filter({ hasText: 'documents' }).click();
    await page.locator('#compact .dskm_litem_on').filter({ hasText: 'documents' }).waitFor();
    // 另一面板发起的保存延迟完成，模拟编辑期间收到后台变更通知。
    holdToggle = true;
    await page.locator('#compact .dskm_litem_on').filter({ hasText: 'documents' }).click();
    await page.locator('#wide').getByRole('button', { name: '全部技能', exact: true }).click();
    await page.locator('#wide .dskm_card').filter({ hasText: 'documents' }).getByRole('button', { name: '查看/编辑', exact: true }).click();
    await page.locator('#wide').getByRole('button', { name: '✏ 编辑', exact: true }).click();
    await page.locator('#wide textarea').fill('# 未保存草稿');
    assert.equal(typeof releaseToggle, 'function');
    releaseToggle();
    await page.locator('#compact .dskm_litem_off').filter({ hasText: 'documents' }).waitFor();
    assert.equal(await page.locator('#wide textarea').inputValue(), '# 未保存草稿');
    assert.deepEqual(errors, []);
    console.log('UI 验收通过：宽屏、紧凑、深色、390px 均可点击导入并弹出目录选择，目录与附件完整上传并更新列表；无横向溢出；双面板删除、搜索、工作区选择同步；外部刷新保留编辑草稿；无 React 渲染错误。');
  } finally { await browser.close(); server.close(); }
})().catch((error) => { console.error(error); server.close(); process.exitCode = 1; });
