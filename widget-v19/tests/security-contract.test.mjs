import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('new runtime files contain no hard-coded deployment URL or credential-shaped assignment', () => {
  const runtime = ['Index.html', 'Code.gs', 'Core.js'].map(text).join('\n');
  assert.doesNotMatch(runtime, /script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+/);
  assert.doesNotMatch(runtime, /(?:NOTION_TOKEN|SECRET|REFRESH_TOKEN)\s*=\s*['\"][^'\"]+['\"]/i);
  assert.doesNotMatch(runtime, /Bearer\s+[A-Za-z0-9._-]{16,}/i);
});

test('frontend has no browser persistence as source of truth', () => {
  const frontend = text('Index.html');
  assert.doesNotMatch(frontend, /localStorage|indexedDB|sessionStorage/);
  assert.match(frontend, /apiBootstrap/);
});

test('mock mode is limited to local preview and the published canary host', () => {
  const frontend = text('Index.html');
  assert.match(frontend, /ravilvaliev1999-spec\.github\.io/);
  assert.match(frontend, /mockRequested\s*=\s*requestedMock\s*&&\s*\(isLocal\s*\|\|\s*isPublishedCanary\)/);
});

test('backend is fail-closed on identity, data source and task ownership', () => {
  const backend = text('Code.gs');
  assert.match(backend, /w19AssertViewer_/);
  assert.match(backend, /w19AssertAllowedDataSource_/);
  assert.match(backend, /w19AssertTaskPage_/);
  assert.match(backend, /w19AssertMaterialForTask_/);
  assert.match(backend, /w19WithIdempotency_/);
});

test('physical deletion is limited to files created by widget v19 for the task', () => {
  const backend = text('Code.gs');
  assert.match(backend, /DELETE_NOT_OWNED_BY_WIDGET/);
  assert.match(backend, /driveProps\.widgetVersion\s*!==\s*'v19'/);
  assert.match(backend, /driveProps\.taskPageId\s*!==\s*WidgetV19Core\.compactUuid\(task\.id\)/);
});

test('backend and inline frontend scripts are syntactically valid JavaScript', () => {
  assert.doesNotThrow(() => new Function(text('Code.gs')));
  assert.doesNotThrow(() => new Function(text('Core.js')));
  const html = text('Index.html');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(scripts.length > 0);
  scripts.forEach((script) => assert.doesNotThrow(() => new Function(script)));
});
