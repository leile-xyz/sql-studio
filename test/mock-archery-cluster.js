/**
 * 多环境 mock Archery 集群。
 * 用法：node test/mock-archery-cluster.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const profilePath = path.join(__dirname, 'mock-environments.json');
const serverPath = path.join(__dirname, 'mock-archery.js');
const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const ports = [...new Set(profile.environments.map(environment => {
  const url = new URL(`${environment.scheme || 'http'}://${environment.base}`);
  return String(Number(url.port || 80));
}))];

const children = [];
let shuttingDown = false;

function stopChildren(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(exitCode), 50);
}

for (const port of ports) {
  const child = spawn(process.execPath, [serverPath, port], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
  });
  child.on('exit', code => {
    if (shuttingDown) return;
    stopChildren(code || 1);
  });
  children.push(child);
}

process.on('SIGINT', () => stopChildren(0));
process.on('SIGTERM', () => stopChildren(0));

console.log(`mock Archery cluster listening on: ${ports.join(', ')}`);
