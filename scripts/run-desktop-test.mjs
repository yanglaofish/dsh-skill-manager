// 用桌面内核执行 CJS 测试，等待进程结束并保留正确的退出码。
import { spawn } from 'node:child_process';
import path from 'node:path';
const [app, script] = process.argv.slice(2);
if (!app || !script) throw new Error('用法：node scripts/run-desktop-test.mjs <桌面目录> <测试脚本>');
const child = spawn(path.join(app, 'DeepSeek Harness.exe'), ['--expose-internals', path.resolve(script), path.join(app, 'resources', 'app.asar', 'dsh')], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'inherit',
});
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
