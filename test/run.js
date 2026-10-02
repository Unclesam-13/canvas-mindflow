// 依次运行所有测试（每个测试用一个假的 obsidian 模块，在 Node 里直接跑）
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
for (const f of fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort()) {
  process.stdout.write(`▶ ${f}\n`);
  execFileSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
}
console.log('all tests passed');
