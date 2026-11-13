import { mkdir, copyFile, readdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const destination=path.join(root,'dist',`heroku-${stamp}`);
const files=[];
async function copy(relative) {
  const source=path.join(root,relative),target=path.join(destination,relative),info=await stat(source);
  if(info.isDirectory()) {
    await mkdir(target,{recursive:true});
    for(const entry of await readdir(source))await copy(path.join(relative,entry));
  } else {await mkdir(path.dirname(target),{recursive:true});await copyFile(source,target);files.push(relative.replaceAll('\\','/'));}
}
await mkdir(destination,{recursive:true});
for(const relative of ['package.json','package-lock.json','Procfile','app.json','.slugignore','server.mjs','lib','public','docs/CONNECTIONS.md','docs/HEROKU.md'])await copy(relative);
await writeFile(path.join(destination,'.gitignore'),'.env\nnode_modules/\ndata/\n');
await writeFile(path.join(destination,'DEPLOYMENT-MANIFEST.json'),JSON.stringify({createdAt:new Date().toISOString(),scope:'single-owner preview',files,excluded:['.env','data','connection-key','references','test-results','tests']},null,2));
console.log(`Deployment folder: ${destination}`);
console.log('Includes only the Commerce Hub runtime and deployment instructions. No credentials, local database, upstream reference source, or laundry app files.');

