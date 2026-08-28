// dsh-skill-manager — core logic unit tests.
// Run: node test/unit.mjs
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import {
  parseSkillDoc, serializeSkillDoc, validSkillFileName, scanDir, summarize,
  editSkill, setSkillEnabled, deleteSkill, importSkillZipFromBuffer, importSkillDocs, searchSkills, skillsRoot, disabledRoot, migrateLegacySkills,
  findSkill, normalizeSkillDirs,
  listWorkspaceSkills, linkGlobalSkillToWorkspace, unlinkGlobalSkillFromWorkspace,
  sessionSkillView, setSessionSkills, readSessionConfig,
  registerWorkspace, listWorkspaces, renameWorkspace, forgetWorkspace,
  listUnmanagedSkills, importUnmanagedSkills, scanSkillSources, listSkillFiles,
  readSkillFile, writeSkillFile,
  isAbsolutePath, samePath, errMsg, bareSkillName,
  engineLoadState, collectEngineLoaded,
  isTrustedPanelRequest,
} from '../lib/index.js';

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.error(`  ❌ ${label}`); }
}

// isolate DSH_HOME into a temp dir for all fs operations
const home = await mkdtemp(join(tmpdir(), 'skm-test-'));
process.env.DSH_HOME = home;
await mkdir(skillsRoot(), { recursive: true });
console.log(`隔离 DSH_HOME: ${home}`);

const SAMPLE = `---
name: my-skill
description: A test skill
whenToUse: testing
---
# My Skill

Hello world`;

// --- parse / serialize ---
console.log('parseSkillDoc');
{
  const r = parseSkillDoc(SAMPLE);
  ok(r.frontmatter.name === 'my-skill', '解析 frontmatter name');
  ok(r.frontmatter.description === 'A test skill', '解析 frontmatter description');
  ok(r.body.includes('# My Skill'), '解析正文');
  const noFm = parseSkillDoc('# no frontmatter');
  ok(noFm.frontmatter.name === undefined && noFm.body.includes('no frontmatter'), '无 frontmatter 兜底');
  const bom = "\uFEFF" + SAMPLE;
  const rbom = parseSkillDoc(bom);
  ok(rbom.frontmatter.name === 'my-skill' && rbom.frontmatter.description === 'A test skill', '剥 BOM 后正常解析 frontmatter');
  ok(rbom.body.includes('# My Skill'), 'BOM 版本正文保留');
}

console.log('serializeSkillDoc');
{
  const s = serializeSkillDoc({ name: 'x', description: 'y' }, '# Body');
  ok(s.startsWith('---\n'), '输出带 frontmatter');
  ok(s.includes('name: x'), '含 name 字段');
  ok(s.endsWith('# Body') || s.endsWith('# Body\n'), '正文保留');
}

console.log('validSkillFileName');
{
  ok(validSkillFileName('my-skill.md'), 'kebab 合法');
  ok(!validSkillFileName('My Skill.md'), '大写/空格非法');
  ok(!validSkillFileName('my_skill.md'), '下划线非法');
  ok(!validSkillFileName('my-skill'), '缺 .md 非法');
}

// --- scan / summarize ---
console.log('scanDir / summarize');
{
  // directory form is canonical: <root>/<name>/SKILL.md
  const d = join(skillsRoot(), 'my-skill');
  await mkdir(d, { recursive: true });
  await writeFile(join(d, 'SKILL.md'), SAMPLE, 'utf8');
  const list = await scanDir(skillsRoot());
  ok(list.length === 1, '扫描到 1 个技能');
  ok(list[0].name === 'my-skill', '名称正确');
  ok(list[0].enabled === true, 'active 目录标记 enabled');
  ok(list[0].form === 'dir' && list[0].dir === d, '识别为目录形式');
  const sum = summarize(list[0]);
  ok(sum.bodyLength > 0, 'summarize 含长度');
}

// --- edit ---
console.log('editSkill');
{
  const r = await editSkill('my-skill', { frontmatter: { description: 'updated' }, body: '# New\n\nContent' });
  ok(r.ok === true, '编辑成功');
  const raw = await readFile(join(skillsRoot(), 'my-skill', 'SKILL.md'), 'utf8');
  ok(raw.includes('description: updated'), '描述已更新');
  ok(raw.includes('# New'), '正文已替换');
  const missing = await editSkill('nope', { body: 'x' });
  ok(missing.ok === false, '不存在返回错误');
}

// --- enable / disable is gone in the library model ---
console.log('setSkillEnabled (deprecated)');
{
  const off = await setSkillEnabled('my-skill', false);
  ok(off.ok === false, '全局启用/停用已移除（stub 拒绝）');
  ok((await readdir(skillsRoot())).includes('my-skill'), '技能仍在库中（未被移动）');
}

// --- import zip ---
console.log('importSkillZipFromBuffer');
{
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from(`---
name: imported-skill
description: from zip
---
# Imported

Body here`));
  const buf = zip.toBuffer();
  const r = await importSkillZipFromBuffer(buf);
  ok(r.ok === true && r.name === 'imported-skill', 'zip 导入成功');
  ok((await readdir(join(skillsRoot(), 'imported-skill'))).includes('SKILL.md'), '导入按目录形式落盘');
  const badZip = new AdmZip();
  badZip.addFile('README.md', Buffer.from('no skill here'));
  const bad = await importSkillZipFromBuffer(badZip.toBuffer());
  ok(bad.ok === false, '缺 SKILL.md 拒绝导入');
  const noName = new AdmZip();
  noName.addFile('SKILL.md', Buffer.from('# No frontmatter name'));
  const noNameR = await importSkillZipFromBuffer(noName.toBuffer());
  ok(noNameR.ok === false, 'frontmatter 缺 name 拒绝导入');
}

