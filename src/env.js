// Minimal .env loader (no dependency). Must be required before anything that
// reads process.env. Real environment variables always win, so CI or hosting
// environments override the file rather than being overwritten by it.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Load order matters. .env provides the base configuration and never overrides
// a real environment variable, so hosting environments win. .env.local is then
// layered on top and DOES override, which is the point of a local override
// file. Loading only the first file that exists — an earlier bug here — meant a
// leftover .env.local silently hid every value in .env.
const FILES = [
  { name: '.env', override: false },
  { name: '.env.local', override: true },
];

let loadedFile = null;

for (const { name, override } of FILES) {
  const file = path.join(ROOT, name);
  if (!fs.existsSync(file)) continue;
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const eq = trimmed.indexOf('=');
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      // Strip surrounding quotes. Connection strings and service role keys
      // routinely contain characters a .env parser would otherwise choke on.
      if (value.length >= 2) {
        const first = value[0];
        if ((first === '"' || first === "'") && value.endsWith(first)) {
          value = value.slice(1, -1);
        }
      }
      if (override || !(key in process.env)) {
        process.env[key] = value;
        if (!loadedFile) loadedFile = file;
      }
    }
  } catch {
    // A malformed .env must not prevent the process from starting; production
    // guards in server.js still fail loudly on genuinely missing secrets.
  }
}

module.exports = { envFile: loadedFile, projectRoot: ROOT };