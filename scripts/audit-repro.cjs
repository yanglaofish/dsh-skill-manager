// 审查复现：所有数据写入 mkdtemp 创建的目录，不启动或修改用户 profile。
// 可选参数为桌面运行时目录；使用 Electron Node 模式时可验证真实技能加载器。
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const manager = require('../lib/index.js');
const AdmZip = require('adm-zip');

const doc = (name, body = '正文') => `---\nname: ${name}\ndescription: 隔离验证\n---\n${body}`;
const exists = async (p) => fs.lstat(p).then(() => true, () => false);
async function seed(dir, name, body) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), doc(name, body));
}
const findings = [];
function finding(id, confirmed, details) {
  findings.push({ id, confirmed });
  console.log(JSON.stringify({ id, confirmed, ...details }));
}

if (process.argv[2] === '--registry-worker') {
  process.on('message', async () => {
    try {
      for (let i = 0; i < 20; i++) {
        await manager.registerWorkspace(path.join(process.argv[3], `ws-${process.env.DSH_PROFILE}-${i}`));
      }
      process.exit(0);
    } catch (error) { console.error(error.message); process.exit(1); }
  });
  process.send('ready');
} else {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}

async function main() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'skm-audit-'));
  const children = [];
  process.env.DSH_HOME = path.join(root, 'dsh');
  process.env.DSH_AGENTS_HOME = path.join(root, 'agents');
  delete process.env.DSH_BUNDLED_SKILL_DIR;
  try {
    const lib = manager.skillsRoot();
    // 无 .. 的绝对路径仍可利用同名前缀绕过字符串 startsWith。
    await seed(path.join(lib, 'safe'), 'safe');
    const sibling = path.join(lib, 'safe-other', 'note.txt');
    await fs.mkdir(path.dirname(sibling), { recursive: true });
    await fs.writeFile(sibling, '原文');
    const escaped = await manager.writeSkillFile('safe', sibling, '越界修改');
    finding('absolute-path-escape', escaped.ok && await fs.readFile(sibling, 'utf8') === '越界修改', {});

    // Windows junction 和 POSIX 符号链接都只指向本次临时目录。
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'note.txt'), '原文');
    await fs.symlink(outside, path.join(lib, 'safe', 'jump'), process.platform === 'win32' ? 'junction' : 'dir');
    const jumped = await manager.writeSkillFile('safe', 'jump/note.txt', '链接越界');
    finding('symlink-path-escape', jumped.ok && await fs.readFile(path.join(outside, 'note.txt'), 'utf8') === '链接越界', {});

    // 文件/目录冲突使写入在中途失败，检查旧版本是否仍可恢复。
    await seed(path.join(lib, 'replacement'), 'replacement', '旧正文');
    const oldAsset = path.join(lib, 'replacement', 'old.txt');
    await fs.writeFile(oldAsset, '旧附件');
    const imported = await manager.importSkillDocs([{ files: [
      { path: 'SKILL.md', b64: Buffer.from(doc('replacement', '新正文')).toString('base64') },
      { path: 'assets', b64: Buffer.from('这是文件').toString('base64') },
      { path: 'assets/icon.txt', b64: Buffer.from('子文件').toString('base64') },
    ] }]);
    finding('failed-import-destroys-previous', !imported.results[0].ok && !await exists(oldAsset), { result: imported.results[0].ok });

    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from(doc('zip-conflict')));
    zip.addFile('assets', Buffer.from('文件'));
    zip.addFile('assets/icon.txt', Buffer.from('附件'));
    const zipped = await manager.importSkillZipFromBuffer(zip.toBuffer());
    finding('zip-silent-partial-success', zipped.ok && !await exists(path.join(lib, 'zip-conflict', 'assets', 'icon.txt')), { result: zipped.ok });

    // 同名不是同内容：收纳和删除都不应据此销毁其他工具的独立版本。
    await seed(path.join(lib, 'collision'), 'collision', '库版本');
    const source = path.join(process.env.DSH_AGENTS_HOME, 'skills', 'collision');
    await seed(source, 'collision', '其他工具独立版本');
    await manager.importUnmanagedSkills();
    finding('adopt-name-collision-loss', !await exists(source), {});
    await seed(source, 'collision', '其他工具独立版本');
    await manager.deleteSkill('collision');
    finding('delete-unrelated-same-name', !await exists(source), {});

    finding('cross-profile-origin-allowed', manager.isTrustedPanelRequest({
      host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3081', 'sec-fetch-site': 'same-site',
    }), {});

    // 两个真实进程模拟两个 profile，并发更新同一 DSH_HOME。
    for (const profile of ['a', 'b']) {
      for (let i = 0; i < 20; i++) await fs.mkdir(path.join(root, `ws-${profile}-${i}`));
    }
    const ready = [], exits = [];
    for (const profile of ['a', 'b']) {
      const child = fork(__filename, ['--registry-worker', root], {
        env: { ...process.env, DSH_PROFILE: profile }, windowsHide: true, silent: true,
      });
      children.push(child);
      child.stderr.on('data', (data) => process.stderr.write(data));
      ready.push(once(child, 'message'));
      exits.push(once(child, 'exit'));
    }
    await Promise.all(ready);
    for (const child of children) child.send('start');
    for (const [code] of await Promise.all(exits)) assert.equal(code, 0);
    const registered = await manager.listWorkspaces();
    finding('multi-profile-lost-registry-update', registered.length !== 40, { expected: 40, actual: registered.length });

    // 会话修复需要加载插件的真实 agent scope，不能只测未接插件的文件系统 provider。
    if (process.argv[2]) {
      const { spawnSync } = require('node:child_process');
      const result = spawnSync(process.execPath, [path.join(__dirname, 'session-runtime.test.cjs'), process.argv[2]], {
        env: process.env, encoding: 'utf8', windowsHide: true, timeout: 30000,
      });
      if (result.status !== 0) throw new Error(result.stderr || result.error?.message || '会话内核验证失败');
      finding('session-selection-runtime', false, { verified: true, result: result.stdout.trim() });
    }
    assert.deepEqual(findings.filter((entry) => entry.confirmed), [], '仍存在已确认缺陷');
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    // root 是本次 mkdtemp 的独立根；链接目标也全部位于此根之内。
    await fs.rm(root, { recursive: true, force: true });
  }
}
