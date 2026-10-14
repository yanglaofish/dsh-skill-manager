import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import AdmZip from 'adm-zip';
import * as manager from '../lib/index.js';
import { replaceDirectory } from '../lib/safe-storage.js';

const doc = (name, body = '正文') => `---\nname: ${name}\ndescription: 测试\n---\n${body}`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'skm-repairs-'));
  const saved = Object.fromEntries(['DSH_HOME', 'DSH_AGENTS_HOME', 'DSH_PROFILE', 'DSH_PROFILE_DIR'].map((key) => [key, process.env[key]]));
  process.env.DSH_HOME = join(root, 'dsh');
  process.env.DSH_AGENTS_HOME = join(root, 'agents');
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_PROFILE_DIR;
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(manager.skillsRoot(), { recursive: true });
  return root;
}
async function seed(dir, name, body) { await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'SKILL.md'), doc(name, body)); }

test('技能文件拒绝绝对路径、相同前缀兄弟目录和链接越界', async (t) => {
  const root = await fixture(t), lib = manager.skillsRoot();
  await seed(join(lib, 'safe'), 'safe');
  const sibling = join(lib, 'safe-other');
  await mkdir(sibling); await writeFile(join(sibling, 'note.txt'), '原文');
  assert.equal((await manager.writeSkillFile('safe', join(sibling, 'note.txt'), '坏')).ok, false);
  assert.equal((await manager.readSkillFile('safe', join(sibling, 'note.txt'))).ok, false);
  const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'note.txt'), '原文');
  await symlink(outside, join(lib, 'safe', 'jump'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await manager.writeSkillFile('safe', 'jump/note.txt', '坏')).ok, false);
  assert.equal((await manager.readSkillFile('safe', 'jump/note.txt')).ok, false);
  assert.equal(await readFile(join(outside, 'note.txt'), 'utf8'), '原文');
  assert.equal((await manager.writeSkillFile('safe', 'SKILL.md', doc('safe', '正常保存'))).ok, true);
});

test('导入写入失败保留整个旧技能，ZIP 不能静默返回部分成功', async (t) => {
  await fixture(t);
  const dir = join(manager.skillsRoot(), 'original');
  await seed(dir, 'original', '旧正文'); await writeFile(join(dir, 'old.txt'), '旧附件');
  const files = [['SKILL.md', doc('original', '新正文')], ['assets', '文件'], ['assets/icon.txt', '子文件']];
  const imported = await manager.importSkillDocs([{ files: files.map(([path, text]) => ({ path, b64: Buffer.from(text).toString('base64') })) }]);
  assert.equal(imported.results[0].ok, false);
  assert.equal(await readFile(join(dir, 'old.txt'), 'utf8'), '旧附件');
  assert.match(await readFile(join(dir, 'SKILL.md'), 'utf8'), /旧正文/);
  const zip = new AdmZip(); for (const [p, text] of files) zip.addFile(p, Buffer.from(text));
  assert.equal((await manager.importSkillZipFromBuffer(zip.toBuffer())).ok, false);
  assert.equal(await readFile(join(dir, 'old.txt'), 'utf8'), '旧附件');
});

test('成功覆盖保留可恢复的旧版本，包装目录 ZIP 正确还原资源', async (t) => {
  await fixture(t);
  const dir = join(manager.skillsRoot(), 'original');
  await seed(dir, 'original', '旧正文'); await writeFile(join(dir, 'old.txt'), '旧附件');
  const zip = new AdmZip(); zip.addFile('package/SKILL.md', Buffer.from(doc('original', '新正文'))); zip.addFile('package/scripts/run.txt', Buffer.from('脚本'));
  const result = await manager.importSkillZipFromBuffer(zip.toBuffer());
  assert.equal(result.ok, true);
  assert.ok(result.backupPath, '覆盖前必须保留可恢复副本');
  assert.equal(await readFile(join(result.backupPath, 'old.txt'), 'utf8'), '旧附件');
  assert.equal(await readFile(join(dir, 'scripts/run.txt'), 'utf8'), '脚本');
  assert.ok(!(await readdir(dir)).includes('old.txt'));
});

test('同名独立来源在收纳与删除时均保留', async (t) => {
  await fixture(t);
  await seed(join(manager.skillsRoot(), 'collision'), 'collision', '库版本');
  const source = join(process.env.DSH_AGENTS_HOME, 'skills', 'collision');
  await seed(source, 'collision', '独立版本');
  const adopted = await manager.importUnmanagedSkills();
  assert.match(await readFile(join(source, 'SKILL.md'), 'utf8'), /独立版本/);
  assert.ok(adopted.conflicts?.includes('collision'));
  const deleted = await manager.deleteSkill('collision');
  assert.ok(deleted.backupPath);
  assert.match(await readFile(join(source, 'SKILL.md'), 'utf8'), /独立版本/);
  assert.match(await readFile(join(deleted.backupPath, 'SKILL.md'), 'utf8'), /库版本/);
});

