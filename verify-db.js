#!/usr/bin/env node
'use strict';
// Usage: node scripts/verify-db.js [--dir /var/data]
const path = require('node:path');
const { openStore } = require('../lib/store');
const args = process.argv.slice(2);
const dir = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : (process.env.LINK_DATA_DIR || path.join(__dirname, '..', 'data'));
const store = openStore({ dataDir: dir });
try { console.log(JSON.stringify({ verify: store.verify(), stats: store.stats() }, null, 2)); } finally { store.close(); }
