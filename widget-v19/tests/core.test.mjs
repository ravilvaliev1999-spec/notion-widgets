import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'Core.js'), 'utf8');
const context = vm.createContext({ Object, String, RegExp, Error, encodeURIComponent, decodeURIComponent });
vm.runInContext(source, context, { filename: 'Core.js' });
const core = context.WidgetV19Core;

test('normalizes and validates Notion page ids', () => {
  assert.equal(core.normalizeUuid('3822d62739a1807a966df43585d75212'), '3822d627-39a1-807a-966d-f43585d75212');
  assert.equal(core.normalizeUuid('not-a-page'), null);
});

test('upload MIME cleanup cannot request implicit Google Workspace conversion', () => {
  assert.equal(core.cleanMime('application/vnd.google-apps.document'), 'application/octet-stream');
  assert.equal(core.cleanMime('application/pdf'), 'application/pdf');
});

test('normalizes external URLs without destroying functional parameters', () => {
  assert.equal(
    core.normalizeExternalUrl('https://Example.com:443/a/?b=2&utm_source=x&a=1#part'),
    'https://example.com/a?a=1&b=2#part'
  );
  assert.equal(core.normalizeExternalUrl('https://github.com/org/repo/blob/main/file.js#L10-L20'), 'https://github.com/org/repo/blob/main/file.js#L10-L20');
  assert.equal(core.normalizeExternalUrl('http://example.com'), null);
});

test('classifies Google and Office formats into four fixed sections', () => {
  assert.equal(core.classify({ url: 'https://docs.google.com/document/d/abc123456789/edit', isLink: true }).section, 'Docs');
  assert.deepEqual(
    JSON.parse(JSON.stringify(core.classify({ url: 'https://evil.example/docs.google.com/document/d/abc123456789', isLink: true }))),
    { section: 'Drive', format: 'Link', provider: 'External URL', knowledgeFormat: 'Ссылка' }
  );
  assert.equal(core.classify({ name: 'budget.xlsx', mimeType: 'application/octet-stream' }).section, 'Sheets');
  assert.equal(core.classify({ name: 'pitch.pptx' }).section, 'Slides');
  assert.deepEqual(
    JSON.parse(JSON.stringify(core.classify({ url: 'https://example.com/article', isLink: true }))),
    { section: 'Drive', format: 'Link', provider: 'External URL', knowledgeFormat: 'Ссылка' }
  );
});

test('extracts Google file ids only from Google Drive and Docs hosts', () => {
  assert.equal(core.extractGoogleFileId('https://docs.google.com/document/d/ABCDEFGHIJKL/edit?usp=sharing'), 'ABCDEFGHIJKL');
  assert.equal(core.extractGoogleFileId('https://drive.google.com/open?id=ABCDEFGHIJKL'), 'ABCDEFGHIJKL');
  assert.equal(core.extractGoogleFileId('https://drive.google.com/drive/folders/ABCDEFGHIJKL?usp=sharing'), 'ABCDEFGHIJKL');
  assert.equal(core.extractGoogleFileId('https://example.com/?id=ABCDEFGHIJKL'), null);
  assert.equal(core.extractGoogleFileId('https://example.com/#/d/ABCDEFGHIJKL'), null);
});

test('creates stable edit and download URLs from file ids', () => {
  assert.match(core.makeDriveOpenUrl('abc123', 'Google Sheets'), /spreadsheets\/d\/abc123\/edit$/);
  assert.match(core.makeDownloadUrl('abc123'), /export=download&id=abc123$/);
});
