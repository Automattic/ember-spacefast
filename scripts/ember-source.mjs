// Materialize the native app's upstream-derived source without changing the pinned snapshot.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inputs = join(root, 'upstream');
const checkout = resolve(root, '../vendor/ember');
const pinPath = join(inputs, 'base.json');
const patchPath = join(inputs, 'ember-web.patch');
const adapters = join(inputs, 'adapters');
const work = join(root, '.spacefast');
const receiptPath = join(work, 'ember-source.json');
const lockPath = join(work, 'ember-source.lock');
const commitPattern = /^[a-f0-9]{40}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const generatedPaths = ['client/ember', 'client/protocol', 'client/richtext', 'shared/room-icons.ts'];
const replacedUpstream = new Set([
  'client/ember/components/account-logo.tsx',
  'client/ember/lib/reconnecting-socket.ts',
  'client/protocol/room-icons.ts',
]);
const mappings = [
  ['apps/web/src', 'client/ember'],
  ['packages/protocol/src', 'client/protocol'],
  ['packages/richtext/src', 'client/richtext'],
];

async function exists(path) {
  try { await stat(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function files(path, prefix = '') {
  const entries = await readdir(path, {withFileTypes: true});
  const found = [];
  for (const entry of entries) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) found.push(...await files(join(path, entry.name), name + '/'));
    else if (entry.isFile()) found.push(name);
    else throw new Error('Unsupported upstream source entry: ' + name);
  }
  return found.sort();
}

async function copyFile(from, to) {
  await mkdir(dirname(to), {recursive:true});
  await cp(from, to);
}

async function copyFiles(from, to, names) {
  for (const name of names) await copyFile(join(from, name), join(to, name));
}

function distributable(name) {
  const pieces = name.split('/');
  const file = pieces.at(-1);
  return !pieces.some(piece => piece === 'testing' || piece === '__mocks__') &&
    !file.startsWith('test-') && !/\.(?:test|spec)\.[^.]+$/.test(file);
}

async function buildBase(to, replacement) {
  const embedded = join(inputs, 'base');
  if (!replacement && await exists(embedded)) {
    await copyFiles(embedded, to, await files(embedded));
    return;
  }
  const upstream = replacement ?? checkout;
  for (const [from, into] of mappings) {
    const directory = join(upstream, from);
    if (!await exists(directory)) throw new Error('Missing pinned Ember source at ' + directory);
    const names = (await files(directory)).filter(name => distributable(name) &&
      !(into === 'client/ember' && name === 'main.tsx'));
    await copyFiles(directory, join(to, into), names);
  }
  await copyFile(join(upstream, 'packages/protocol/src/room-icons.ts'), join(to, 'shared/room-icons.ts'));
}

async function treeDigest(path) {
  const hash = createHash('sha256');
  for (const name of await files(path)) {
    const digest = createHash('sha256').update(await readFile(join(path, name))).digest('hex');
    hash.update(JSON.stringify([name, digest]) + '\n');
  }
  return hash.digest('hex');
}

async function snapshotActive(to) {
  const present = [];
  for (const name of generatedPaths) {
    const from = join(root, name);
    if (!await exists(from)) continue;
    present.push(name);
    await mkdir(dirname(join(to, name)), {recursive:true});
    await cp(from, join(to, name), {recursive:true});
  }
  return present;
}

function git(args, cwd, allowed = [0]) {
  const result = spawnSync('git', args, {
    cwd,
    encoding:'utf8',
    maxBuffer:16 * 1024 * 1024,
    env:{...process.env, GIT_CEILING_DIRECTORIES:dirname(cwd)},
  });
  if (result.error) throw result.error;
  if (!allowed.includes(result.status)) throw new Error(result.stderr.trim() || 'Git command failed: ' + args[0]);
  return result.stdout;
}

async function applyOverlay(base) {
  const patch = await readFile(patchPath, 'utf8');
  if (patch.trim()) {
    try {
      git(['apply', '--check', '--whitespace=nowarn', patchPath], base);
      git(['apply', '--whitespace=nowarn', patchPath], base);
    } catch (error) {
      throw new Error('Spacefast patch conflicts with the Ember base. Update upstream/ember-web.patch before building.\n' + error.message);
    }
  }
  for (const name of await files(adapters)) {
    if (!generatedPaths.some(path => name === path || name.startsWith(path + '/'))) {
      throw new Error('Spacefast adapter is outside the generated source paths: ' + name);
    }
    if (await exists(join(base, name)) && !replacedUpstream.has(name)) {
      throw new Error('Spacefast adapter now overlaps upstream source: ' + name);
    }
    await copyFile(join(adapters, name), join(base, name));
  }
}

async function readPin() {
  const pin = JSON.parse(await readFile(pinPath, 'utf8'));
  if (!commitPattern.test(pin.commit) || !hashPattern.test(pin.sourceSha256)) throw new Error('Invalid Ember upstream pin.');
  return pin;
}

async function writePin(commit, sourceSha256, workDirectory) {
  const temporary = join(workDirectory, 'base.json');
  await writeFile(temporary, JSON.stringify({commit, sourceSha256}, null, 2) + '\n');
  await rename(temporary, pinPath);
}

async function verifyCheckoutCommit(directory, commit) {
  if (!await exists(join(directory, '.git'))) return;
  if (git(['rev-parse', 'HEAD'], directory).trim() !== commit) {
    throw new Error('The Ember checkout HEAD does not match the requested pin.');
  }
  if (git(['status', '--porcelain', '--untracked-files=all'], directory).trim()) {
    throw new Error('The Ember checkout contains local changes. Pin a clean checkout.');
  }
}

async function activate(expected, temporary, present) {
  const backup = join(temporary, 'previous');
  const moved = [];
  const installed = [];
  try {
    for (const name of present) {
      await mkdir(dirname(join(backup, name)), {recursive:true});
      await rename(join(root, name), join(backup, name));
      moved.push(name);
    }
    for (const name of generatedPaths) {
      await mkdir(dirname(join(root, name)), {recursive:true});
      await rename(join(expected, name), join(root, name));
      installed.push(name);
    }
  } catch (error) {
    for (const name of installed) await rm(join(root, name), {recursive:true, force:true});
    for (const name of moved) await rename(join(backup, name), join(root, name));
    throw error;
  }
}

async function acquireLock() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(lockPath);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await delay(100);
    }
  }
  throw new Error('Another Ember source operation is running. If it was interrupted, remove .spacefast/ember-source.lock and retry.');
}