// --- import batch (folder) ---
console.log('importSkillDocs');
{
  const skill1 = `---
name: batch-skill-one
description: first batch skill
---
# One

Body one`;
  const skill2 = `---
name: batch-skill-two
description: second batch skill
---
# Two

Body two`;
  const good = await importSkillDocs([
    { source: 'skills/batch-skill-one/SKILL.md', content: skill1 },
    { source: 'skills/batch-skill-two/SKILL.md', content: skill2 },
  ]);
  ok(good.ok === true && good.results.length === 2 && good.results.every((r) => r.ok), '批量导入全部成功');
  ok((await readdir(join(skillsRoot(), 'batch-skill-one'))).includes('SKILL.md'), 'batch-skill-one 目录落盘');
  ok((await readdir(join(skillsRoot(), 'batch-skill-two'))).includes('SKILL.md'), 'batch-skill-two 目录落盘');
  // missing name / description / body, empty upload
  const bad = await importSkillDocs([
    { source: 'a/SKILL.md', content: '# no frontmatter' },
    { source: 'b/SKILL.md', content: '---\nname: desc-missing\n---\nbody' },
    { source: 'c/SKILL.md', content: '---\nname: body-missing\ndescription: x\n---\n' },
    { source: 'd/README.md', content: 'not a skill at all' },
  ]);
  ok(bad.ok === true && bad.results.length === 4 && bad.results.every((r) => !r.ok), '非法项全部被拒');
  ok(bad.results[0].error.includes('name'), '缺 name 原因明确');
  ok(bad.results[1].error.includes('description'), '缺 description 原因明确');
  ok(bad.results[2].error.includes('正文为空'), '空正文原因明确');
  const none = await importSkillDocs([]);
  ok(none.ok === false, '空数组拒绝');
}

// --- directory-form skills (<dir>/SKILL.md) ---
console.log('scanDir (directory form)');
{
  const skillDir = join(skillsRoot(), 'dir-skill');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: dir-skill\ndescription: a directory skill\n---\n# Dir skill body', 'utf8');
  await writeFile(join(skillDir, 'reference.md'), 'extra ref', 'utf8');
  const found = await scanDir(skillsRoot());
  const ds = found.find((s) => s.name === 'dir-skill');
  ok(ds && ds.form === 'dir', '目录形式技能被 scanDir 识别');
  ok(ds && ds.filePath.endsWith('SKILL.md'), 'filePath 指向 SKILL.md');
  ok(ds && ds.dir === skillDir, 'dir 字段指向技能目录');
  const entry = await findSkill('dir-skill');
  ok(entry && entry.name === 'dir-skill' && entry.form === 'dir', 'findSkill 找到目录形式技能');
  const r = await deleteSkill('dir-skill');
  ok(r.ok === true, '删除目录形式技能成功');
  ok(!(await readdir(skillsRoot())).includes('dir-skill'), '技能目录已移除');
}

// --- search across layers ---
console.log('searchSkills');
{
  const byName = await searchSkills('batch-skill-one');
  ok(byName.ok && byName.results.length === 1 && byName.results[0].name === 'batch-skill-one', '按 name 命中');
  ok(byName.results[0].why.includes('name'), '命中字段标注 name');
  const byDesc = await searchSkills('first batch skill');
  ok(byDesc.ok && byDesc.results.some((r) => r.name === 'batch-skill-one'), '按 description 命中');
  const byBody = await searchSkills('Body one');
  ok(byBody.ok && byBody.results.some((r) => r.name === 'batch-skill-one') && byBody.results[0].snippet, '按正文命中且带片段');
  const nothing = await searchSkills('definitely-not-there-xyz');
  ok(nothing.ok && nothing.results.length === 0, '无匹配返回空');
  const empty = await searchSkills('');
  ok(empty.ok && empty.results.length === 0, '空查询返回空');
  // case-insensitive
  const ci = await searchSkills('FIRST BATCH SKILL');
  ok(ci.ok && ci.results.some((r) => r.name === 'batch-skill-one'), '大小写不敏感');
  const found = byName.results[0];
  ok(found.layer === 'global' && found.origin === 'user', '批量导入的默认 global 层');
}

// --- delete ---
console.log('deleteSkill');
{
  const r = await deleteSkill('imported-skill');
  ok(r.ok === true, '删除成功');
  ok(!(await readdir(skillsRoot())).includes('imported-skill'), '技能目录已移除');
}

// --- workspace (L1) layer ---
console.log('linkGlobalSkillToWorkspace / listWorkspaceSkills / unlinkGlobalSkillFromWorkspace');
{
  // create a global skill to link (directory form)
  const wsSkillLibDir = join(skillsRoot(), 'ws-test-skill');
  await mkdir(wsSkillLibDir, { recursive: true });
  await writeFile(join(wsSkillLibDir, 'SKILL.md'), `---
name: ws-test-skill
description: for workspace layer
---
# WS
Body`, 'utf8');
  const ws = join(home, 'projects', 'demo');
  await mkdir(ws, { recursive: true });
  await registerWorkspace(ws); // write-side ops require a registered workspace
  const on = await linkGlobalSkillToWorkspace(ws, 'ws-test-skill');
  ok(on.ok === true, '工作区启用成功');
  const list = await listWorkspaceSkills(ws);
  ok(list.length === 1 && list[0].name === 'ws-test-skill', 'listWorkspaceSkills 能发现 link');
  ok(list[0].linked === true, '识别为 link');
  const filePath = join(ws, '.dsh', 'skills', 'ws-test-skill', 'SKILL.md');
  const target = await readFile(filePath, 'utf8');
  ok(target.includes('ws-test-skill'), 'link 内容与全局一致（单副本）');
  // global edit propagates through a symlink; a degraded copy does not
  // auto-sync (Windows w/o Developer Mode) but stays associated by name
  await editSkill('ws-test-skill', { body: '# Edited by global' });
  const after = await readFile(filePath, 'utf8');
  if (on.transport === 'symlink') {
    ok(after.includes('Edited by global'), 'symlink 下全局演进自动同步到工作区');
  } else {
    ok(!after.includes('Edited by global'), 'copy 降级时不同步（预期，无开发者模式）');
    const relist = await listWorkspaceSkills(ws);
    ok(relist.length === 1 && relist[0].linked === true, 'copy 降级仍按名字识别为启用');
  }
  const off = await unlinkGlobalSkillFromWorkspace(ws, 'ws-test-skill');
  ok(off.ok === true, '工作区停用成功');
  ok((await listWorkspaceSkills(ws)).length === 0, '停用后 list 为空');
  // preset skill not workspace-manageable
  const presetSkill = await linkGlobalSkillToWorkspace(ws, 'nope-preset');
  ok(presetSkill.ok === false, '不存在/预设技能不可工作区管理');
}

