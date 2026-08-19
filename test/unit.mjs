// dsh-skill-manager — core logic unit tests.
// Run: node test/unit.mjs
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import {
  parseSkillDoc, serializeSkillDoc, validSkillFileName, scanDir, summarize,
  editSkill, setSkillEnabled, deleteSkill, importSkillZipFromBuffer, importSkillDocs, searchSkills, skillsRoot, disabledRoot, migrateLegacySkills,
  findSkill,
  listWorkspaceSkills, linkGlobalSkillToWorkspace, unlinkGlobalSkillFromWorkspace,
  sessionSkillView, setSessionSkills, readSessionConfig,
  registerWorkspace, listWorkspaces, renameWorkspace, forgetWorkspace,
  listUnmanagedSkills, importUnmanagedSkills, scanSkillSources,
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
  await writeFile(join(skillsRoot(), 'my-skill.md'), SAMPLE, 'utf8');
  const list = await scanDir(skillsRoot());
  ok(list.length === 1, '扫描到 1 个技能');
  ok(list[0].name === 'my-skill', '名称正确');
  ok(list[0].enabled === true, 'active 目录标记 enabled');
  const sum = summarize(list[0]);
  ok(sum.bodyLength > 0, 'summarize 含长度');
}

// --- edit ---
console.log('editSkill');
{
  const r = await editSkill('my-skill', { frontmatter: { description: 'updated' }, body: '# New\n\nContent' });
  ok(r.ok === true, '编辑成功');
  const raw = await readFile(join(skillsRoot(), 'my-skill.md'), 'utf8');
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
  ok((await readdir(skillsRoot())).includes('my-skill.md'), '技能仍在库中（未被移动）');
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
  ok((await readdir(skillsRoot())).includes('imported-skill.md'), '导入文件落盘');
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
  ok((await readdir(skillsRoot())).includes('batch-skill-one.md'), 'batch-skill-one 落盘');
  ok((await readdir(skillsRoot())).includes('batch-skill-two.md'), 'batch-skill-two 落盘');
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
  ok(!(await readdir(skillsRoot())).includes('imported-skill.md'), '文件已移除');
}

// --- workspace (L1) layer ---
console.log('linkGlobalSkillToWorkspace / listWorkspaceSkills / unlinkGlobalSkillFromWorkspace');
{
  // create a global skill to link
  await writeFile(join(skillsRoot(), 'ws-test-skill.md'), `---
name: ws-test-skill
description: for workspace layer
---
# WS
Body`, 'utf8');
  const ws = join(home, 'projects', 'demo');
  await mkdir(ws, { recursive: true });
  const on = await linkGlobalSkillToWorkspace(ws, 'ws-test-skill');
  ok(on.ok === true, '工作区启用成功');
  const list = await listWorkspaceSkills(ws);
  ok(list.length === 1 && list[0].name === 'ws-test-skill', 'listWorkspaceSkills 能发现 link');
  ok(list[0].linked === true, '识别为 link');
  const filePath = join(ws, '.dsh', 'skills', 'ws-test-skill.md');
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
  const r = await registerWorkspace(ws);
  ok(r.ok === true, '登记工作区成功');
  const all = await listWorkspaces();
  ok(all.length === 1 && all[0].cwd === ws, 'listWorkspaces 返回登记项');
  ok(all[0].exists === true, '目录存在标记正确');
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

// --- legacy → library migration ---
console.log('migrateLegacySkills');
{
  // simulate the old layout inside this isolated home
  const legacyRoot = join(home, 'skills');
  const legacyDisabled = join(home, 'skills-disabled');
  await mkdir(legacyRoot, { recursive: true });
  await mkdir(legacyDisabled, { recursive: true });
  await writeFile(join(legacyRoot, 'legacy-a.md'), '---\nname: legacy-a\ndescription: a\n---\nbody-a', 'utf8');
  await writeFile(join(legacyDisabled, 'legacy-b.md'), '---\nname: legacy-b\ndescription: b\n---\nbody-b', 'utf8');
  const r = await migrateLegacySkills();
  ok(r.ok === true, '迁移执行成功');
  const libFiles = await readdir(skillsRoot());
  ok(libFiles.includes('legacy-a.md') && libFiles.includes('legacy-b.md'), '旧技能移入技能库');
  const migrated = await scanDir(skillsRoot());
  ok(migrated.length >= 2, '库内技能可扫描');
  // the legacy global root must be emptied — the engine still loads
  // ~/.dsh/skills for every session, so leftover copies would bypass the
  // workspace whitelist (this is why unregistered skills showed up globally)
  const legacyLeft = (await readdir(legacyRoot)).filter((n) => n.endsWith('.md'));
  const disabledLeft = (await readdir(legacyDisabled)).filter((n) => n.endsWith('.md'));
  ok(legacyLeft.length === 0 && disabledLeft.length === 0, '旧根已清空（引擎不再全局加载）');
  // idempotent
  const r2 = await migrateLegacySkills();
  ok(r2.ok === true, '重复迁移幂等');
}

// --- engine-root ghost skills: detect + adopt into the library ---
console.log('listUnmanagedSkills / importUnmanagedSkills');
{
  // engine roots: user-dsh (~/.dsh/skills) + user-agents ($DSH_AGENTS_HOME/skills)
  const userDsh = join(home, 'skills');
  await writeFile(join(userDsh, 'ghost-a.md'), '---\nname: ghost-a\ndescription: from engine root\n---\nbody', 'utf8');
  await writeFile(join(userDsh, 'dup-b.md'), '---\nname: batch-skill-two\ndescription: duplicate\n---\nbody', 'utf8');
  process.env.DSH_AGENTS_HOME = join(home, 'agents');
  const userAgents = join(home, 'agents', 'skills');
  await mkdir(userAgents, { recursive: true });
  await writeFile(join(userAgents, 'ghost-c.md'), '---\nname: ghost-c\ndescription: from agents root\n---\nbody', 'utf8');

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
  ok(libFiles.includes('ghost-a.md') && libFiles.includes('ghost-c.md'), '收纳后库内可扫描');
  ok((await readdir(userDsh)).filter((n) => n.endsWith('.md')).length === 0, 'user-dsh 根已清空');
  ok((await readdir(userAgents)).filter((n) => n.endsWith('.md')).length === 0, 'user-agents 根已清空');
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
  // workspace-authored local skill (missing from the library)
  await writeFile(join(wsProj, '.dsh', 'skills', 'local-only.md'), '---\nname: local-only\ndescription: workspace authored\n---\nbody', 'utf8');
  // managed whitelist copy of an existing library skill (must NOT be listed)
  await writeFile(join(wsProj, '.dsh', 'skills', 'batch-skill-one.md'), '---\nname: batch-skill-one\ndescription: dup\n---\nbody', 'utf8');
  // project .agents/skills (engine project root)
  await writeFile(join(wsProj, '.agents', 'skills', 'agent-only.md'), '---\nname: agent-only\ndescription: project agents\n---\nbody', 'utf8');

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
  const wsFiles = (await readdir(join(wsProj, '.dsh', 'skills'))).filter((n) => n.endsWith('.md'));
  ok(wsFiles.includes('local-only.md') && wsFiles.includes('batch-skill-one.md'), '工作区白名单副本保留（该工作区保持启用）');
  ok((await readdir(join(wsProj, '.agents', 'skills'))).filter((n) => n.endsWith('.md')).length === 0, '项目 agents 源已清空');
  const libFiles2 = await readdir(skillsRoot());
  ok(libFiles2.includes('local-only.md') && libFiles2.includes('agent-only.md'), '项目级技能纳入库后可扫描');
}

await rm(home, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
