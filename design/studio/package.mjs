import {readFile,writeFile} from 'node:fs/promises';
let html=await readFile(new URL('./index.html',import.meta.url),'utf8');
for(const name of ['Geist','GeistMono']) {
  const bytes=await readFile(new URL(`./assets/${name}.woff2`,import.meta.url));
  html=html.replace(`url('./assets/${name}.woff2')`,`url('data:font/woff2;base64,${bytes.toString('base64')}')`);
}
const license=await readFile(new URL('./FONT-LICENSE.txt',import.meta.url),'utf8');
await writeFile(new URL('./dealdock-studio.html',import.meta.url),`<!-- Font license\n${license.replaceAll('--','—')}\n-->\n${html}`);
console.log('Packaged one self-contained DealDock Studio HTML file.');
