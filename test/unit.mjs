// dsh-skill-manager — core logic unit tests.
// Run: node test/unit.mjs
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import {
  parseSkillDoc, serializeSkillDoc, validSkillFileName, scanDir, summarize,
  editSkill, setSkillEnabled, deleteSkill, importSkillZipFromBuffer, importSkillDocs, searchSkills, skillsRoot, disabledRoot,
  listWorkspaceSkills, linkGlobalSkillToWorkspace, unlinkGlobalSkillFromWorkspace,
  sessionSkillView, setSessionSkills, readSessionConfig,
  registerWorkspace, listWorkspaces, renameWorkspace, forgetWorkspace,
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

// --- enable / disable ---
console.log('setSkillEnabled');
{
  const off = await setSkillEnabled('my-skill', false);
  ok(off.ok === true && off.enabled === false, '禁用成功');
  ok((await readdir(skillsRoot())).length === 0, 'active 目录已清空');
  const disabledFiles = await readdir(disabledRoot());
  ok(disabledFiles.includes('my-skill.md'), '文件移入 skills-disabled');
  const on = await setSkillEnabled('my-skill', true);
  ok(on.ok === true && on.enabled === true, '启用成功');
  ok((await readdir(skillsRoot())).includes('my-skill.md'), '文件移回 active');
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

await rm(home, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
