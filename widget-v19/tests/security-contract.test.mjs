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

test('new staging runtime creates no visible TEST-labelled objects', () => {
  const runtime = ['Index.html', 'Code.gs'].map(text).join('\n');
  assert.doesNotMatch(runtime, />\s*TEST(?:\s|<)/i);
  assert.doesNotMatch(runtime, /Notion Widget v19\s*[—-]\s*TEST/i);
});

test('backend is fail-closed on identity, data source and task ownership', () => {
  const backend = text('Code.gs');
  assert.match(backend, /w19AssertViewer_/);
  assert.match(backend, /w19AssertAllowedDataSource_/);
  assert.match(backend, /w19AssertTaskPage_/);
  assert.match(backend, /w19AssertMaterialForTask_/);
  assert.match(backend, /w19WithIdempotency_/);
});

test('schema preflight covers every context property written on material creation', () => {
  const backend = text('Code.gs');
  assert.match(backend, /'\[SYS\] Context path':\s*'rich_text'/);
  assert.match(backend, /'\[SYS\] Ancestor IDs':\s*'rich_text'/);
  assert.match(backend, /'\[SYS\] Глубина':\s*'number'/);
  assert.match(backend, /'\[SYS\] Контекст: Сфера':\s*'relation'/);
  assert.match(backend, /'\[SYS\] Контекст: Направление':\s*'relation'/);
  assert.match(backend, /'\[SYS\] Контекст: Проект':\s*'relation'/);
  assert.match(backend, /'\[SYS\] Контекст обновлён':\s*'date'/);
});

test('physical deletion is limited to files created by widget v19 for the task', () => {
  const backend = text('Code.gs');
  assert.match(backend, /DELETE_NOT_OWNED_BY_WIDGET/);
  assert.match(backend, /driveProps\.widgetVersion\s*!==\s*'v19'/);
  assert.match(backend, /driveProps\.taskPageId\s*!==\s*WidgetV19Core\.compactUuid\(task\.id\)/);
});

test('binary uploads cannot request Google-native conversion MIME types', () => {
  const core = text('Core.js');
  assert.match(core, /\^application\\\/vnd\\\.google-apps\\\./);
  assert.match(core, /return 'application\/octet-stream'/);
});

test('physical deletion is replayable after a partial Drive or Notion failure', () => {
  const backend = text('Code.gs');
  const body = backend.slice(backend.indexOf('function apiDeletePhysical'), backend.indexOf('function apiSyncTask'));
  assert.ok(body.indexOf('w19WithIdempotency_') < body.indexOf('w19AssertMaterialForTask_'));
  assert.ok(body.indexOf("w19Select_('deleting')") < body.indexOf('Drive.Files.delete'));
  assert.match(body, /w19StableIdempotency_/);
  assert.match(body, /w19WithMutationLock_/);
  assert.match(body, /w19IsDriveNotFound_/);
  assert.match(body, /material\.syncStatus\s*===\s*'deleted'/);
});

test('Drive not-found survives retry wrapping and returns null to replay logic', () => {
  const backend = text('Code.gs');
  assert.match(backend, /function w19IsDriveNotFound_[\s\S]*err\.details\s*&&\s*err\.details\.reason/);
  assert.match(backend, /DRIVE_NOT_FOUND/);
  assert.match(backend, /if \(w19IsDriveNotFound_\(err\)\) return null/);
});

test('stale idempotency attempts cannot downgrade a newer pending or done entry', () => {
  const backend = text('Code.gs');
  assert.match(backend, /attemptId\s*=\s*Utilities\.getUuid\(\)/);
  assert.match(backend, /currentFailed\.status\s*===\s*'pending'\s*&&\s*currentFailed\.attemptId\s*===\s*attemptId/);
  assert.match(backend, /currentDone\.status\s*===\s*'pending'\s*&&\s*currentDone\.attemptId\s*===\s*attemptId/);
});