async function main(command, argument, checkoutArgument) {
  await mkdir(work, {recursive:true});
  await acquireLock();
  let temporary;
  try {
    temporary = await mkdtemp(join(work, 'ember-source-'));
    const base = join(temporary, 'a');
    const active = join(temporary, 'b');
    const embedded = join(inputs, 'base');
    const hasEmbeddedBase = await exists(embedded);
    const replacement = checkoutArgument && resolve(checkoutArgument);
    if (replacement && (command !== 'pin' || !hasEmbeddedBase)) {
      throw new Error('A replacement checkout path is only supported when pinning an exported source package.');
    }
    await mkdir(base);
    await buildBase(base, replacement);
    const sourceSha256 = await treeDigest(base);

    if (command === 'pin') {
      if (!commitPattern.test(argument ?? '')) throw new Error('Specify a full 40-character Ember commit.');
      if (!hasEmbeddedBase || replacement) await verifyCheckoutCommit(replacement ?? checkout, argument);
      if (hasEmbeddedBase && !replacement) {
        throw new Error('Provide a clean checkout path to update an exported source package: npm run source:pin -- <commit> <checkout>.');
      }
      const nextBase = join(temporary, 'next-base');
      if (replacement) await copyFiles(base, nextBase, await files(base));
      await applyOverlay(base);
      if (replacement) {
        const previousBase = join(temporary, 'previous-base');
        await rename(embedded, previousBase);
        try {
          await rename(nextBase, embedded);
          await writePin(argument, sourceSha256, temporary);
        } catch (error) {
          await rm(embedded, {recursive:true, force:true});
          await rename(previousBase, embedded);
          throw error;
        }
      } else {
        await writePin(argument, sourceSha256, temporary);
      }
      console.log('Pinned Ember ' + argument);
      return;
    } else {
      const pin = await readPin();
      if (!hasEmbeddedBase) await verifyCheckoutCommit(checkout, pin.commit);
      if (pin.sourceSha256 !== sourceSha256) {
        throw new Error('Pinned Ember source has changed. Restore it or run npm run source:pin -- <full commit>.');
      }
    }

    if (command === 'export-base') {
      if (!argument || !isAbsolute(argument)) throw new Error('Provide an absolute path for the exported base.');
      await copyFiles(base, argument, await files(base));
      return;
    }

    await mkdir(active);
    const present = await snapshotActive(active);
    if (command === 'capture') {
      if (present.length !== generatedPaths.length) throw new Error('Generate the Ember source before capturing changes.');
      const expected = await treeDigest(active);
      for (const name of await files(adapters)) {
        const original = await readFile(join(adapters, name));
        const current = await readFile(join(active, name));
        if (!current.equals(original)) throw new Error('Edit the maintained adapter in upstream/adapters: ' + name);
        await rm(join(active, name));
        await rm(join(base, name), {force:true});
      }
      const patch = git(['diff', '--no-index', '--no-prefix', '--binary', '--no-renames',
        '--no-ext-diff', '--no-textconv', '--', 'a', 'b'], temporary, [0, 1]);
      const nextPatch = join(temporary, 'ember-web.patch');
      await writeFile(nextPatch, patch);
      await rename(nextPatch, patchPath);
      await writeFile(receiptPath, JSON.stringify({digest:expected}) + '\n');
      console.log('Captured Ember source patch.');
      return;
    }

    if (command !== 'prepare' && command !== 'check') throw new Error('Unknown Ember source operation: ' + command);
    await applyOverlay(base);
    const expected = await treeDigest(base);
    const current = await treeDigest(active);
    if (current !== expected) {
      if (command === 'check') throw new Error('The generated Ember source differs from its base and overlay.');
      const previous = await exists(receiptPath) ? JSON.parse(await readFile(receiptPath, 'utf8')).digest : null;
      if (present.length && current !== previous) {
        throw new Error('Generated Ember source has local edits. Preserve them with npm run source:capture, or restore the generated files before rebuilding.');
      }
      await activate(base, temporary, present);
    }
    if (command === 'prepare') await writeFile(receiptPath, JSON.stringify({digest:expected}) + '\n');
    console.log('Verified Ember source overlay.');
  } finally {
    try {
      if (temporary) await rm(temporary, {recursive:true, force:true});
    } finally {
      await rm(lockPath, {recursive:true, force:true});
    }
  }
}

main(process.argv[2], process.argv[3], process.argv[4]).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
