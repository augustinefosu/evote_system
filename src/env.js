// Minimal .env loader (no dependency). Must be required before anything that
// reads process.env. Real environment variables always win, so CI or hosting
// environments override the file rather than being overwritten by it.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const file = ['.env.local', '.env']
  .map((name) => path.join(ROOT, name))
  .find((candidate) => fs.existsSync(candidate));

if (file) {
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
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // A malformed .env must not prevent the process from starting; production
    // guards in server.js still fail loudly on genuinely missing secrets.
  }
}

module.exports = { envFile: file || null, projectRoot: ROOT };