#!/usr/bin/env node
'use strict';
// Usage: node scripts/migrate-legacy.js [--dry-run] [--dir /var/data]
// Imports <dir>/rooms.json into <dir>/link.db. Never modifies rooms.json. Safe to re-run.
const path = require('node:path');
const { openStore } = require('../lib/store');
const args = process.argv.slice(2);
const dir = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : (process.env.LINK_DATA_DIR || path.join(__dirname, '..', 'data'));
const dry = args.includes('--dry-run');
const store = openStore({ dataDir: dir });
try {
  const before = store.verify();
  const r = store.importLegacy(path.join(dir, 'rooms.json'), { dryRun: dry });
  const after = store.verify();
  console.log(JSON.stringify({ dir, dryRun: dry, before, report: r, after }, null, 2));
} finally { store.close(); }