test('不同 profile 不会串写同名会话选择', async (t) => {
  const root = await fixture(t);
  await seed(join(manager.skillsRoot(), 'picked'), 'picked');
  process.env.DSH_PROFILE = 'a';
  await manager.setSessionSkills('same-session', root, ['picked'], true);
  process.env.DSH_PROFILE = 'b';
  assert.equal((await manager.readSessionConfig('same-session')).explicit, false);
  await manager.setSessionSkills('same-session', root, [], true);
  process.env.DSH_PROFILE = 'a';
  assert.deepEqual((await manager.readSessionConfig('same-session')).enabled, ['picked']);
});

test('两个进程登记 40 个工作区不会丢更新或生成损坏 JSON', async (t) => {
  const root = await fixture(t);
  for (const p of ['a', 'b']) for (let i = 0; i < 20; i++) await mkdir(join(root, `ws-${p}-${i}`));
  const children = ['a', 'b'].map((profile) => fork(new URL('../scripts/audit-repro.cjs', import.meta.url), ['--registry-worker', root], {
    env: { ...process.env, DSH_PROFILE: profile }, silent: true, windowsHide: true,
  }));
  const exits = children.map((child) => once(child, 'exit'));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  await Promise.all(children.map((child) => once(child, 'message')));
  for (const child of children) child.send('start');
  for (const [code] of await Promise.all(exits)) assert.equal(code, 0);
  assert.equal((await manager.listWorkspaces()).length, 40);
});

test('损坏登记文件不会在下次登记时被当空文件覆盖', async (t) => {
  const root = await fixture(t), p = join(process.env.DSH_HOME, 'skill-manager', 'workspaces.json');
  await writeFile(p, '{损坏');
  await assert.rejects(() => manager.registerWorkspace(root), /损坏|JSON/);
  assert.equal(await readFile(p, 'utf8'), '{损坏');
});

test('管理页面隔离端口，保留同端口与本地 CLI', () => {
  assert.equal(manager.isTrustedPanelRequest({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3081' }), false);
  assert.equal(manager.isTrustedPanelRequest({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }), true);
  assert.equal(manager.isTrustedPanelRequest({ host: '127.0.0.1:3080' }), true);
});

test('新 profile 能纠正损坏的旧会话文件，并保留旧文件', async (t) => {
  const root = await fixture(t);
  const sessions = join(process.env.DSH_HOME, 'skill-manager', 'sessions');
  await mkdir(sessions, { recursive: true });
  await writeFile(join(sessions, 'legacy.json'), '{损坏');
  process.env.DSH_PROFILE = 'new-profile';
  assert.ok((await manager.readSessionConfig('legacy')).error);
  assert.equal((await manager.setSessionSkills('legacy', root, [], true)).ok, true);
  assert.equal((await manager.readSessionConfig('legacy')).error, undefined);
  assert.equal(await readFile(join(sessions, 'legacy.json'), 'utf8'), '{损坏');
});

test('会话字段类型损坏保持空选集，兼容缺省旧字段', async (t) => {
  const root = await fixture(t);
  const sessions = join(process.env.DSH_HOME, 'skill-manager', 'sessions');
  await mkdir(sessions, { recursive: true });
  const p = join(sessions, 'invalid.json');
  for (const invalid of [{ explicit: 'true', enabled: [] }, { explicit: true, enabled: 'picked' }, { cwd: 123 }]) {
    await writeFile(p, JSON.stringify(invalid));
    const cfg = await manager.readSessionConfig('invalid');
    assert.equal(cfg.explicit, true);
    assert.deepEqual(cfg.enabled, []);
    assert.ok(cfg.error);
  }
  await manager.setSessionSkills('invalid', root, [], true);
  assert.ok((await readdir(join(sessions, '.skm-backups'))).length);
  await writeFile(p, '{}');
  assert.equal((await manager.readSessionConfig('invalid')).explicit, false);
});

test('非法附件使目录和 ZIP 整体拒绝，原版本保持不变', async (t) => {
  await fixture(t);
  const dir = join(manager.skillsRoot(), 'original');
  await seed(dir, 'original', '旧正文');
  const files = [['SKILL.md', doc('original', '新正文')], ['scripts/aux.py', '关键脚本']];
  const result = await manager.importSkillDocs([{ files: files.map(([path, text]) => ({ path, b64: Buffer.from(text).toString('base64') })) }]);
  assert.equal(result.results[0].ok, false);
  assert.match(await readFile(join(dir, 'SKILL.md'), 'utf8'), /旧正文/);
  const zip = new AdmZip();
  for (const [p, text] of files) zip.addFile(p, Buffer.from(text));
  assert.equal((await manager.importSkillZipFromBuffer(zip.toBuffer())).ok, false);
  assert.match(await readFile(join(dir, 'SKILL.md'), 'utf8'), /旧正文/);
});

test('准备中的技能不会出现在引擎扫描根的直接子目录', async (t) => {
  await fixture(t);
  const lib = manager.skillsRoot();
  await replaceDirectory(join(lib, 'pending'), async (stage) => {
    await writeFile(join(stage, 'SKILL.md'), doc('pending'));
    const visible = [];
    for (const entry of await readdir(lib, { withFileTypes: true })) {
      if (entry.isDirectory()) try { visible.push(await readFile(join(lib, entry.name, 'SKILL.md'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    assert.deepEqual(visible, [], '提交前原生 provider 不应发现新技能');
  });
  assert.match(await readFile(join(lib, 'pending', 'SKILL.md'), 'utf8'), /pending/);
});
