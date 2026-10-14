// 用桌面版 Electron 读取实际主题，供 UI 验收使用，避免手写变量掩盖兼容问题。
const fs = require('node:fs');
const path = require('node:path');
if (!process.argv[2]) throw new Error('请通过 run-desktop-test.mjs 传入桌面运行时目录');
const root = path.resolve(process.argv[2]);
const source = fs.readFileSync(path.join(root, 'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'), 'utf8');
const themes = [...source.matchAll(/(?:const|let|var) ([\w$]+) = ("(?:[^"\\]|\\.)*");/g)]
  .filter((match) => match[1].endsWith('css_default') && match[2].includes('--dsw-'))
  .map((match) => JSON.parse(match[2]));
const css = themes.join('\n');
if (!css.includes('--dsw-alias-button-primary-fill:') || !css.includes('--dsw-static-neutral-bluish-1000:')) {
  throw new Error('没有提取到完整宿主主题，停止验收');
}
const target = path.resolve(__dirname, '../../logs/skill-manager-ui/host-theme.css');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, css);
console.log('已导出本机 DSH 主题：' + target);
