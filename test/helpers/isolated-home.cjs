// 子进程专用：即使被测脚本清空环境变量，也只能访问临时用户目录。
const os = require('node:os');
const { syncBuiltinESMExports } = require('node:module');
if (!process.env.SKM_TEST_HOME) throw new Error('缺少隔离测试目录');
os.homedir = () => process.env.SKM_TEST_HOME;
syncBuiltinESMExports();