// --- search with workspace context (drives enable/disable in the search UI) ---
console.log('searchSkills(cwd)');
{
  const w2 = join(home, 'projects', 'search-ws');
  await mkdir(w2, { recursive: true });
  await registerWorkspace(w2);
  const on = await searchSkills('batch-skill-one', w2);
  ok(on.ok && on.results.some((r) => r.name === 'batch-skill-one' && r.wsEnabled === false && r.wsCwd === w2), '未启用工作区 wsEnabled=false');
  await linkGlobalSkillToWorkspace(w2, 'batch-skill-one');
  const yes = await searchSkills('batch-skill-one', w2);
  ok(yes.ok && yes.results.some((r) => r.name === 'batch-skill-one' && r.wsEnabled === true), '启用后 wsEnabled=true');
  await unlinkGlobalSkillFromWorkspace(w2, 'batch-skill-one');
  // no cwd supplied → wsEnabled falls back to plain boolean
  const plain = await searchSkills('batch-skill-one');
  ok(plain.ok && plain.results.some((r) => typeof r.wsEnabled === 'boolean'), '无 cwd 时 wsEnabled 仍为布尔');
}

// --- session (L2) layer ---
console.log('setSessionSkills / sessionSkillView (follow-workspace default)');
{
  const ws = join(home, 'projects', 'demo');
  await linkGlobalSkillToWorkspace(ws, 'ws-test-skill');
  const sid = 'session-abc-123';
  // no config yet: follow workspace → session-enabled = workspace set
  let view = await sessionSkillView(sid, ws);
  ok(view.ok === true, 'session view 成功');
  ok(view.session.explicit === false, '默认 explicit=false（跟随工作区）');
  ok(view.skills.find((s) => s.name === 'ws-test-skill').sessionEnabled === true, '跟随模式：工作区技能自动会话启用');
  // attempt to enable a skill NOT in workspace set -> filtered out
  const r = await setSessionSkills(sid, ws, ['ws-test-skill', 'non-workspace-skill']);
  ok(r.ok === true, 'session set 成功');
  ok(r.cfg.explicit === true, '显式勾选后 explicit=true');
  ok(r.cfg.enabled.length === 1 && r.cfg.enabled[0] === 'ws-test-skill', '超出工作区允许集的被过滤（交集校验）');
  view = await sessionSkillView(sid, ws);
  const wsSkill = view.skills.find((s) => s.name === 'ws-test-skill');
  ok(wsSkill.layer === 'workspace', '工作区 link 技能 layer 标注 workspace');
  ok(wsSkill.sessionEnabled === true, '显式模式下勾选状态正确');
  const cfg = await readSessionConfig(sid);
  ok(cfg.enabled.includes('ws-test-skill'), '会话配置落盘');
  // disable one skill: explicit stays true, the skill is removed from enabled
  const disable = await setSessionSkills(sid, ws, [], true);
  ok(disable.cfg.explicit === true, '停用后仍为显式模式');
  ok(disable.cfg.enabled.length === 0, '停用后 enabled 集合不含该技能');
  view = await sessionSkillView(sid, ws);
  ok(view.skills.find((s) => s.name === 'ws-test-skill').sessionEnabled === false, '停用后会话不再启用该技能');
  // restore follow-workspace
  const back = await setSessionSkills(sid, ws, [], false);
  ok(back.cfg.explicit === false, 'explicit=false 恢复跟随');
  view = await sessionSkillView(sid, ws);
  ok(view.session.explicit === false && view.skills.find((s) => s.name === 'ws-test-skill').sessionEnabled === true, '恢复跟随后仍全开');
  await unlinkGlobalSkillFromWorkspace(ws, 'ws-test-skill');
  // after workspace off, follow-mode session sees nothing
  view = await sessionSkillView(sid, ws);
  ok(view.skills.every((s) => !s.sessionEnabled), '跟随模式：工作区停用后会话不再启用');
}

// --- workspace registry + lifecycle (rebind/forget) ---
console.log('registerWorkspace / listWorkspaces / renameWorkspace / forgetWorkspace');
{
  const ws = join(home, 'projects', 'demo');
  await mkdir(ws, { recursive: true });
  const r = await registerWorkspace(ws);
  ok(r.ok === true, '登记工作区成功');
  const all = await listWorkspaces();
  ok(all.some((w) => w.cwd === ws), 'listWorkspaces 返回登记项');
  ok(all.find((w) => w.cwd === ws).exists === true, '目录存在标记正确');
  // dead-path pruning: a registered dir that no longer exists never
  // surfaces — the registry prunes stale entries on read
  const ghost = join(home, 'projects', 'ghost');
  await registerWorkspace(ghost);
  const pruned = await listWorkspaces();
  ok(!pruned.some((w) => w.cwd === ghost), '不存在的目录在列表读取时被自动清理');
  ok(pruned.some((w) => w.cwd === ws), '存在的目录仍在列表');
  // rebind after "rename": old → new
  const ws2 = join(home, 'projects', 'demo-renamed');
  await mkdir(ws2, { recursive: true });
  await registerWorkspace(ws2);
  const rebind = await renameWorkspace(ws, ws2);
  ok(rebind.ok === true, 'rebind 成功');
  const after = await listWorkspaces();
  ok(!after.some((w) => w.cwd === ws), '旧路径记录已移除');
  ok(after.some((w) => w.cwd === ws2), '新路径记录存在');
  // session config migration on rebind
  await setSessionSkills('sess-migrate', ws, []);
  const migrated = await renameWorkspace(ws2, ws);
  ok(migrated.ok === true, '二次 rebind 成功');
  const cfg = await readSessionConfig('sess-migrate');
  ok(cfg.cwd === ws, '会话 cwd 随 rebind 迁移');
  // forget: registry + orphan sessions removed, dir untouched
  const forget = await forgetWorkspace(ws);
  ok(forget.ok === true, 'forget 成功');
  const afterForget = await listWorkspaces();
  ok(!afterForget.some((w) => w.cwd === ws) && !afterForget.some((w) => w.cwd === ws2), 'forget 后注册表已清除该工作区');
  ok((await import('node:fs/promises')).stat(ws).then(() => true).catch(() => false), '工作区目录未被删除');
}

