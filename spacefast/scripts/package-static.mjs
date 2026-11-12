import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const output = new URL('dist/', root);
const manifest = await readFile(new URL('client/asset-manifest.ts', root), 'utf8');
const bundle = manifest.match(/\/assets\/(ember-app\.[a-f0-9]+\.js)/)?.[1];
if (!bundle) throw new Error('Build the Ember client before packaging public assets.');

await rm(output, {recursive:true, force:true});
await mkdir(new URL('assets/', output), {recursive:true});
for (const name of await readdir(new URL('assets/', root))) {
  if (name === bundle || /\.(png|jpg|webp|svg|woff2|txt)$/.test(name)) {
    await cp(new URL('assets/' + name, root), new URL('assets/' + name, output));
  }
}
await cp(new URL('service-worker.js', root), new URL('service-worker.js', output));
console.log('Prepared Spacefast public assets in ' + fileURLToPath(output));
