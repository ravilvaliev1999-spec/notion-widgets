import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('new runtime files contain no hard-coded deployment URL or credential-shaped assignment', () => {
  const runtime = ['Index.html', 'Download.html', 'Code.gs', 'Core.js', 'Registry.gs'].map(text).join('\n');
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

test('create POST accepts only the four courier fields and never echoes its capability into the response template', () => {
  const backend = text('Code.gs');
  const fields = backend.slice(backend.indexOf('function w20CreatePostFields_'), backend.indexOf('function w20SafeCreateOpenUrl_'));
  const post = backend.slice(backend.indexOf('function doPost'), backend.indexOf('/* ========================= Public client API'));
  assert.match(fields, /\['task', 'accessToken', 'createSection', 'createRequestId'\]/);
  assert.match(fields, /keys\.length === expected\.length/);
  assert.match(fields, /list\.length !== 1/);
  assert.match(fields, /application\/x-www-form-urlencoded/);
  assert.match(fields, /!String\(event && event\.queryString \|\| ''\)/);
  assert.match(post, /apiCreateGoogle\(\{/);
  assert.match(post, /template\.runtimeParamsJson = '\{\}'/);
  assert.match(post, /template\.precomputedResultJson = JSON\.stringify\(result\)/);
  assert.doesNotMatch(post, /runtimeParamsJson\s*=\s*JSON\.stringify\([^;]*accessToken/);
});

test('create GET rendezvous is noopener, exact-field and status-only', () => {
  const courier=fs.readFileSync(path.join(root,'..','create-courier.html'),'utf8');
  const creator=text('Create.html');
  const backend=text('Code.gs');
  assert.match(courier,/\^#v2=\(\[A-Za-z0-9_-\]\{80,6000\}\)\$/);
  assert.match(courier,/allowed=new Set\(\['task','accessToken','createSection','createRequestId'\]\)/);
  assert.match(courier,/entries\.length!==4/);
  assert.match(courier,/if\(mode==='v2'\)runner\.src=request\.href;else submitCreate\(request\)/);
  assert.ok(courier.indexOf("history.replaceState(null,'',location.pathname)") < courier.indexOf("runner.src=request.href"));
  assert.doesNotMatch(courier,/BroadcastChannel|window\.open\(/);
  assert.match(creator,/expected=\['accessToken','createRequestId','createSection','task'\]/);
  assert.match(creator,/apiGetCreateStatus\(input\)/);
  assert.match(creator,/state==='drive_ready'/);
  assert.doesNotMatch(creator,/\.apiCreateGoogle\(/);
  assert.match(creator,/const statusInput=\{taskPageId,accessToken,section,createRequestId:requestId\}/);
  assert.match(creator,/if\(result\.state==='failed'\)throw new Error/);
  assert.match(creator,/for\(const delay of POLL_DELAYS\)/);
  assert.doesNotMatch(creator,/randomUUID|window\.open|BroadcastChannel|postMessage\([^\n]*(?:accessToken|idempotencyKey)/);
  const status=backend.slice(backend.indexOf('function apiGetCreateStatus'),backend.indexOf('function apiRepairCreateMarker'));
  assert.match(backend,/function w20WriteCreateDriveReady_\(canonicalKey, attemptId, driveFile, section\)/);
  assert.match(backend,/String\(current\.attemptId \|\| ''\)\.toLowerCase\(\) !== expectedAttemptId/);
  assert.match(backend,/function w20CreateDriveReadyUrl_\(ledger\)/);
  assert.match(status,/return \{ status: 'drive_ready', openUrl: driveReadyUrl \}/);
  assert.doesNotMatch(status,/canonicalKey|attemptId|driveReadyAt/);
});

test('download POST is exact-field and precomputes direct only from a supplied or freshly re-redeemed HMAC grant', () => {
  const backend=text('Code.gs');
  const fields=backend.slice(backend.indexOf('function w20DownloadPostFields_'),backend.indexOf('function w20SafeCreateOpenUrl_'));
  const prepared=backend.slice(backend.indexOf('function w20PreparedDownloadPostDirect_'),backend.indexOf('function doPost'));
  const post=backend.slice(backend.indexOf('function doPost'),backend.indexOf('/* ========================= Public client API'));
  const grant=backend.slice(backend.indexOf('function w20DownloadGrantCacheKey_'),backend.indexOf('function w19MaterialFromPage_'));
  assert.match(fields,/\['task', 'accessToken', 'downloadPageId', 'downloadTicket'\]/);
  assert.match(fields,/keys\.length === expected\.length/);
  assert.match(fields,/application\/x-www-form-urlencoded/);
  assert.match(fields,/!String\(event && event\.queryString \|\| ''\)/);
  assert.match(post,/kind === 'download'/);
  assert.match(post,/w19AuthorizedConfig_\(\{/);
  assert.match(post,/w20GetDownloadGrant_\(downloadFields\.taskPageId, downloadFields\.pageId, downloadFields\.ticket, cfg\)/);
  assert.match(post,/if \(!direct\) \{[\s\S]*apiPrepareDownload\(\{[\s\S]*taskPageId: downloadFields\.taskPageId,[\s\S]*pageId: downloadFields\.pageId,[\s\S]*accessToken: downloadFields\.accessToken/);
  assert.match(post,/direct = w20PreparedDownloadPostDirect_\(prepared, downloadFields, cfg\)/);
  assert.ok(post.indexOf('w19AuthorizedConfig_')<post.indexOf('apiPrepareDownload('),'cold preparation must stay behind capability authorization');
  assert.match(prepared,/response && response\.ok === true && response\.data/);
  assert.match(prepared,/prepared\.mode !== 'grant'/);
  assert.match(prepared,/\^\[a-f0-9\]\{96\}\$/);
  assert.match(prepared,/return w20GetDownloadGrant_\(fields\.taskPageId, fields\.pageId, grant, cfg\)/);
  assert.doesNotMatch(prepared,/directDownloadUrl|directDownloadName|directDownloadExpiresAt|downloadPackage|accessToken/);
  assert.match(post,/downloadTemplate\.runtimeParamsJson = direct \? '\{\}'/);
  assert.match(post,/downloadTemplate\.precomputedResultJson = JSON\.stringify\(direct \?/);
  const precomputed=post.slice(post.indexOf('downloadTemplate.precomputedResultJson'),post.indexOf('return downloadTemplate.evaluate'));
  assert.doesNotMatch(precomputed,/downloadGrant|downloadPackage|accessToken/);
  assert.match(precomputed,/downloadTicket: downloadFields\.ticket/);
  assert.match(grant,/W20_DOWNLOAD_GRANT_TTL_SECONDS/);
  assert.match(grant,/computeHmacSha256Signature/);
  assert.match(grant,/entry\.taskId === WidgetV19Core\.compactUuid\(task\)/);
  assert.match(grant,/entry\.pageId === WidgetV19Core\.compactUuid\(page\)/);
  assert.match(grant,/entry\.epoch === currentEpoch/);
  assert.match(grant,/WidgetV19Core\.safeEqual\(expected, supplied\)/);
  assert.match(backend.slice(backend.indexOf('function w20CacheDownloadMaterials_'),backend.indexOf('function w20GetCachedDownloadMaterial_')),/w20InvalidateDownloadMaterialCache_\(taskId, pageId, false\)/);
});

test('fast packages remain limited to genuinely expiring hosted URLs and are issued only behind the epoch lock', () => {
  const backend=text('Code.gs');
  const prepare=backend.slice(backend.indexOf('function apiPrepareDownload'),backend.indexOf('function apiDownload'));
  const packageSource=backend.slice(backend.indexOf('function w20FastDownloadName_'),backend.indexOf('function w20IssueDownloadGrant_'));
  const issue=backend.slice(backend.indexOf('function w20IssueDownloadGrant_'),backend.indexOf('function w20GetDownloadGrant_'));
  const ttl=Number((backend.match(/W20_FAST_DOWNLOAD_PACKAGE_TTL_SECONDS\s*=\s*(\d+)/)||[])[1]);
  assert.ok(ttl>0&&ttl<=60);
  assert.ok(prepare.indexOf('w20GetCachedDownloadMaterial_')<prepare.indexOf('w19AssertOwnedBinary_'));
  assert.ok(prepare.indexOf('w20FastPreparedDownloadDrive_')<prepare.indexOf('w19AssertOwnedBinary_'));
  assert.ok(prepare.indexOf('w19AssertMaterialForTask_')<prepare.indexOf('w19AssertOwnedBinary_'));
  assert.ok(prepare.indexOf('w19AssertOwnedBinary_')<prepare.indexOf('w20DriveDownloadUrl_'));
  assert.ok(prepare.indexOf('w20DriveDownloadUrl_')<prepare.indexOf('w20IssueDownloadGrant_'));
  assert.match(packageSource,/var payload = \{\s*url: source\.url,\s*name: w20FastDownloadName_\(source\.name\),\s*expiresAt:/);
  assert.match(packageSource,/w20TrustedHostedDownloadUrl_\(source\.url\) !== source\.url/);
  assert.match(packageSource,/base64EncodeWebSafe/);
  assert.match(packageSource,/replace\(\/=\+\$\/g, ''\)/);
  assert.doesNotMatch(packageSource,/accessToken|script\.google\.com|serviceUrl|console|Logger/);
  const epochCheck=issue.indexOf('currentEpoch !== requestedEpoch');
  const packageReturn=issue.indexOf('w20DownloadGrantResponse_');
  assert.ok(epochCheck!==-1&&epochCheck<packageReturn,'package must be formed only after the locked epoch recheck');
  assert.match(issue,/task !== cfg\.authorizedTaskPageId/);
  assert.match(issue,/cfg\.deniedPageIds\[task\]/);
});

test('grant-protected download URLs are canonical, account-bound Drive links without a CDN probe', () => {
  const backend = text('Code.gs');
  const builder = backend.slice(backend.indexOf('function w20DriveDownloadUrl_'), backend.indexOf('function w20DownloadDispositionFilename_'));
  const prepare = backend.slice(backend.indexOf('function apiPrepareDownload'), backend.indexOf('function apiDownload'));
  assert.match(builder, /https:\/\/drive\.google\.com\/uc\?export=download&authuser=/);
  assert.match(builder, /encodeURIComponent\(account\)/);
  assert.match(builder, /encodeURIComponent\(id\)/);
  assert.match(builder, /w20DriveDownloadUrl_\(match\[2\], account\) === raw/);
  assert.doesNotMatch(prepare, /UrlFetchApp|attachmentUrl|attachmentExpiry|Content-Disposition/);
});

test('public download courier accepts Drive only after the HMAC v1 runner exchange', () => {
  const courier=fs.readFileSync(path.join(root,'..','download-courier.html'),'utf8');
  const fast=courier.slice(courier.indexOf('function validateFastPackage'),courier.indexOf('function validateDirectDownload'));
  assert.match(courier,/\^#v3=\(\[A-Za-z0-9_-\]\{40,9000\}\)\$/);
  assert.match(courier,/\^#v1=\(\[A-Za-z0-9_-\]\{80,6000\}\)\$/);
  assert.match(fast,/keys\.length!==3/);
  assert.match(fast,/keys\.includes\('url'\)/);
  assert.match(fast,/keys\.includes\('name'\)/);
  assert.match(fast,/keys\.includes\('expiresAt'\)/);
  assert.match(fast,/safeDownloadName\(payload\.name\)!==payload\.name/);
  assert.match(fast,/expiry-now>60\*1000/);
  assert.doesNotMatch(fast,/accessToken|downloadTicket|script\.google\.com|serviceUrl/);
  assert.match(courier,/allowDrive===true&&host==='drive\.google\.com'/);
  assert.match(courier,/url\.pathname==='\/uc'/);
  assert.match(courier,/entries\.length===3/);
  assert.match(courier,/url\.searchParams\.get\('authuser'\)/);
  assert.match(courier,/host==='secure\.notion-static\.com'/);
  assert.match(courier,/host==='file\.notion\.so'/);
  assert.match(courier,/prod-files-secure\\\.s3/);
  assert.match(courier,/if\(decoded\.kind==='fast'\)[\s\S]*startDirectDownload\(decoded\.direct,0,false\);\s*return;/);
  assert.match(courier,/data\.downloadTicket!==expectedTicket[\s\S]*startDirectDownload\(data,30000,true\)/);
  assert.match(courier,/form\.method='post'/);
  assert.doesNotMatch(courier,/console\.|Logger|fetch\(|XMLHttpRequest|sendBeacon/);
});

test('download acceleration caches only server-derived task material coordinates for at most two minutes', () => {
  const backend = text('Code.gs');
  const cache = backend.slice(backend.indexOf('function w20DownloadMaterialCacheKey_'), backend.indexOf('function w19AssertMaterialForTask_'));
  const ttl = Number((backend.match(/W20_DOWNLOAD_MATERIAL_CACHE_TTL_SECONDS\s*=\s*(\d+)/) || [])[1]);
  assert.ok(ttl > 0 && ttl <= 120);
  assert.match(cache, /page\.parent/);
  assert.match(cache, /W19_P\.TYPE/);
  assert.match(cache, /W19_P\.INSIDE/);
  assert.match(cache, /W19_P\.ARCHIVE/);
  assert.match(cache, /material\.widgetOwnedBinary/);
  assert.match(cache, /cfg\.deniedPageIds/);
  assert.match(cache, /dataSourceId/);
  assert.doesNotMatch(cache, /accessToken|notionToken|attachmentUrl|downloadUrl|sourceUrl/);
  const registry=text('Registry.gs');
  const fallback=registry.slice(registry.indexOf('function w20BootstrapFromRegistry_'),registry.indexOf('function w20RegistryMetaReady_'));
  assert.match(fallback,/if \(actionProof\.ready\) w20CacheDownloadRegistryMaterials_\(taskId, stored, cfg, actionProof\.trustedUntil\)/);
  const registrySeed=cache.slice(cache.indexOf('function w20CacheDownloadRegistryMaterials_'),cache.indexOf('function w20GetCachedDownloadMaterial_'));
  assert.match(registrySeed,/Math\.min\(now \+ W20_DOWNLOAD_MATERIAL_CACHE_TTL_SECONDS \* 1000, proofExpiry\)/);
  assert.match(registrySeed,/cacheTtlSeconds <= 0/);
});

test('download cache hit avoids Notion after capability authorization and always revalidates current Drive ownership', () => {
  const backend = text('Code.gs');
  const body = backend.slice(backend.indexOf('function apiDownload'), backend.indexOf('function apiSyncTask'));
  const auth = body.indexOf('w19AuthorizedConfig_');
  const grant = body.indexOf('w20GetDownloadGrant_');
  const cache = body.indexOf('w20GetCachedDownloadMaterial_');
  const miss = body.indexOf('if (!material)');
  const markers = body.indexOf('w20FindOwnedBinaryMaterialByMarkers_');
  const task = body.indexOf('w19AssertTaskPage_');
  const fallback = body.indexOf('w19AssertMaterialForTask_');
  const ownership = body.indexOf('w19AssertOwnedBinary_');
  assert.ok(auth !== -1 && auth < grant && grant < cache);
  assert.ok(cache < miss && miss < markers && markers < task);
  assert.ok(task < fallback && fallback < ownership);
  assert.match(body, /if \(!material\)/);
  assert.match(body, /var task = \{ id: taskId, name: 'Задача' \}/);
});

test('direct Drive preparation uses only an exact fresh registry proof or the full current ownership fallback', () => {
  const backend = text('Code.gs');
  const body = backend.slice(backend.indexOf('function apiPrepareDownload'), backend.indexOf('function apiDownload'));
  const registryProof = backend.slice(backend.indexOf('function w20FreshRegistryDownloadProof_'), backend.indexOf('function w20FastPreparedDownloadDrive_'));
  const fast = backend.slice(backend.indexOf('function w20FastPreparedDownloadDrive_'), backend.indexOf('function w20DownloadGrantEpochKey_'));
  assert.match(body, /w19AuthorizedConfig_\(input\)/);
  assert.match(body, /taskId !== cfg\.authorizedTaskPageId/);
  assert.match(body, /var cachedMaterial = w20GetCachedDownloadMaterial_\(taskId, materialId, cfg\)/);
  assert.match(body, /var registryProof = w20FreshRegistryDownloadProof_\(taskId, materialId, cfg\)/);
  assert.match(body, /var material = cachedMaterial \|\| \(registryProof && registryProof\.material\) \|\| null/);
  assert.match(body, /w20FastPreparedDownloadDrive_\(taskId, materialId, material, cfg, registryProof\)/);
  assert.match(body, /if \(!drive\)[\s\S]*if \(!cachedMaterial\)[\s\S]*w19AssertMaterialForTask_\(materialId, taskId, cfg\)/);
  assert.match(body, /drive = w19AssertOwnedBinary_\(material, task, cfg\)/);
  assert.match(body, /w20DriveDownloadUrl_\(drive\.id, cfg\.allowedEmail\)/);
  assert.match(body, /w20IssueDownloadGrant_\(taskId, materialId, direct, cfg, grantEpoch\)/);
  assert.match(body, /issued\.directDownloadUrl = direct\.url/);
  assert.match(body, /issued\.directDownloadExpiresAt = issued\.expiresAt/);
  assert.doesNotMatch(body, /UrlFetchApp|attachmentUrl|attachmentExpiry|Utilities\.base64Encode|DriveApp\.getFileById/);

  assert.match(registryProof, /PropertiesService\.getScriptProperties\(\)\.getProperties\(\)/);
  assert.match(registryProof, /w20RegistryReadTaskResultFromValues_\(task, null, values\)/);
  assert.match(registryProof, /w20RegistryParseTaskMeta_\(task, values\[w20RegistryMetaKey_\(task\)\]\)/);
  assert.match(registryProof, /w20RegistryActionProof_\(meta, registry, cfg\.rootFolderId\)/);
  assert.match(registryProof, /registry\.activeCount !== registryMaterials\.length/);
  assert.match(registryProof, /registry\.activeCount !== meta\.snapshotActiveCount/);
  assert.match(registryProof, /exactCount !== 1/);
  assert.doesNotMatch(registryProof, /w20RegistryReadTaskMeta_|w20RegistryReadTaskResult_\(/);

  assert.match(fast, /snapshot\.taskId !== compactTask \|\| snapshot\.pageId !== compactPage/);
  assert.match(fast, /!proof \|\| !proof\.ready/);
  assert.match(fast, /meta\.folderId !== folderId/);
  assert.match(fast, /exact\.widgetOwnedBinary !== true/);
  assert.match(fast, /exact\.googleFileId !== fileId/);
  assert.match(fast, /exact\.folderId !== folderId/);
  assert.match(fast, /w19GetDriveMetadata_\(fileId\)/);
  assert.match(fast, /drive\.id !== fileId/);
  assert.match(fast, /drive\.ownedByMe !== true/);
  assert.match(fast, /materialState !== 'active'/);
  assert.match(fast, /driveProps\.taskPageId !== compactTask/);
  assert.match(fast, /compactUuid\(driveProps\.notionPageId\) !== compactPage/);
  assert.match(fast, /driveParents\.length !== 1 \|\| driveParents\[0\] !== folderId/);
  assert.match(fast, /application\\\/vnd\\\.google-apps/);
  assert.match(fast, /size > maxSize/);
  assert.doesNotMatch(fast, /w19AssertRootFolder_|w19AssertTaskPage_|w19AssertMaterialForTask_|Drive\.Files\.list|w19NotionRequest_/);
});

test('prepared Drive download handoff is canonical, short-lived, and falls back to grant redemption when invalid', () => {
  const runner = text('Download.html');
  const validator = runner.slice(runner.indexOf('function validatedPreparedDrive'), runner.indexOf('async function startDownload'));
  const start = runner.slice(runner.indexOf('async function startDownload'), runner.indexOf('startDownload();'));
  assert.match(validator, /data\.mode!=='grant'/);
  assert.match(validator, /\^\[a-f0-9\]\{96\}\$/);
  assert.match(validator, /expiresText!==grantExpiresText/);
  assert.match(validator, /url\.hostname!=='drive\.google\.com'/);
  assert.match(validator, /url\.pathname!=='\/uc'/);
  assert.match(validator, /keys\.join\('\|'\)!=='export\|authuser\|id'/);
  assert.match(validator, /raw!==canonical/);
  assert.match(validator, /account!==account\.toLowerCase\(\)/);
  assert.match(validator, /expiry<=now\+30000\|\|expiry-now>60000/);
  assert.match(start, /validatedPreparedDrive\(prepareResponse\.data\)/);
  assert.match(start, /if\(prepared\)[\s\S]*notifyCourierDirect\(prepared\);[\s\S]*return/);
  assert.match(start, /grantedResponse=await callDownload\(Object\.assign\(\{\},input,\{downloadGrant:grant\}\)\)/);
  assert.match(start, /await callDownload\(input\)/);
  assert.doesNotMatch(start, /postMessage\([^\n]*(?:accessToken|downloadGrant|base64)/);
});

test('bootstrap and sync seed the download cache while archive, update and delete invalidate it', () => {
  const backend = text('Code.gs');
  const bootstrap = backend.slice(backend.indexOf('function apiBootstrap'), backend.indexOf('function apiCreateGoogle'));
  const sync = backend.slice(backend.indexOf('function apiSyncTask'), backend.indexOf('/* ========================= Admin-only setup'));
  const update = backend.slice(backend.indexOf('function apiUpdateMaterial'), backend.indexOf('function apiReorder'));
  const upload = backend.slice(backend.indexOf('function apiUpload'), backend.indexOf('function w20AttachmentJobKey_'));
  const remove = backend.slice(backend.indexOf('function apiDeletePhysical'), backend.indexOf('function apiDownload'));
  const archive = backend.slice(backend.indexOf('function w19SetArchiveState_'), backend.indexOf('function w19Audit_'));
  assert.match(bootstrap, /w20CacheDownloadMaterials_\(task\.id, pages, cfg\)/);
  assert.match(sync, /w20CacheDownloadMaterials_\(task\.id, pages, cfg\)/);
  assert.match(upload, /w20CacheDownloadMaterials_\(taskId, \[pageForDownloadCache\], cfg\)/);
  assert.doesNotMatch(upload, /w19AssertMaterialForTask_\(outcome\.material\.id/);
  assert.match(update, /w20InvalidateDownloadMaterialCache_\(task\.id, materialId\)/);
  assert.match(remove, /w20InvalidateDownloadMaterialCache_\(task\.id, materialId\)/);
  assert.match(archive, /w20InvalidateDownloadMaterialCache_\(task\.id, materialId\)/);
});

test('binary upload hot path uses only fresh server registry context and recovery keeps the full durable lookup', () => {
  const backend = text('Code.gs');
  const upload = backend.slice(backend.indexOf('function apiUpload'), backend.indexOf('function w20AttachmentJobKey_'));
  const schema = upload.indexOf('w19AssertSchema_(cfg);');
  const taskId = upload.indexOf('w20AssertAuthorizedTaskId_(input && input.taskPageId, cfg)');
  const idempotency = upload.indexOf('w19WithIdempotency_(idem, function (idempotencyState)');
  const claim = upload.indexOf('w20RegistryClaimCreateSlot_(taskId, section, cfg.rootFolderId)');
  const fallbackTask = upload.indexOf('w19AssertTaskPage_(taskId, cfg)');

  assert.ok(schema !== -1 && schema < taskId && taskId < idempotency && idempotency < claim);
  assert.match(upload, /recoveringAttempt\s*=\s*Boolean\(idempotencyState && idempotencyState\.recovery\)/);
  assert.match(upload, /freshAttempt\s*=\s*!recoveringAttempt/);
  assert.match(upload, /freshAttempt \? w20RegistryClaimCreateSlot_\(taskId, section, cfg\.rootFolderId\) : null/);
  assert.ok(claim < fallbackTask, 'live task GET must exist only behind the registry fallback');
  assert.match(upload, /task = w20TaskFromRegistryMeta_\(taskId, slot\.taskMeta\)/);
  assert.match(upload, /folder = \{ id: slotFolderId \}/);
  assert.match(upload, /position = slotPosition/);
  assert.match(upload, /if \(!slot\.taskMeta \|\| !slotFolderId \|\| !isFinite\(slotPosition\)/);
  assert.match(upload, /if \(recoveringAttempt\) \{\s*var existing = w19FindMaterialByIdempotency_\(task\.id, idem, cfg\)/);
  assert.match(upload, /w19EnsureTaskFolder_\(task, cfg\)/);
  assert.match(upload, /if \(recoveringAttempt\) \{\s*driveFile = w19FindDriveByIdempotency_\(task\.id, idemHash\)/);
  assert.match(upload, /if \(position === undefined\) position = w19NextPosition_\(task\.id, section, cfg\)/);
  assert.doesNotMatch(upload, /input\s*&&\s*input\.(?:folderId|position)|input\.(?:folderId|position)/);
  assert.doesNotMatch(upload, /w19EffectiveUploadLimit_\(cfg\)/);
  assert.doesNotMatch(upload, /w19CreateAndSendNotionUpload_\(bytes/);
  assert.match(upload, /attachments:\s*\[\]/);
  assert.match(upload, /w20TryEnqueueAttachmentJob_\(taskId, outcome\.material, runtimeDriveMetadata\)/);
  assert.match(upload, /w19MarkDriveNotionPage_\(driveFile, task\.id, idemHash, page\.id, 'active'\)/);
  assert.match(upload, /w20MaterialForClient_\(outcome\.material, taskId, cfg\)/);
});

test('workspace upload limit discovery remains isolated from bootstrap and task sync', () => {
  const backend = text('Code.gs');
  const bootstrap = backend.slice(backend.indexOf('function apiBootstrap'), backend.indexOf('function apiCreateGoogle'));
  const upload = backend.slice(backend.indexOf('function apiUpload'), backend.indexOf('function w20AttachmentJobKey_'));
  const sync = backend.slice(backend.indexOf('function apiSyncTask'), backend.indexOf('/* ========================= Admin-only setup'));
  const limit = backend.slice(backend.indexOf('function w19EffectiveUploadLimit_'), backend.indexOf('function w19AssertTaskPage_'));

  assert.doesNotMatch(bootstrap, /w19EffectiveUploadLimit_|\/v1\/users\/me/);
  assert.doesNotMatch(sync, /w19EffectiveUploadLimit_|\/v1\/users\/me/);
  assert.doesNotMatch(upload, /w19EffectiveUploadLimit_\(cfg\)/);
  const finalizer = backend.slice(backend.indexOf('function w20FinalizeClaimedAttachmentJob_'), backend.indexOf('function w20FinalizeAttachmentJob_'));
  assert.match(finalizer, /w19EffectiveUploadLimit_\(cfg\)/);
  assert.match(limit, /w19NotionRequest_\('get', '\/v1\/users\/me', null, cfg\)/);
  assert.match(limit, /cache\.get\(cacheKey\)/);
  assert.match(limit, /cache\.put\(cacheKey, String\(effective\), 600\)/);
});

test('hosted attachment queue is metadata-only, bounded, durable and exact-target authorized', () => {
  const backend=text('Code.gs');
  const queue=backend.slice(backend.indexOf('function w20AttachmentJobKey_'),backend.indexOf('function apiUpdateMaterial'));
  const enqueue=queue.slice(queue.indexOf('function w20EnqueueAttachmentJob_'),queue.indexOf('function w20TryEnqueueAttachmentJob_'));
  const finalize=queue.slice(queue.indexOf('function w20FinalizeClaimedAttachmentJob_'),queue.indexOf('function w20FinalizeAttachmentJob_'));
  const api=queue.slice(queue.indexOf('function apiFinalizeUploadAttachment'),queue.indexOf('function apiUpdateMaterial'));
  assert.match(backend,/W20_ATTACHMENT_JOB_MAX\s*=\s*100/);
  assert.match(backend,/W20_ATTACHMENT_JOB_LEASE_MS\s*=\s*8\s*\*\s*60\s*\*\s*1000/);
  assert.match(queue,/\['attempts', 'createdAt', 'fileId', 'folderId', 'idemHash', 'lastCode', 'leaseToken', 'leaseUntil',[\s\S]*'sentMd5', 'sentSize'/);
  assert.match(queue,/w20PruneAttachmentJobsUnlocked_\(props, all, now\)/);
  assert.match(queue,/if \(!job \|\| now - job\.createdAt > W20_ATTACHMENT_JOB_TTL_MS\)/);
  assert.match(enqueue,/notionUploadId:\s*''/);
  assert.match(enqueue,/sentMd5:\s*''/);
  assert.match(enqueue,/sentSize:\s*0/);
  assert.match(enqueue,/tryLock\(100\)/);
  assert.doesNotMatch(enqueue,/dataBase64|base64Decode|accessToken|notionToken|sourceUrl|openUrl|downloadUrl|attachmentUrl/);
  assert.doesNotMatch(queue,/attempts\s*<\s*12/);
  assert.match(api,/w19AuthorizedConfig_\(input\)/);
  assert.match(api,/w20AssertAuthorizedTaskId_\(input && input\.taskPageId, cfg\)/);
  assert.match(api,/w20EnsureAttachmentJobForPage_\(taskId, pageId, cfg\)/);
  assert.match(finalize,/w19AssertMaterialForTask_|w20AssertAttachmentJobPage_/);
  assert.match(finalize,/markers\.widgetIdem !== job\.idemHash/);
  assert.match(finalize,/sentMd5/);
  assert.match(finalize,/sentSize/);
  assert.match(finalize,/w20Md5Hex_\(bytes\) !== driveMd5/);
  assert.match(finalize,/upload\.status === 'uploaded' && !job\.sentMd5/);
  assert.match(finalize,/w20WriteClaimedAttachmentJob_\(claimed, \{ notionUploadId: upload\.id \}\)/);
  assert.match(finalize,/w19WithMutationLock_\(function \(\) \{[\s\S]*w19AssertOwnedBinary_[\s\S]*w20AttachmentClaimIsCurrent_[\s\S]*w19UpdateNotionPage_/);
  assert.ok(finalize.indexOf('DriveApp.getFileById')<finalize.indexOf('w19WithMutationLock_'), 'Drive blob I/O must finish before the final mutation fence');
  assert.ok(finalize.indexOf('w20SendNotionUploadBlob_')<finalize.indexOf('w19WithMutationLock_'), 'Notion byte SEND must finish before the final mutation fence');
});

test('attachment jobs are canceled by archive/delete, restored conditionally and drained with a bounded repair sweep', () => {
  const backend=text('Code.gs');
  const archive=backend.slice(backend.indexOf('function w19SetArchiveState_'),backend.indexOf('function w19Audit_'));
  const remove=backend.slice(backend.indexOf('function apiDeletePhysical'),backend.indexOf('function apiPrepareDownload'));
  const scheduled=backend.slice(backend.indexOf('function scheduledSync'),backend.indexOf('function w19ClaimScheduledSync_'));
  const installer=backend.slice(backend.indexOf('function adminInstallSyncTrigger'),backend.indexOf('function scheduledSync'));
  const frontend=text('Index.html');
  assert.match(archive,/w20CancelAttachmentJob_\(task\.id, materialId\)/);
  assert.match(archive,/updatedRawMaterial\.widgetOwnedBinary && !updatedRawMaterial\.hostedAttachment/);
  assert.match(archive,/w20TryEnqueueAttachmentJob_\(task\.id, updatedRawMaterial, null\)/);
  assert.match(remove,/w20CancelAttachmentJob_\(task\.id, materialId\)/);
  assert.match(scheduled,/w20SweepMissingAttachmentJobs_\(syncedPages, cfg, W20_ATTACHMENT_JOB_DRAIN_LIMIT\)/);
  assert.match(scheduled,/w20DrainAttachmentJobs_\(cfg, 1\)/);
  assert.match(installer,/newTrigger\('scheduledFinalizeUploads'\)\.timeBased\(\)\.everyMinutes\(1\)\.create\(\)/);
  assert.match(frontend,/call\('apiFinalizeUploadAttachment',\{taskPageId,pageId:data\.material\.id\}\)\.catch\(\(\)=>\{\}\)/);
});

test('archiving revokes stale download couriers through the private Drive marker', () => {
  const backend = text('Code.gs');
  const archive = backend.slice(backend.indexOf('function w19SetArchiveState_'), backend.indexOf('function w19Audit_'));
  const markerFallback = backend.slice(backend.indexOf('function w20FindOwnedBinaryMaterialByMarkers_'), backend.indexOf('function w19AssertOwnedBinary_'));
  const ownershipGuard = backend.slice(backend.indexOf('function w19AssertOwnedBinary_'), backend.indexOf('function w19IsDriveNotFound_'));
  const revoke = archive.indexOf("w20SetDriveMaterialState_(material, task.id, 'archived')");
  const notionWrite = archive.indexOf('var updated = w19UpdateNotionPage_');
  const restore = archive.indexOf("w20SetDriveMaterialState_(updatedRawMaterial, task.id, 'active')");
  assert.ok(revoke !== -1 && revoke < notionWrite, 'archive must revoke Drive before the Notion PATCH');
  assert.ok(restore > notionWrite, 'restore must not reactivate Drive before the Notion PATCH succeeds');
  assert.match(markerFallback, /w20IsDriveMaterialActive_\(driveProps\)/);
  assert.match(ownershipGuard, /w20IsDriveMaterialActive_\(driveProps\)/);
});

test('Notion API attempts are globally paced and never hold the rate lock across UrlFetch', () => {
  const backend = text('Code.gs');
  const helper = backend.slice(backend.indexOf('function w19ReserveNotionRequestSlot_'), backend.indexOf('function w19NotionRequest_'));
  const request = backend.slice(backend.indexOf('function w19NotionRequest_'), backend.indexOf('function w19CreateAndSendNotionUpload_'));
  assert.match(backend, /W19_NOTION_RATE_INTERVAL_MS\s*=\s*350/);
  assert.match(helper, /LockService\.getScriptLock\(\)/);
  assert.match(helper, /CacheService\.getScriptCache\(\)/);
  assert.match(helper, /lock\.tryLock\(W19_NOTION_RATE_LOCK_WAIT_MS\)/);
  assert.match(helper, /NOTION_RATE_LIMIT_BUSY[\s\S]*true/);
  assert.match(helper, /reservedAt\s*=\s*previousAt\s*\?\s*Math\.max\(now,\s*previousAt\s*\+\s*W19_NOTION_RATE_INTERVAL_MS\)\s*:\s*now/);
  assert.match(helper, /waitMs\s*=\s*Math\.max\(0,\s*reservedAt\s*-\s*now\)/);
  assert.match(helper, /Utilities\.sleep\(waitMs\)/);
  assert.match(helper, /finally\s*\{\s*lock\.releaseLock\(\);\s*\}/);
  assert.ok(helper.indexOf('lock.releaseLock();') < helper.indexOf('Utilities.sleep(waitMs)'),'rate pacing sleeps only after releasing the shared ledger lock');
  assert.doesNotMatch(helper, /UrlFetchApp|notionToken|Logger|console/);
  assert.ok(request.indexOf('w19ReserveNotionRequestSlot_();') < request.indexOf('UrlFetchApp.fetch(url, options)'));
});

test('fast title polling uses short-lived signed server claims and skips Notion when Drive is unchanged', () => {
  const backend = text('Code.gs');
  const claims = backend.slice(backend.indexOf('function w20DrivePollBaseline_'), backend.indexOf('function w19AssertAllowedDataSource_'));
  const poll = backend.slice(backend.indexOf('function apiPollDriveMetadata'), backend.indexOf('function apiSyncTask'));
  assert.match(backend, /W20_DRIVE_POLL_CLAIM_TTL_SECONDS\s*=\s*60/);
  assert.match(claims, /computeHmacSha256Signature/);
  assert.match(claims, /currentName/);
  assert.match(claims, /safeEqual/);
  assert.ok(poll.indexOf('w20DriveMetadataNeedsNotionWrite_') < poll.indexOf('w19UpdateNotionPage_'));
  assert.match(poll, /if \(w20DriveMetadataNeedsNotionWrite_\([\s\S]*w19UpdateNotionPage_/);
  assert.doesNotMatch(poll, /w19AssertTaskPage_|w19AssertMaterialForTask_|w19QueryTaskMaterials_/);
});

test('scheduled sync checks Drive metadata before spending a Notion page GET', () => {
  const backend = text('Code.gs');
  const sync = backend.slice(backend.indexOf('function w19SyncOnePage_'), backend.indexOf('function w19MarkSyncError_'));
  assert.ok(sync.indexOf('w20DriveMetadataNeedsNotionWrite_') < sync.indexOf("w19NotionRequest_('get'"));
  assert.match(sync, /if \(!w20DriveMetadataNeedsNotionWrite_\(snapshot, driveData\) &&\s*!w20DriveNotionMarkerNeedsRepair_\(page, snapshot, drive, cfg\)\) return page/);
  assert.match(sync, /w19WithMutationLock_\(function \(\) \{[\s\S]*w19NotionRequest_\('get'/);
  assert.match(sync, /page\.in_trash/);
  assert.match(sync, /W19_P\.TYPE/);
  assert.match(sync, /cfg && cfg\.dataSourceId/);
});

test('late create-marker repair revalidates the current material under the shared mutation lock', () => {
  const backend = text('Code.gs');
  const repair = backend.slice(backend.indexOf('function apiRepairCreateMarker'), backend.indexOf('function apiWarmCreateContext'));
  assert.match(repair, /w19WithMutationLock_\(function \(\)/);
  assert.match(repair, /w19AssertMaterialForTask_\(material\.id, taskId, cfg\)/);
  assert.match(repair, /current\.idempotency !== idem/);
  assert.match(repair, /current\.syncStatus === 'deleting'/);
  assert.ok(repair.indexOf('w19AssertMaterialForTask_') < repair.indexOf('w19GetDriveMetadata_'));
});

test('prepared Google creation is exact-file, CAS-bound and never exposes private pool state', () => {
  const backend=text('Code.gs');
  const validators=backend.slice(backend.indexOf('function w20PreparedCreateFile_'),backend.indexOf('function w20CreateReservationForClient_'));
  const clientShape=backend.slice(backend.indexOf('function w20CreateReservationForClient_'),backend.indexOf('function w20FindPreparedReservationFiles_'));
  const claim=backend.slice(backend.indexOf('function w20ClaimCreateReservation_'),backend.indexOf('function w20ResolveCreateReservation_'));
  const transition=backend.slice(backend.indexOf('function w20TransitionClaimedReservationFile_'),backend.indexOf('function w20TaskForClaimedReservation_'));
  const reservedCreate=backend.slice(backend.indexOf('function w20CreateGoogleFromReservation_'),backend.indexOf('function w20ReleaseClaimedCreateReservation_'));
  const createApi=backend.slice(backend.indexOf('function apiCreateGoogle'),backend.indexOf('function apiGetCreateStatus'));
  const ledger=backend.slice(backend.indexOf('function w19WithIdempotency_'),backend.indexOf('function w19ReadIdempotencyStatus_'));
  assert.match(validators,/file\.ownedByMe !== true/);
  assert.match(validators,/parents\.length !== 1/);
  assert.match(validators,/w20ExactCreateAppProperties_/);
  assert.match(validators,/expectedNotionPageId/);
  assert.match(clientShape,/\{ section: section, reservationId: reservationId, openUrl: openUrl \}/);
  assert.doesNotMatch(clientShape,/\b(?:fileId|canonicalHash|attemptId|preparedName|nonce|appProperties)\s*:/);
  for(const field of ['reservationId','fileId','preparedName','createRequestId','canonicalHash','attemptId','folderId','position'])assert.match(claim,new RegExp(`${field}:`));
  assert.match(claim,/ledger\.reservationRef = claimKey/);
  assert.ok(claim.indexOf('w20PreparedCreateFile_') < claim.indexOf('getScriptLock'));
  assert.match(transition,/createReservationSection: null/);
  assert.match(transition,/createReservationId: null/);
  assert.match(transition,/createReservationState: null/);
  assert.match(transition,/String\(current\.name \|\| ''\) === String\(claim\.preparedName \|\| ''\)/);
  assert.doesNotMatch(reservedCreate,/Drive\.Files\.create|w19CreateGoogleFile_/);
  assert.match(createApi,/suppliedReservationId !== requestId/);
  assert.ok(createApi.indexOf('suppliedReservationId !== requestId') < createApi.indexOf('w20RegistryFindCreateRequest_'));
  assert.match(ledger,/reservationRef = w20CreateReservationRef_/);
  assert.match(ledger,/failed\.reservationRef = failedReservationRef/);
  assert.match(backend,/fields: 'id,name,mimeType,size,md5Checksum,modifiedTime,webViewLink,webContentLink,ownedByMe,trashed,parents,appProperties'/);
  assert.match(backend,/claim\.status === 'done'/);
  assert.doesNotMatch(backend.slice(backend.indexOf('function w19PruneLedger_'),backend.indexOf('function w19Hash_')),/claim\.status === 'claimed'/);
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
  assert.ok(body.indexOf("w20SetDriveMaterialState_(material, task.id, 'deleting')") < body.indexOf("w19Select_('deleting')"));
  assert.ok(body.indexOf("w19Select_('deleting')") < body.indexOf('Drive.Files.delete'));
  assert.match(body, /w19StableIdempotency_/);
  assert.match(body, /w19WithMutationLock_/);
  assert.match(body, /w19IsDriveNotFound_/);
  assert.match(body, /material\.syncStatus\s*===\s*'deleted'/);
});

test('idempotency marker repair preserves terminal Drive material states', () => {
  const backend = text('Code.gs');
  const marker = backend.slice(backend.indexOf('function w19MarkDriveNotionPage_'), backend.indexOf('function w19GetDriveMetadata_'));
  assert.match(backend, /w19MarkDriveNotionPage_\([^\n]+w20DriveStateForMaterial_\(existingMaterial\)\)/);
  assert.match(backend, /w19MarkDriveNotionPage_\([^\n]+w20DriveStateForMaterial_\(byFileMaterial\)\)/);
  assert.match(marker, /currentState && currentState !== 'active' && nextState === 'active'/);
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
  const uploadBody = backend.slice(backend.indexOf('function apiUpload'), backend.indexOf('function w20AttachmentJobKey_'));
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
  assert.match(body, /property: W19_P\.INSIDE, relation: \{ contains: cfg\.authorizedTaskPageId \}/);
  assert.match(body, /timestamp:\s*'created_time'/);
  assert.doesNotMatch(body, /timestamp:\s*'last_edited_time'/);
  assert.match(body, /current\.token\s*!==\s*token/);
});

test('scheduled action proof refresh is complete-cycle-only, coherent and bounded to seven minutes', () => {
  const backend = text('Code.gs');
  const registry = text('Registry.gs');
  const scheduled = backend.slice(backend.indexOf('function scheduledSync'), backend.indexOf('function w19ClaimScheduledSync_'));
  const bootstrap = backend.slice(backend.indexOf('function apiBootstrap'), backend.indexOf('function apiCreateGoogle'));
  const sync = backend.slice(backend.indexOf('function apiSyncTask'), backend.indexOf('/* ========================= Admin-only setup'));
  assert.match(registry, /W20_REGISTRY_ACTION_MAX_AGE_MS\s*=\s*7\s*\*\s*60\s*\*\s*1000/);
  assert.match(scheduled, /fullSinglePageCycle\s*=\s*!lease\.cursor\s*&&\s*!result\.has_more\s*&&\s*errors\s*===\s*0/);
  assert.match(scheduled, /w19AssertTaskPage_\(cfg\.authorizedTaskPageId, cfg\)/);
  assert.match(scheduled, /task\.id\s*!==\s*cfg\.authorizedTaskPageId/);
  assert.match(scheduled, /w19EnsureTaskFolder_\(task, cfg\)/);
  assert.match(scheduled, /w20RegistryReplaceTaskResult_\(task\.id, materials, registrySnapshotStartedAt\)/);
  assert.match(scheduled, /w20RegistryWriteTaskMetaResult_\(task\.id/);
  assert.match(scheduled, /metaWrite\.registry\.activeCount\s*!==\s*replacement\.activeCount\s*\|\|\s*!proof\.ready/);
  assert.ok(scheduled.indexOf('if (fullSinglePageCycle)') < scheduled.indexOf('w19AssertTaskPage_(cfg.authorizedTaskPageId, cfg)'));
  for (const source of [bootstrap,sync,scheduled]) assert.doesNotMatch(source,/w19SyncPageList_/);
});

test('scheduled sync claims its lease before schema access and releases it from the same try/finally', () => {
  const backend = text('Code.gs');
  const start = backend.indexOf('function scheduledSync');
  const end = backend.indexOf('\nfunction w19ClaimScheduledSync_', start);
  const body = backend.slice(start, end);
  const claim = body.indexOf('var lease = w19ClaimScheduledSync_();');
  const skip = body.indexOf("if (!lease) return { ok: true, skipped: true, reason: 'already_running' };");
  const guardedTry = body.indexOf('try {', skip);
  const schema = body.indexOf('w19AssertSchema_(cfg);');
  const guardedFinally = body.indexOf('} finally {', schema);
  const finish = body.indexOf('w19FinishScheduledSync_(lease.token, commitCursor, nextCursor);');
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.ok(claim !== -1 && claim < skip, 'lease must be claimed before the overlap skip');
  assert.ok(skip < guardedTry && guardedTry < schema, 'schema access must begin only inside the lease-holder try block');
  assert.ok(schema < guardedFinally && guardedFinally < finish, 'schema access must be covered by lease release in finally');
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
  assert.match(body, /W19_P\.SOURCE/);
  assert.match(body, /W19_P\.FILE_FORMAT/);
  assert.match(body, /W19_P\.KNOWLEDGE_FORMAT/);
  assert.doesNotMatch(body, /W19_P\.(?:PROVIDER|MIME|SIZE|DRIVE_MD5|DOWNLOAD_NAME|NORMALIZED_URL|SYNC_ERROR|INTEGRITY)/);
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
  assert.ok(frontend.includes("folderUrl:'https:\\/\\/drive.google.com/drive/folders/mockfolder123'"));
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
  assert.match(body, /if\(!state\.authoritative\|\|optimisticMaterialMutations\.size\)\{queuedOrder=null;return;\}queuedOrder=captureOrder\(\)/);
  assert.match(body, /if\(orderSaveRunning\)return/);
  assert.match(body, /while\(queuedOrder\)\{if\(!state\.authoritative\|\|optimisticMaterialMutations\.size\)\{queuedOrder=null;return;\}/);
  assert.ok(body.indexOf('queuedOrder=null') < body.indexOf("await call('apiReorder'"));
  assert.match(body, /finally\{orderSaveRunning=false;if\(queuedOrder&&state\.authoritative&&!optimisticMaterialMutations\.size\)persistOrder\(\)/);
});

test('backend and inline frontend scripts are syntactically valid JavaScript', () => {
  assert.doesNotThrow(() => new Function(text('Code.gs')));
  assert.doesNotThrow(() => new Function(text('Core.js')));
  assert.doesNotThrow(() => new Function(text('Registry.gs')));
  const html = text('Index.html');
  const downloadHtml = text('Download.html');
  for (const source of [html, downloadHtml]) {
    const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    assert.ok(scripts.length > 0);
    scripts.forEach((script) => assert.doesNotThrow(() => new Function(script)));
  }
});