// --- project-root alignment (engine scans <nearest .git ancestor>/.dsh/skills) ---
console.log('projectRoot 对齐（git 仓库子目录工作区）');
{
  const fsp = await import('node:fs/promises');
  const repo = join(home, 'repos', 'my-project');
  const sub = join(repo, 'packages', 'app');
  await mkdir(join(repo, '.git'), { recursive: true });
  await mkdir(sub, { recursive: true });
  await registerWorkspace(sub);
  // a library skill, enabled from the SUBDIRECTORY cwd
  await mkdir(join(skillsRoot(), 'align-skill'), { recursive: true });
  await writeFile(join(skillsRoot(), 'align-skill', 'SKILL.md'), '---\nname: align-skill\ndescription: x\n---\nbody', 'utf8');
  const lr = await linkGlobalSkillToWorkspace(sub, 'align-skill');
  ok(lr.ok === true, '子目录 cwd 启用成功');
  const atRoot = await fsp.stat(join(repo, '.dsh', 'skills', 'align-skill')).then(() => true).catch(() => false);
  ok(atRoot, '链接落在仓库根 .dsh/skills（引擎实际扫描处）');
  const atSub = await fsp.stat(join(sub, '.dsh', 'skills')).then(() => true).catch(() => false);
  ok(!atSub, '未落在子目录自身 .dsh/skills');
  // legacy migration: pre-alignment links under <cwd>/.dsh/skills move to the root
  const sub2 = join(repo, 'packages', 'legacy-app');
  await mkdir(sub2, { recursive: true });
  await registerWorkspace(sub2);
  await mkdir(join(sub2, '.dsh', 'skills', 'old-skill'), { recursive: true });
  await writeFile(join(sub2, '.dsh', 'skills', 'old-skill', 'SKILL.md'), '---\nname: old-skill\ndescription: x\n---\nbody', 'utf8');
  await listWorkspaceSkills(sub2); // triggers lazy migration
  const moved = await fsp.stat(join(repo, '.dsh', 'skills', 'old-skill')).then(() => true).catch(() => false);
  ok(moved, '旧位 <cwd>/.dsh/skills 惰性迁移到仓库根 .dsh/skills');
  const legacyGone = await fsp.stat(join(sub2, '.dsh', 'skills')).then(() => false).catch(() => true);
  ok(legacyGone, '迁移后旧位目录已移除');
  // cleanup: forget both workspaces and remove the repo so later unmanaged
  // scans in this suite are not polluted by these project roots
  await forgetWorkspace(sub);
  await forgetWorkspace(sub2);
  await fsp.rm(repo, { recursive: true, force: true });
}

// --- legacy → library migration ---
console.log('migrateLegacySkills');
{
  // simulate the old layout inside this isolated home (legacy single-file .md
  // entries migrated into canonical directory form)
  const legacyRoot = join(home, 'skills');
  const legacyDisabled = join(home, 'skills-disabled');
  await mkdir(legacyRoot, { recursive: true });
  await mkdir(legacyDisabled, { recursive: true });
  await writeFile(join(legacyRoot, 'legacy-a.md'), '---\nname: legacy-a\ndescription: a\n---\nbody-a', 'utf8');
  await writeFile(join(legacyDisabled, 'legacy-b.md'), '---\nname: legacy-b\ndescription: b\n---\nbody-b', 'utf8');
  const r = await migrateLegacySkills();
  ok(r.ok === true, '迁移执行成功');
  const libFiles = await readdir(skillsRoot());
  ok(libFiles.includes('legacy-a') && libFiles.includes('legacy-b'), '旧技能以目录形式移入技能库');
  ok((await readdir(join(skillsRoot(), 'legacy-a'))).includes('SKILL.md'), 'legacy-a 目录含 SKILL.md');
  const migrated = await scanDir(skillsRoot());
  ok(migrated.some((s) => s.name === 'legacy-a' && s.form === 'dir'), '库内技能可扫描为目录形式');
  // the legacy global root must be emptied — the engine still loads
  // ~/.dsh/skills for every session, so leftover copies would bypass the
  // workspace whitelist (this is why unregistered skills showed up globally)
  ok((await readdir(legacyRoot)).length === 0 && (await readdir(legacyDisabled)).length === 0, '旧根已清空（引擎不再全局加载）');
  // idempotent
  const r2 = await migrateLegacySkills();
  ok(r2.ok === true, '重复迁移幂等');
}