test('task-folder creation and material creation are serialized with position assignment', () => {
  const backend = text('Code.gs');
  const bootstrapBody = backend.slice(backend.indexOf('function apiBootstrap'), backend.indexOf('function apiCreateGoogle'));
  const createBody = backend.slice(backend.indexOf('function apiCreateGoogle'), backend.indexOf('function apiAddLink'));
  const uploadBody = backend.slice(backend.indexOf('function apiUpload'), backend.indexOf('function apiUpdateMaterial'));
  assert.ok(bootstrapBody.indexOf('w19WithMutationLock_') < bootstrapBody.indexOf('w19EnsureTaskFolder_'));
  assert.ok(createBody.indexOf('w19WithMutationLock_') < createBody.indexOf('w19EnsureTaskFolder_'));
  assert.ok(createBody.indexOf('w19WithMutationLock_') < createBody.indexOf('w19NextPosition_'));
  assert.ok(uploadBody.indexOf('w19WithMutationLock_') < uploadBody.indexOf('w19EnsureTaskFolder_'));
  assert.ok(uploadBody.indexOf('w19WithMutationLock_') < uploadBody.indexOf('w19NextPosition_'));
});

test('scheduled sync uses a run lease and a stable pagination sort', () => {
  const backend = text('Code.gs');
  const body = backend.slice(backend.indexOf('function scheduledSync'), backend.indexOf('function w19AuthorizedConfig_'));
  assert.match(body, /w19ClaimScheduledSync_/);
  assert.match(body, /w19FinishScheduledSync_/);
  assert.match(body, /timestamp:\s*'created_time'/);
  assert.doesNotMatch(body, /timestamp:\s*'last_edited_time'/);
  assert.match(body, /current\.token\s*!==\s*token/);
});

