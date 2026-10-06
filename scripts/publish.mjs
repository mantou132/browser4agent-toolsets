// Validates toolsets with the market's own parser; with --publish, also creates or updates them in the
// market (needs MARKET_TOKEN). Pass file paths to process only those; with none, every toolset is processed.
import { readdir, readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const API = process.env.MARKET_API || 'https://browser4agent-market.709922234.workers.dev';
const args = process.argv.slice(2);
const publish = args.includes('--publish');
const token = process.env.MARKET_TOKEN;
if (publish && !token) throw new Error('MARKET_TOKEN is required to publish');

const isToolset = (file) => /\.[cm]?[jt]s$/.test(file);
const all = (await readdir('toolsets')).filter(isToolset).sort();
const requested = args.filter((arg) => !arg.startsWith('--')).map((arg) => basename(arg));
const files = requested.length ? requested.filter((file) => all.includes(file)) : all;
let failed = false;

// The @module name is the toolset's identity in the market, and every toolset here is owned by the same
// token, so a duplicate name would silently overwrite another toolset. Check all files locally.
const owners = new Map();
for (const file of all) {
  const name = (await readFile(`toolsets/${file}`, 'utf8')).match(/@module\s+(.+)/)?.[1].trim();
  if (owners.has(name)) {
    console.error(`✗ ${file}: toolset name "${name}" is already used by ${owners.get(name)}`);
    failed = true;
  }
  owners.set(name, file);
}

for (const file of files) {
  const content = await readFile(`toolsets/${file}`, 'utf8');
  const res = await fetch(`${API}/api/toolsets/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, filename: file }),
  });
  const toolset = await res.json();
  if (!res.ok) {
    console.error(`✗ ${file}: ${toolset.error}`);
    failed = true;
    continue;
  }
  console.log(`✓ ${file}: ${toolset.name} (${toolset.tools.map((tool) => tool.name).join(', ')})`);
  if (!publish || failed) continue;

  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const body = JSON.stringify(toolset);
  let write = await fetch(`${API}/api/toolsets/${encodeURIComponent(toolset.name)}`, { method: 'PUT', headers, body });
  const created = write.status === 404;
  if (created) write = await fetch(`${API}/api/toolsets`, { method: 'POST', headers, body });
  if (write.ok) {
    console.log(`  ${created ? 'created' : 'updated'} in the market`);
  } else {
    console.error(`  ✗ publish failed: ${write.status} ${(await write.json()).error}`);
    failed = true;
  }
}

if (!files.length) console.log('No changed toolsets.');
if (failed) process.exit(1);
