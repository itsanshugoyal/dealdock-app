import { readdirSync, readFileSync } from 'node:fs';
import { inspectSource } from './boundary-rules.mjs';
const violations = [];
function scan(path) {
  for (const entry of readdirSync(path, {withFileTypes:true})) {
    const file = `${path}/${entry.name}`;
    if (['node_modules','dist','.next','.turbo'].includes(entry.name)) continue;
    if (entry.isDirectory()) scan(file);
    else if (/\.[cm]?[jt]sx?$/.test(file) && file.includes('/src/')) violations.push(...inspectSource(file, readFileSync(file, 'utf8')));
  }
}
for (const path of ['apps','packages']) scan(path);
const manifest = JSON.parse(readFileSync('apps/worker/package.json','utf8'));
for (const deps of [manifest.dependencies, manifest.devDependencies]) {
  if (deps?.['@dealdock/messaging']) violations.push('apps/worker/package.json: messaging dependency forbidden');
}
if (violations.length) { console.error(violations.join('\n')); process.exit(1); }
console.log('Architecture boundaries passed for every app and package.');