// --- engine-root ghost skills: detect + adopt into the library ---
console.log('listUnmanagedSkills / importUnmanagedSkills');
{
  // engine roots: user-dsh (~/.dsh/skills) + user-agents ($DSH_AGENTS_HOME/skills);
  // entries are directory form (the only canonical layout)
  const userDsh = join(home, 'skills');
  // ghost-a: engine-root skill missing from the library
  // dup-b: directory whose SKILL.md re-declares a library name (batch-skill-two)
  //       — the whitelist "library wins" duplicate case
  await mkdir(join(userDsh, 'ghost-a'), { recursive: true });
  await writeFile(join(userDsh, 'ghost-a', 'SKILL.md'), '---\nname: ghost-a\ndescription: from engine root\n---\nbody', 'utf8');
  await mkdir(join(userDsh, 'dup-b'), { recursive: true });
  await writeFile(join(userDsh, 'dup-b', 'SKILL.md'), '---\nname: batch-skill-two\ndescription: duplicate\n---\nbody', 'utf8');
  process.env.DSH_AGENTS_HOME = join(home, 'agents');
  const userAgents = join(home, 'agents', 'skills');
  await mkdir(join(userAgents, 'ghost-c'), { recursive: true });
  await writeFile(join(userAgents, 'ghost-c', 'SKILL.md'), '---\nname: ghost-c\ndescription: from agents root\n---\nbody', 'utf8');

  const found = await listUnmanagedSkills();
  ok(found.length === 3, '引擎根扫描到 3 个游离技能');
  ok(found.some((s) => s.name === 'ghost-a' && !s.inLibrary), '未入库技能 inLibrary=false');
  ok(found.some((s) => s.name === 'batch-skill-two' && s.inLibrary), '库中同名识别为 inLibrary=true');

  const adopted = await importUnmanagedSkills();
  ok(adopted.ok === true, '收纳执行成功');
  ok(adopted.imported.includes('ghost-a') && adopted.imported.includes('ghost-c'), '未入库技能导入库');
  ok(!adopted.imported.includes('batch-skill-two'), '库 wins：同名不重复导入');
  ok(adopted.removed.length === 3, '引擎根副本全部移除');
  const libFiles = await readdir(skillsRoot());
  ok(libFiles.includes('ghost-a') && libFiles.includes('ghost-c'), '收纳后库内可扫描');
  ok((await readdir(userDsh)).length === 0, 'user-dsh 根已清空');
  ok((await readdir(userAgents)).length === 0, 'user-agents 根已清空');
  const again = await importUnmanagedSkills();
  ok(again.imported.length === 0 && again.removed.length === 0, '二次收纳幂等（无残留）');
  await rm(userAgents, { recursive: true, force: true });
  delete process.env.DSH_AGENTS_HOME;
}

// --- project-level scan: workspace whitelist + project .agents/skills ---
console.log('scanSkillSources（项目级）');
{
  const wsProj = join(home, 'projects', 'proj-a');
  await mkdir(join(wsProj, '.dsh', 'skills'), { recursive: true });
  await mkdir(join(wsProj, '.agents', 'skills'), { recursive: true });
  await registerWorkspace(wsProj);
  // workspace-authored local skill (missing from the library) — dir form
  await mkdir(join(wsProj, '.dsh', 'skills', 'local-only'), { recursive: true });
  await writeFile(join(wsProj, '.dsh', 'skills', 'local-only', 'SKILL.md'), '---\nname: local-only\ndescription: workspace authored\n---\nbody', 'utf8');
  // managed whitelist copy of an existing library skill (must NOT be listed)
  await mkdir(join(wsProj, '.dsh', 'skills', 'batch-skill-one'), { recursive: true });
  await writeFile(join(wsProj, '.dsh', 'skills', 'batch-skill-one', 'SKILL.md'), '---\nname: batch-skill-one\ndescription: dup\n---\nbody', 'utf8');
  // project .agents/skills (engine project root)
  await mkdir(join(wsProj, '.agents', 'skills', 'agent-only'), { recursive: true });
  await writeFile(join(wsProj, '.agents', 'skills', 'agent-only', 'SKILL.md'), '---\nname: agent-only\ndescription: project agents\n---\nbody', 'utf8');

  const found = await listUnmanagedSkills();
  const names = found.map((f) => f.name);
  ok(names.includes('local-only'), '本地产技能列入游离');
  ok(names.includes('agent-only'), '项目 .agents/skills 列入游离');
  ok(!names.includes('batch-skill-one'), '白名单中库同名副本不视为游离');
  const lo = found.find((f) => f.name === 'local-only');
  ok(lo && lo.adopt === 'keep' && lo.workspace === wsProj, '工作区 .dsh/skills 标记 keep');
  const ao = found.find((f) => f.name === 'agent-only');
  ok(ao && ao.adopt === 'move', '项目 .agents/skills 标记 move');

  const r = await importUnmanagedSkills();
  ok(r.imported.includes('local-only') && r.imported.includes('agent-only'), '两类源均导入库');
  ok(r.removed.length === 1 && r.removed[0] === 'agent-only', '仅 move 源移除（agent-only）');
  const wsFiles = (await readdir(join(wsProj, '.dsh', 'skills')));
  ok(wsFiles.includes('local-only') && wsFiles.includes('batch-skill-one'), '工作区白名单副本保留（该工作区保持启用）');
  ok((await readdir(join(wsProj, '.agents', 'skills'))).length === 0, '项目 agents 源已清空');
  const libFiles2 = await readdir(skillsRoot());
  ok(libFiles2.includes('local-only') && libFiles2.includes('agent-only'), '项目级技能纳入库后可扫描');
}

// --- normalizeSkillDirs: single-file → directory form ---
console.log('normalizeSkillDirs');
{
  const extra = join(home, 'normalize-probe');
  await mkdir(extra, { recursive: true });
  await writeFile(join(extra, 'legacy.md'), '---\nname: legacy\ndescription: probe\n---\nbody', 'utf8');
  const r = await normalizeSkillDirs([extra]);
  ok(r.ok === true, '迁移执行成功');
  ok(r.converted.some((c) => c.includes('legacy')), '转换记录含 legacy');
  ok(!(await readdir(extra)).includes('legacy.md'), '单文件已移除');
  ok((await readdir(join(extra, 'legacy'))).includes('SKILL.md'), '目录形式 SKILL.md 已写入');
  const r2 = await normalizeSkillDirs([extra]);
  ok(r2.converted.length === 0, '幂等：无单文件可转');
}

