import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('./index.html',import.meta.url),'utf8');
const script=source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script,'Prototype must contain its interactions');
new Function(script);
const moneySource=script.slice(script.indexOf('function money('),script.indexOf('function parseAmount('));
const amountSource=script.slice(script.indexOf('function parseAmount('),script.indexOf('var creators='));
// Exercise the actual artifact's pure functions; no DOM or service substitute.
const money=new Function(`${moneySource};return money;`)();
const parse=new Function(`${amountSource};return parseAmount;`)();
assert.equal(parse('18500.25'),1850025);
assert.equal(money(1850025),'₹18,500.25');
assert.equal(parse('90071992547409.91'),Number.MAX_SAFE_INTEGER);
assert.equal(money(Number.MAX_SAFE_INTEGER),'₹9,00,71,99,25,47,409.91');
for(const invalid of ['90071992547409.92','0.00','1e3','1.001','-2',''])assert.equal(parse(invalid),null);
const portable=await readFile(new URL('./dealdock-studio.html',import.meta.url),'utf8');
assert.equal((portable.match(/data:font\/woff2;base64,/g)??[]).length,2);
assert.equal(portable.includes("url('./assets/"),false,'Portable HTML must embed its fonts');
assert.equal(/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(script),false,'Prototype must not contact product/provider APIs');
console.log('Studio checks passed: syntax, exact minor-unit parsing/formatting, invalid input, embedded fonts and no API calls.');
