import {cp,readFile,writeFile,mkdir,readdir,stat} from 'node:fs/promises';
import {resolve,dirname,relative,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const manifest=await readFile(resolve(root,'client/asset-manifest.ts'),'utf8');
const asset=manifest.match(/\/assets\/(ember-app\.[a-f0-9]+\.js)/)?.[1];
if(!asset)throw new Error('Build the native client first.');
async function filesIn(path){const result=[];for(const file of (await readdir(path)).sort()){const full=resolve(path,file);if((await stat(full)).isDirectory())result.push(...await filesIn(full));else result.push(full);}return result;}
const sourceFiles=[...await filesIn(resolve(root,'server')),...await filesIn(resolve(root,'pages')),resolve(root,'client/index.tsx'),resolve(root,'client/asset-manifest.ts'),resolve(root,'spacefast.config.ts'),resolve(root,'shared/room-icons.ts'),resolve(root,'service-worker.js')];
const assetRoot=resolve(root,'assets');const assets=new Set();
async function follow(file){if(!file.startsWith(assetRoot+sep))throw new Error('Asset escaped native assets directory.');if(assets.has(file))return;assets.add(file);const code=await readFile(file,'utf8');for(const match of code.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+\.js)["']/g))await follow(resolve(dirname(file),match[1]));}
await follow(resolve(assetRoot,asset));
for(const file of await filesIn(assetRoot))if(/\.(png|jpg|webp|svg|woff2|txt)$/.test(file))assets.add(file);
const hash=createHash('sha256');for(const file of [...sourceFiles,...assets].sort()){hash.update(relative(root,file));hash.update(await readFile(file));}const digest=hash.digest('hex');
const out=resolve(root,'.spacefast/serving-'+digest.slice(0,16));await mkdir(out,{recursive:true});
for(const file of [...sourceFiles,...assets]){const dest=resolve(out,relative(root,file));await mkdir(dirname(dest),{recursive:true});await cp(file,dest);}
const configPath=resolve(out,'spacefast.config.ts');
const config=await readFile(configPath,'utf8');
await writeFile(configPath,config.replace('  "build": {"outputDirectory": "dist"},\n',''));
const original=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
const pkg={name:'ember-spacefast-serving',private:true,type:'module',dependencies:{'@spacefast/zero':'0.8.0',preact:'10.29.8'},devDependencies:{spacefast:'0.8.0'},overrides:original.overrides};
await writeFile(resolve(out,'package.json'),JSON.stringify(pkg,null,2)+'\n');
await cp(resolve(root,'LICENSE'),resolve(out,'LICENSE'));
await writeFile(resolve(out,'.gitignore'),'node_modules/\n.spacefast/\n.stattic/\n.env*\n/docs/\n/tests/\n/fixtures/\n/scripts/\n/tooling/\n/vendor/\n!/server/vendor/\n!/server/vendor/**\n');
console.log(JSON.stringify({path:out,sourceSha256:digest,appAsset:asset,assetFiles:[...assets].map(file=>relative(root,file)),files:sourceFiles.length+assets.size+2},null,2));