// --- security guards: traversal / unregistered workspace / identifier hygiene ---
console.log('security guards');
{
  const ws = join(home, 'projects', 'demo'); // re-register (registry test forgot it)
  await registerWorkspace(ws);
  const relink = await linkGlobalSkillToWorkspace(ws, 'ws-test-skill');
  ok(relink.ok === true, 'security 段先行启用技能');
  // unlink target name is interpolated into rm() → must reject traversal
  const evil1 = await unlinkGlobalSkillFromWorkspace(ws, '..');
  ok(evil1.ok === false, 'unlink 拒绝 ".." 技能名');
  const evil2 = await unlinkGlobalSkillFromWorkspace(ws, '../../outside');
  ok(evil2.ok === false, 'unlink 拒绝深层穿越技能名');
  const evil3 = await unlinkGlobalSkillFromWorkspace(ws, 'ws-test-skill.md');
  ok(evil3.ok === true, '合法名（去 .md 后缀）可正常停用');
  // write-side ops require a REGISTERED workspace
  const unreg = await linkGlobalSkillToWorkspace(join(home, 'projects', 'not-known'), 'ws-test-skill');
  ok(unreg.ok === false, '未注册工作区拒绝 link');
  const rel = await linkGlobalSkillToWorkspace('..\\..\\sub', 'ws-test-skill');
  ok(rel.ok === false, '相对 cwd 拒绝');
  // non-absolute cwd on reads falls back to the library instead of traversing
  const viaRel = await listSkillFiles('my-skill', '../..');
  ok(viaRel.ok === true, '非法 cwd 读取回退库而非上级目录');
  // sessionId traversal on write (invalid cwd short-circuits before the fs)
  const evilSession = await setSessionSkills('../evil', '', []);
  ok(evilSession.ok === false, '恶意 sessionId 写入被拒（cwd 短路径）');
  let sessionBlocked = false;
  try { await setSessionSkills('../evil', ws, []); } catch { sessionBlocked = true; }
  ok(sessionBlocked === true, '恶意 sessionId 写入被拒（identifier 校验）');
  // empty/non-absolute cwd for session pins is rejected with a clear error
  const noCwd = await setSessionSkills('ok-session', '', ['my-skill']);
  ok(noCwd.ok === false, '会话勾选要求绝对路径 cwd');
  const s = await sessionSkillView('../../traverse/', ws);
  ok(s.ok === true && s.session.enabled.length === 0 && s.session.explicit === false, '恶意 sessionId 读取安全降级（不越权、无选择项）');
}

