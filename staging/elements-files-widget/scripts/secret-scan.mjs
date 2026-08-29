import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const textExtensions = new Set(['.js', '.mjs', '.json', '.md', '.html', '.css', '.example']);
const blocked = [
  { name: 'Google OAuth refresh token', pattern: /1\/\/[A-Za-z0-9_-]{20,}/ },
  { name: 'private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'Notion integration token', pattern: /\b(?:secret|ntn)_[A-Za-z0-9_-]{20,}\b/ },
  { name: 'live Apps Script endpoint', pattern: /script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec/ },
  { name: 'legacy browser shared key', pattern: /\b(?:WIDGET_KEY|SECRET)\s*=\s*['"][^'"]{12,}/ }
];

async function files(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const target = join(path, entry.name);
    if (entry.isDirectory()) result.push(...await files(target));
    else if (textExtensions.has(extname(entry.name)) || entry.name === 'Dockerfile') result.push(target);
  }
  return result;
}

const findings = [];
for (const path of await files(root)) {
  const text = await readFile(path, 'utf8');
  for (const rule of blocked) {
    if (rule.pattern.test(text)) findings.push({ file: relative(root, path), rule: rule.name });
  }
}
if (findings.length) {
  console.error(JSON.stringify({ ok: false, findings }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, scannedRoot: root }));
}
