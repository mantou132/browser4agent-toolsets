// Validates toolsets with the market's own parser; with --publish, also syncs them to the market (needs
// MARKET_TOKEN).
//
//   node scripts/publish.mjs                       validate every toolset
//   node scripts/publish.mjs toolsets/a.js         validate the given toolsets
//   node scripts/publish.mjs --since <commit>      validate toolsets added or changed since <commit>
//   ... --publish                                  also create/update them, and with --since delete
//                                                  toolsets whose names no longer exist
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const API = process.env.MARKET_API || 'https://browser4agent-market.709922234.workers.dev';
const args = process.argv.slice(2);
const publish = args.includes('--publish');
const since = args.includes('--since') ? args[args.indexOf('--since') + 1] : '';
const token = process.env.MARKET_TOKEN;
if (publish && !token) throw new Error('MARKET_TOKEN is required to publish');

const git = (...gitArgs) => execFileSync('git', gitArgs, { encoding: 'utf8' });
const isToolset = (file) => /\.[cm]?[jt]s$/.test(file);
const moduleName = (content) => content.match(/@module\s+(.+)/)?.[1].trim();

const all = (await readdir('toolsets')).filter(isToolset).sort();
const contents = new Map(await Promise.all(all.map(async (file) => [file, await readFile(`toolsets/${file}`, 'utf8')])));

let files = all;
let removedNames = [];
if (since) {
  // --no-renames reports a moved file as deleted + added; names, not paths, decide what gets removed.
  files = git('diff', '--no-renames', '--name-only', '--diff-filter=AM', since, 'HEAD', '--', 'toolsets/')
    .split('\n')
    .map((path) => basename(path))
    .filter((file) => contents.has(file));
  const currentNames = new Set([...contents.values()].map(moduleName));
  removedNames = git('ls-tree', '--name-only', since, 'toolsets/')
    .split('\n')
    .filter(isToolset)
    .map((path) => moduleName(git('show', `${since}:${path}`)))
    .filter((name) => name && !currentNames.has(name));
} else {
  const requested = args.filter((arg) => isToolset(arg)).map((arg) => basename(arg));
  if (requested.length) files = requested.filter((file) => contents.has(file));
}

let failed = false;

// The @module name is the toolset's identity in the market, and every toolset here is owned by the same
// token, so a duplicate name would silently overwrite another toolset. Check all files locally.
const owners = new Map();
for (const [file, content] of contents) {
  const name = moduleName(content);
  if (owners.has(name)) {
    console.error(`✗ ${file}: toolset name "${name}" is already used by ${owners.get(name)}`);
    failed = true;
  }
  owners.set(name, file);
}

const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
const toolsetUrl = (name) => `${API}/api/toolsets/${encodeURIComponent(name)}`;

for (const file of files) {
  const res = await fetch(`${API}/api/toolsets/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: contents.get(file), filename: file }),
  });
  const toolset = await res.json();
  if (!res.ok) {
    console.error(`✗ ${file}: ${toolset.error}`);
    failed = true;
    continue;
  }
  console.log(`✓ ${file}: ${toolset.name} (${toolset.tools.map((tool) => tool.name).join(', ')})`);
  if (!publish || failed) continue;

  const body = JSON.stringify(toolset);
  let write = await fetch(toolsetUrl(toolset.name), { method: 'PUT', headers, body });
  const created = write.status === 404;
  if (created) write = await fetch(`${API}/api/toolsets`, { method: 'POST', headers, body });
  if (write.ok) {
    console.log(`  ${created ? 'created' : 'updated'} in the market`);
  } else {
    console.error(`  ✗ publish failed: ${write.status} ${(await write.json()).error}`);
    failed = true;
  }
}

for (const name of removedNames) {
  console.log(`- ${name}: removed from the repository`);
  if (!publish || failed) continue;
  const res = await fetch(toolsetUrl(name), { method: 'DELETE', headers });
  if (res.ok || res.status === 404) {
    console.log('  deleted from the market');
  } else {
    console.error(`  ✗ delete failed: ${res.status} ${(await res.json()).error}`);
    failed = true;
  }
}

if (!files.length && !removedNames.length) console.log('No changed toolsets.');
if (failed) process.exit(1);