// --- error boundaries: every rule must hold on the bad path too ---
console.log('error boundaries');
{
  const ws = join(home, 'projects', 'demo'); // registered in earlier sections
  // pure helpers
  ok(errMsg(new Error('boom')) === 'boom' && errMsg('raw') === 'raw' && errMsg(42) === '42', 'errMsg 文本化（不递归）');
  ok(isAbsolutePath(skillsRoot()) && isAbsolutePath(home), '绝对路径识别');
  ok(!isAbsolutePath('rel/path') && !isAbsolutePath('') && !isAbsolutePath('.\\x'), '相对/空/加点 拒绝');
  ok(bareSkillName('a-skill.md') === 'a-skill' && bareSkillName('a-skill') === 'a-skill', 'bareSkillName 去后缀');

  // scanDir ignores non-skill dirs and stray .md files (dir form only)
  await mkdir(join(skillsRoot(), 'not-a-skill'), { recursive: true }); // no SKILL.md
  await writeFile(join(skillsRoot(), 'stray.md'), 'not a skill', 'utf8');
  const scan1 = await scanDir(skillsRoot());
  ok(!scan1.some((s) => s.name === 'not-a-skill') && !scan1.some((s) => s.name === 'stray'), 'scanDir 忽略无 SKILL.md 目录与单文件');
  await rm(join(skillsRoot(), 'not-a-skill'), { recursive: true, force: true });
  await rm(join(skillsRoot(), 'stray.md'), { force: true });

  // readSkillFile / writeSkillFile path-escape guards
  const esc1 = await readSkillFile('my-skill', '../outside.md');
  ok(esc1.ok === false, 'readSkillFile 拒绝 .. 路径');
  const esc2 = await readSkillFile('my-skill', 'C:\\windows\\win.ini');
  ok(esc2.ok === false, 'readSkillFile 拒绝绝对路径');
  const esc3 = await writeSkillFile('my-skill', '../outside.md', 'x');
  ok(esc3.ok === false, 'writeSkillFile 拒绝 .. 路径');
  const esc4 = await writeSkillFile('my-skill', '', 'x');
  ok(esc4.ok === false, 'writeSkillFile 拒绝空路径');
  const missing = await readSkillFile('my-skill', 'no-such-file.md');
  ok(missing.ok === false, '读取不存在文件返回错误');

  // zip import error branches
  const zEmpty = await importSkillZipFromBuffer(Buffer.alloc(0));
  ok(zEmpty.ok === false, '空 zip 拒绝');
  const zCorrupt = await importSkillZipFromBuffer(Buffer.from('this is definitely not a zip file'));
  ok(zCorrupt.ok === false, '损坏 zip 拒绝（不 throw）');
  const zNoMd = new AdmZip(); zNoMd.addFile('readme.txt', Buffer.from('hi'));
  ok((await importSkillZipFromBuffer(zNoMd.toBuffer())).ok === false, '无 SKILL.md 的 zip 拒绝');
  const zNoName = new AdmZip(); zNoName.addFile('SKILL.md', Buffer.from('---\ndescription: no name\n---\nbody'));
  ok((await importSkillZipFromBuffer(zNoName.toBuffer())).ok === false, 'SKILL.md 缺 name 拒绝');
  // traversal entries inside the zip must not escape the skill dir
  const zEvil = new AdmZip();
  zEvil.addFile('SKILL.md', Buffer.from('---\nname: zip-skill\ndescription: x\n---\nbody'));
  zEvil.addFile('../evil.md', Buffer.from('nope'));
  zEvil.addFile('/abs.md', Buffer.from('nope'));
  zEvil.addFile('sub/ref.txt', Buffer.from('ref'));
  const zEvilR = await importSkillZipFromBuffer(zEvil.toBuffer());
  ok(zEvilR.ok === true, '含穿越条目的 zip 本体导入成功');
  // AdmZip normalizes ../ and leading-/ entry names; the escape guard
  // (parts + startsWith) guarantees nothing lands OUTSIDE the skill dir.
  ok(!(await readdir(join(skillsRoot(), '..'))).includes('evil.md'), '穿越条目未逃逸出技能库');
  const zdir = await readdir(join(skillsRoot(), 'zip-skill'));
  ok(zdir.includes('SKILL.md'), 'zip 内 SKILL.md 还原');
  ok((await readdir(join(skillsRoot(), 'zip-skill', 'sub'))).includes('ref.txt'), 'zip 内合法子目录/文件还原');
  // zip bomb: too many entries rejected by cap
  const big = new AdmZip();
  for (let i = 0; i < 1001; i++) big.addFile(`f${i}.bin`, Buffer.alloc(4));
  big.addFile('SKILL.md', Buffer.from('---\nname: bomb-skill\ndescription: x\n---\nbody'));
  const bomb = await importSkillZipFromBuffer(big.toBuffer());
  ok(bomb.ok === false, '超量条目 zip 拒绝（zip bomb 防护）');

  // importSkillDocs validation branches
  const docNoName = { source: 'a', content: '---\ndescription: x\n---\nbody' };
  const docBadName = { source: 'b', content: '---\nname: Bad Name\ndescription: x\n---\nbody' };
  const docNoDesc = { source: 'c', content: '---\nname: ok-name\n---\nbody' };
  const docNoBody = { source: 'd', content: '---\nname: bodyless\n---\n' };
  const docBad = await importSkillDocs([docNoName, docBadName, docNoDesc, docNoBody]);
  ok(docBad.results.every((r) => r.ok === false), '缺 name/非法 name/缺 description/缺 body 全部拒绝');
  // >200 items truncated
  const many = Array.from({ length: 201 }, (_, i) => ({ source: `s${i}`, content: `---\nname: bulk-${i}\ndescription: x\n---\nbody` }));
  const cut = await importSkillDocs(many);
  ok(cut.results.length === 200, '批量导入截断在 200 条');

  // unlink idempotent when already off
  const off2 = await unlinkGlobalSkillFromWorkspace(ws, 'ws-test-skill');
  ok(off2.ok === true, '停用已停用的技能幂等成功');
  const off3 = await unlinkGlobalSkillFromWorkspace(ws, 'no-such-skill');
  ok(off3.ok === true, '停用不存在的技能幂等成功');

  // renameWorkspace / forgetWorkspace edges
  const rnMissing = await renameWorkspace(join(home, 'projects', 'ghost'), join(home, 'projects', 'ghost2'));
  ok(rnMissing.ok === false, '重命名未登记工作区报错');
  const rnSame = await renameWorkspace(ws, ws);
  ok(rnSame.ok === true, '重命名到相同路径成功（no-op）');
  const fgGhost = await forgetWorkspace(join(home, 'projects', 'ghost'));
  ok(fgGhost.ok === true && fgGhost.existed === false, '忘记未登记工作区幂等（existed=false）');

  // normalizeSkillDirs failure: <root>/<base> is an existing FILE → cannot mkdir
  const badRoot = join(home, 'badroot');
  await mkdir(badRoot, { recursive: true });
  await writeFile(join(badRoot, 'clash.md'), '---\nname: clash\n---\nbody', 'utf8');
  await writeFile(join(badRoot, 'clash'), 'i am a file, not a dir', 'utf8');
  const nf = await normalizeSkillDirs([badRoot]);
  ok(nf.ok === true && nf.failed.some((f) => f.includes('clash')), '转换失败被记录到 failed（不 throw）');

  // readSessionConfig: corrupt JSON → safe defaults
  const sessDir = join(home, 'skill-manager', 'sessions');
  await mkdir(sessDir, { recursive: true });
  await writeFile(join(sessDir, 'corrupt.json'), '{not json', 'utf8');
  const cfg = await readSessionConfig('corrupt');
  ok(cfg.explicit === false && cfg.enabled.length === 0, '损坏会话配置降级为默认值');
  await writeFile(join(sessDir, 'mixed.json'), JSON.stringify({ explicit: true, enabled: [1, 'ok-name', null, ''] }), 'utf8');
  const cfg2 = await readSessionConfig('mixed');
  ok(cfg2.enabled.join(',') === 'ok-name', '会话 enabled 过滤非字符串');

  // session picks are library-wide: a library skill NOT enabled in the
  // workspace may still be session-enabled (the follow default is the
  // workspace set, but an explicit subset is not restricted to it)
  await linkGlobalSkillToWorkspace(ws, 'ws-test-skill');
  const free = await setSessionSkills('pin-session', ws, ['ws-test-skill', 'my-skill', 'no-such-skill']);
  ok(free.ok === true && free.cfg.enabled.includes('ws-test-skill') && free.cfg.enabled.includes('my-skill'), '会话可自由启用库中技能（含工作区未启用者）');
  ok(!free.cfg.enabled.includes('no-such-skill'), '非库技能名仍被过滤');
  // explicit rendering: the view must show the pinned library skill as
  // session-enabled even though the workspace never enabled it
  const vv = await sessionSkillView('pin-session', ws);
  ok(vv.ok === true && vv.skills.find((s) => s.name === 'my-skill')?.sessionEnabled === true, '会话视图：工作区未启用但会话勾选的库技能生效显示');
  // follow default: an un-pinned session tracks the workspace set
  const vf = await sessionSkillView('follow-probe', ws);
  ok(vf.ok === true && vf.session.explicit === false && vf.skills.find((s) => s.name === 'ws-test-skill')?.sessionEnabled === true, '未勾选过的会话默认跟随工作区');

  // migrateLegacySkills: idempotent after the first run, and the library
  // content is never overwritten by a legacy duplicate
  const legacyRoot = join(home, 'skills');
  await mkdir(legacyRoot, { recursive: true });
  await writeFile(join(legacyRoot, 'my-skill.md'), '---\nname: my-skill\ndescription: dup\n---\ndup body', 'utf8');
  const dup = await migrateLegacySkills();
  ok(dup.alreadyDone === true, '迁移幂等（第二次运行 no-op，不重复处理）');
  const dupEntry = await findSkill('my-skill');
  ok(dupEntry && !/dup body/.test(dupEntry.body), '库同名优先：库内容不被旧副本覆盖');
}

