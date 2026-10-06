// Validates every toolset in toolsets/ with the market's own parser.
// With --publish, also creates or updates each toolset in the market (needs MARKET_TOKEN).
import { readdir, readFile } from 'node:fs/promises';

const API = process.env.MARKET_API || 'https://browser4agent-market.709922234.workers.dev';
const publish = process.argv.includes('--publish');
const token = process.env.MARKET_TOKEN;
if (publish && !token) throw new Error('MARKET_TOKEN is required to publish');

const files = (await readdir('toolsets')).filter((file) => /\.[cm]?[jt]s$/.test(file)).sort();
const owners = new Map();
let failed = false;

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
  // The @module name is the toolset's identity in the market.
  if (owners.has(toolset.name)) {
    console.error(`✗ ${file}: toolset name "${toolset.name}" is already used by ${owners.get(toolset.name)}`);
    failed = true;
    continue;
  }
  owners.set(toolset.name, file);
  console.log(`✓ ${file}: ${toolset.name} (${toolset.tools.map((tool) => tool.name).join(', ')})`);
  if (!publish) continue;

  const url = `${API}/api/toolsets/${encodeURIComponent(toolset.name)}`;
  const exists = (await fetch(url)).ok;
  const write = await fetch(exists ? url : `${API}/api/toolsets`, {
    method: exists ? 'PUT' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(toolset),
  });
  if (write.ok) {
    console.log(`  ${exists ? 'updated' : 'created'} in the market`);
  } else {
    console.error(`  ✗ publish failed: ${write.status} ${(await write.json()).error}`);
    failed = true;
  }
}

if (failed) process.exit(1);
