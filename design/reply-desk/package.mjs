import {readFile,writeFile} from 'node:fs/promises';
const source=new URL('./index.html',import.meta.url);
const font=await readFile(new URL('./assets/Geist.woff2',import.meta.url));
const license=await readFile(new URL('./FONT-LICENSE.txt',import.meta.url),'utf8');
const html=(await readFile(source,'utf8')).replace("url('./assets/Geist.woff2')",`url('data:font/woff2;base64,${font.toString('base64')}')`);
await writeFile(new URL('./dealdock-reply-desk.html',import.meta.url),`<!-- Geist font license\n${license.replaceAll('--','—')}\n-->\n${html}`);
console.log('Standalone HTML packaged with its font and license.');