test('sync and delete share the mutation lock and sync refreshes its page snapshot', () => {
  const backend = text('Code.gs');
  const body = backend.slice(backend.indexOf('function w19SyncOnePage_'), backend.indexOf('function w19MarkSyncError_'));
  assert.match(body, /w19WithMutationLock_/);
  assert.match(body, /\/v1\/pages\//);
});

test('update and reorder refresh materials under the shared mutation lock', () => {
  const backend = text('Code.gs');
  const updateBody = backend.slice(backend.indexOf('function apiUpdateMaterial'), backend.indexOf('function apiReorder'));
  const reorderBody = backend.slice(backend.indexOf('function apiReorder'), backend.indexOf('function apiArchive'));
  assert.ok(updateBody.indexOf('w19WithMutationLock_') < updateBody.indexOf('w19AssertMaterialForTask_'));
  assert.match(updateBody, /current\.syncStatus\s*===\s*'deleting'/);
  assert.ok(reorderBody.indexOf('w19WithMutationLock_') < reorderBody.indexOf('w19AssertMaterialForTask_'));
  assert.match(reorderBody, /current\.syncStatus\s*===\s*'deleting'/);
});

test('external URL updates atomically reclassify metadata and reject collisions', () => {
  const backend = text('Code.gs');
  const body = backend.slice(backend.indexOf('function apiUpdateMaterial'), backend.indexOf('function apiReorder'));
  assert.match(body, /WidgetV19Core\.classify\(\{ url: url, isLink: true \}\)/);
  assert.match(body, /WidgetV19Core\.extractGoogleFileId\(url\)/);
  assert.match(body, /w19FindMaterialCollision_/);
  assert.match(body, /W19_P\.GOOGLE_FILE_ID/);
  assert.match(body, /W19_P\.PROVIDER/);
  assert.match(body, /W19_P\.FILE_FORMAT/);
  assert.match(body, /W19_P\.KNOWLEDGE_FORMAT/);
  assert.match(body, /DUPLICATE_MATERIAL/);
});

test('archive and restore cannot overwrite or revive deleting and deleted materials', () => {
  const backend = text('Code.gs');
  const body = backend.slice(backend.indexOf('function w19SetArchiveState_'), backend.indexOf('function w19Audit_'));
  assert.ok(body.indexOf('w19WithMutationLock_') < body.indexOf('w19AssertMaterialForTask_'));
  assert.match(body, /material\.syncStatus\s*===\s*'deleting'/);
  assert.match(body, /material\.syncStatus\s*===\s*'deleted'/);
  assert.match(body, /if \(!archived\) throw new W19Error_\('MATERIAL_DELETED'/);
  assert.match(body, /if \(!archived\) props\[W19_P\.POSITION\]/);
});

test('Google links dedupe by file id under a serialized mutation lock', () => {
  const backend = text('Code.gs');
  const body = backend.slice(backend.indexOf('function apiAddLink'), backend.indexOf('function apiUpload'));
  assert.match(body, /w19WithMutationLock_/);
  assert.match(body, /w19FindMaterialByGoogleFile_\(task\.id,\s*googleFileId/);
  assert.match(body, /existingMaterial\.archived/);
  assert.match(body, /restored:\s*true/);
  assert.match(body, /existingMaterial\.syncStatus\s*===\s*'deleted'/);
  assert.match(body, /restoreProps\[W19_P\.POSITION\]/);
});

test('hosted mock exposes owned files and classifies Google links like backend', () => {
  const frontend = text('Index.html');
  assert.match(frontend, /widgetOwned:true/);
  assert.match(frontend, /mockNormalizeUrl\(payload\.url\)/);
  assert.match(frontend, /mockLinkMeta\(normalized,payload\.section\)/);
  assert.match(frontend, /host!==['"]drive\.google\.com['"]&&host!==['"]docs\.google\.com['"]/);
  assert.ok(frontend.includes("host==='docs.google.com'&&/\\/document\\//"));
  assert.match(frontend, /\\\/folders\\\/\(\[a-zA-Z0-9_-\]\{10,\}\)/);
  assert.match(frontend, /folderUrl:['"]https:\/\/drive\.google\.com\/drive\/folders\/mockfolder123['"]/);
  assert.match(frontend, /apiUpdateMaterial[\s\S]*mockLinkMeta\(normalized,payload\.section\)/);
  assert.match(frontend, /apiUpdateMaterial[\s\S]*DUPLICATE_MATERIAL/);
  const mockUpdate = frontend.slice(frontend.indexOf("if (method==='apiUpdateMaterial')"), frontend.indexOf("if (method==='apiReorder')"));
  assert.ok(mockUpdate.indexOf('DUPLICATE_MATERIAL') < mockUpdate.lastIndexOf('Object.assign(item,candidate)'));
  assert.match(frontend, /apiAddLink[\s\S]*restored:true/);
  assert.match(frontend, /apiDeletePhysical[\s\S]*syncStatus='deleted'/);
  assert.match(frontend, /function mockNextPosition\(items,section\)/);
  assert.match(frontend, /position:mockNextPosition\(items,meta\.section\)/);
  assert.match(frontend, /DELETE_NOT_OWNED_BY_WIDGET/);
});

test('rapid reorder gestures are single-flight and coalesce to the latest snapshot', () => {
  const frontend = text('Index.html');
  const body = frontend.slice(frontend.indexOf('function captureOrder'), frontend.indexOf('function handleGridClick'));
  assert.match(body, /queuedOrder=captureOrder\(\)/);
  assert.match(body, /if\(orderSaveRunning\)return/);
  assert.match(body, /while\(queuedOrder\)/);
  assert.ok(body.indexOf('queuedOrder=null') < body.indexOf("await call('apiReorder'"));
  assert.match(body, /finally\{orderSaveRunning=false;if\(queuedOrder\)persistOrder\(\)/);
});

test('backend and inline frontend scripts are syntactically valid JavaScript', () => {
  assert.doesNotThrow(() => new Function(text('Code.gs')));
  assert.doesNotThrow(() => new Function(text('Core.js')));
  const html = text('Index.html');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(scripts.length > 0);
  scripts.forEach((script) => assert.doesNotThrow(() => new Function(script)));
});
