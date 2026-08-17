// dsh-skill-manager — core logic unit tests.
// Run: node --input-type=module test/unit.mjs
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import {
  parseSkillDoc, serializeSkillDoc, validSkillFileName, scanDir, summarize,
  editSkill, setSkillEnabled, deleteSkill, importSkillZipFromBuffer, skillsRoot, disabledRoot,
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

// --- delete ---
console.log('deleteSkill');
{
  const r = await deleteSkill('imported-skill');
  ok(r.ok === true, '删除成功');
  ok(!(await readdir(skillsRoot())).includes('imported-skill.md'), '文件已移除');
}

await rm(home, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