// --- engine-visibility (v4.2): ctx.skills.list as "what the engine loads" ---
console.log('engineLoadState / collectEngineLoaded');
{
  // preset rows are always ok
  ok(engineLoadState({ name: 'p1', layer: 'preset', origin: 'preset' }, []) === 'ok', 'preset 行恒为 ok');
  ok(engineLoadState({ name: 'p1', layer: 'global', origin: 'preset' }, []) === 'ok', 'origin=preset 行恒为 ok');
  // not enabled → off (no badge)
  ok(engineLoadState({ name: 'x', layer: 'global', sessionEnabled: false }, []) === 'off', '未启用 → off');
  // enabled + engine loads from project-dsh → ok
  const loaded = [{ name: 'a', source: 'project-dsh' }, { name: 'b', source: 'preset' }];
  ok(engineLoadState({ name: 'a', layer: 'workspace', sessionEnabled: true }, loaded) === 'ok', '启用且引擎以 project-dsh 加载 → ok');
  // enabled + engine loads same name from another layer → shadowed
  ok(engineLoadState({ name: 'b', layer: 'workspace', sessionEnabled: true }, loaded) === 'shadowed', '同名被其他来源（preset）覆盖 → shadowed');
  // enabled + engine has no such name → missing
  ok(engineLoadState({ name: 'ghost', layer: 'workspace', sessionEnabled: true }, loaded) === 'missing', '启用但引擎未加载 → missing');
  // null engineLoaded = can't judge (no badge, don't alarm) → unknown
  ok(engineLoadState({ name: 'ghost', layer: 'workspace', sessionEnabled: true }, undefined) === 'unknown', '引擎查询不可用 → unknown（不误报）');
  ok(engineLoadState({ name: 'ghost', layer: 'workspace', sessionEnabled: true }, null) === 'unknown', '引擎查询失败 → unknown');
  // EMPTY list must NOT be treated as "nothing loaded": the host-side read may
  // not see scope-layer providers even though the engine loads skills (the
  // code-review-skill regression). Empty → unknown, never missing.
  ok(engineLoadState({ name: 'ghost', layer: 'workspace', sessionEnabled: true }, []) === 'unknown', '空引擎列表 → unknown（不误报 missing）');
  // v4.1 session semantics: a pure session pick (view layer, not in the
  // workspace whitelist) is never judged against the engine catalog
  ok(engineLoadState({ name: 'picked', layer: 'global', origin: 'user', sessionEnabled: true }, []) === 'off', '纯会话勾选（视图层）不判引擎 → off');
  ok(engineLoadState({ name: 'picked', layer: 'global', origin: 'user', sessionEnabled: true }, loaded) === 'off', '纯会话勾选即使引擎有同名也 → off');
  // collectEngineLoaded: maps native summaries to the compact projection
  const fakeSvc = { list: async ({ cwd }) => cwd === 'C:/proj'
    ? [{ name: 'a', source: 'project-dsh', provider: 'filesystem' }]
    : (() => { throw new Error('boom'); })() };
  const got = await collectEngineLoaded(fakeSvc, 'C:/proj');
  ok(Array.isArray(got) && got[0].name === 'a' && got[0].source === 'project-dsh' && got[0].provider === 'filesystem', 'collectEngineLoaded 投影 name/source/provider');
  ok(await collectEngineLoaded(fakeSvc, 'C:/boom') === undefined, '引擎查询异常 → undefined');
  ok(await collectEngineLoaded(undefined, 'C:/proj') === undefined, '无 skills 服务 → undefined');
  ok(await collectEngineLoaded(fakeSvc, '') === undefined, '无 cwd → undefined');
}

// --- browser-trust fence (v4.3): mirrors dsh's /api isTrustedApiRequest ---
console.log('isTrustedPanelRequest');
{
  // loopback Hosts pass regardless of browser markers
  ok(isTrustedPanelRequest({ host: '127.0.0.1:3080' }) === true, 'loopback Host + no markers → 通过');
  ok(isTrustedPanelRequest({ host: 'localhost:3080' }) === true, 'localhost Host → 通过');
  ok(isTrustedPanelRequest({ host: '[::1]:3080' }) === true, 'IPv6 loopback → 通过');
  ok(isTrustedPanelRequest({ host: '127.5.9.1' }) === true, '127/8 任意地址 → 通过');
  // non-loopback Host → refused (DNS rebinding surface)
  ok(isTrustedPanelRequest({ host: 'evil.example.com' }) === false, '非 loopback Host（DNS rebinding）→ 拒绝');
  ok(isTrustedPanelRequest({ host: '192.168.1.10:3080' }) === false, '局域网 IP → 拒绝');
  ok(isTrustedPanelRequest({}) === false, '无 Host → 拒绝');
  ok(isTrustedPanelRequest({ host: '' }) === false, '空 Host → 拒绝');
  // cross-site browser marker → refused (CSRF)
  ok(isTrustedPanelRequest({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }) === false, 'sec-fetch-site=cross-site → 拒绝');
  ok(isTrustedPanelRequest({ host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }) === true, 'sec-fetch-site=same-origin → 通过');
  // Origin present → must be same-host
  ok(isTrustedPanelRequest({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }) === true, '同源 Origin → 通过');
  ok(isTrustedPanelRequest({ host: '127.0.0.1:3080', origin: 'http://evil.example.com' }) === false, '异源 Origin → 拒绝');
  ok(isTrustedPanelRequest({ host: '127.0.0.1:3080', origin: 'not-a-url' }) === false, '畸形 Origin → 拒绝');
}

await rm(home, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
