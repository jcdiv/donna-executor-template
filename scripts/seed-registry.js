#!/usr/bin/env node
/**
 * Seed registry entries from a JSON file into the deployed worker.
 *
 * Usage:
 *   node scripts/seed-registry.js --url https://your-worker.workers.dev --token YOUR_ADMIN_TOKEN --file examples/registry-entries.json
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let url, token, file;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--url') url = args[++i];
  else if (args[i] === '--token') token = args[++i];
  else if (args[i] === '--file') file = args[++i];
  else if (args[i] === '--help') {
    console.log(`Usage: node seed-registry.js --url <WORKER_URL> --token <ADMIN_TOKEN> --file <JSON_FILE>`);
    console.log(`\nImports registry entries from a JSON file into your deployed executor.`);
    console.log(`\nOptions:`);
    console.log(`  --url    Worker URL (e.g., https://donna-executor.you.workers.dev)`);
    console.log(`  --token  ADMIN_TOKEN for authentication`);
    console.log(`  --file   Path to JSON file with registry entries array`);
    process.exit(0);
  }
}

if (!url || !token || !file) {
  console.error('Error: --url, --token, and --file are all required');
  console.error('Run with --help for usage');
  process.exit(1);
}

const filePath = path.resolve(file);
if (!fs.existsSync(filePath)) {
  console.error(`Error: File not found: ${filePath}`);
  process.exit(1);
}

const entries = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
if (!Array.isArray(entries)) {
  console.error('Error: JSON file must contain an array of registry entries');
  process.exit(1);
}

console.log(`Importing ${entries.length} registry entries to ${url}...`);

fetch(`${url.replace(/\/$/, '')}/registry/import`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({ entries })
})
  .then(async (resp) => {
    const data = await resp.json();
    if (resp.ok) {
      console.log(`Done: ${data.imported} of ${data.total} entries imported`);
    } else {
      console.error(`Error ${resp.status}: ${data.error || JSON.stringify(data)}`);
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error(`Request failed: ${err.message}`);
    process.exit(1);
  });
