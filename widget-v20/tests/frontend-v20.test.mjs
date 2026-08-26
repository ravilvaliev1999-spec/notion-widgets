import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontend = fs.readFileSync(path.join(root, 'Index.html'), 'utf8');
const downloader = fs.readFileSync(path.join(root, 'Download.html'), 'utf8');
const creator = fs.readFileSync(path.join(root, 'Create.html'), 'utf8');
const publicCourier = fs.readFileSync(path.join(root, '..', 'download-courier.html'), 'utf8');
const publicCreateCourier = fs.readFileSync(path.join(root, '..', 'create-courier.html'), 'utf8');
const original = fs.readFileSync(path.join(root, '..', 'google-buttons-widget.html'), 'utf8');

test('v20 preserves the original four-column visual system', () => {
  const exactTokens = [
    '--gray-bg: #2f2f2f', '--gray-bg-h: #3a3a3a', '--blue-bg: #1f3b54',
    '--blue-bg-h: #264a6b', '--green-bg: #1c3829', '--green-bg-h: #234734',
    '--orange-bg: #5c3a1e', '--orange-bg-h: #6e4624', 'background: #191919',
    '.wrap { padding: 0 4px; max-width: 1400px; margin: 0 auto; }',
    'grid-template-columns: repeat(4, 1fr)', 'gap: 12px', 'padding: 16px 18px',
    'border-radius: 12px', 'min-height: 58px', 'width: 26px; height: 26px',
    'font-size: 15px; font-weight: 600', 'font-size: 12.5px; opacity: .55'
  ];
  exactTokens.forEach((token) => assert.ok(frontend.includes(token), `missing original token: ${token}`));
  assert.doesNotMatch(frontend, /grid-template-columns:\s*(?:repeat\(2|1fr\s*;)/);
});

test('all original inline Google icon paths are retained exactly', () => {
  const originalPaths = [...original.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(originalPaths.length, 17);
  originalPaths.forEach((data) => assert.ok(frontend.includes(`d="${data}"`), `missing SVG path: ${data}`));
  const inlineScript = frontend.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';
  assert.doesNotMatch(inlineScript, /http:\/\//, 'Apps Script HTML serialization can corrupt protocol markers inside inline SVG templates');
});

test('every material is rendered as a full-size clone of its service card', () => {
  assert.match(frontend, /function materialCard\(item,count\)[\s\S]*className=`btn \$\{group\.cls\} item-card`/);
  assert.match(frontend, /document\.createElement\(courierHref\|\|directHref\?'a':'article'\)/);
  assert.match(frontend, /card\.innerHTML=cardMarkup\(section,item\.name\|\|'\u0411\u0435\u0437 \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u044f',count/);
  assert.match(frontend, /materials\.forEach\(\(item\)=>files\.appendChild\(materialCard\(item,materials\.length\)\)\)/);
  assert.match(frontend, /add\.textContent='\+ \u0434\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u0441\u0441\u044b\u043b\u043a\u0443'/);
});

test('primary cards create Google files and their pencils upload into the matching section', () => {
  assert.match(frontend, /data-upload-section="\$\{section\}"/);
  assert.match(frontend, /chooseFiles\(upload\.dataset\.uploadSection\)/);
  assert.match(frontend, /if\(section==='Drive'\)[\s\S]*createGoogle\(section\)/);
  assert.match(frontend, /call\('apiCreateGoogle',\{taskPageId,section,idempotencyKey:operation\.value\}\)/);
  assert.match(frontend, /call\('apiUpload',\{taskPageId,name:file\.name,mimeType:file\.type\|\|'application\/octet-stream',section,dataBase64,idempotencyKey:operation\.value\}\)/);
  assert.doesNotMatch(frontend, /seedDownloadFromFile\(data\.material,file\)/);
});

test('mutation retries use per-session stable idempotency keys without persisting materials', () => {
  assert.match(frontend, /window\['session' \+ 'Storage'\]/);
  assert.match(frontend, /function stableIdempotency\(action, fingerprint\)/);
  assert.match(frontend, /stableIdempotency\('create-google',section\)/);
  assert.match(frontend, /stableIdempotency\('add-link',`\$\{section\}:\$\{url\}`\)/);
  assert.match(frontend, /stableIdempotency\('upload',`\$\{section\}:\$\{file\.name\}:\$\{file\.size\}:\$\{file\.lastModified\}`\)/);
  assert.doesNotMatch(frontend, /setItem\([^,]+,\s*(?:JSON\.stringify\()?state\.materials/);
});

test('the access capability is added centrally to backend payloads and is never logged', () => {
  assert.match(frontend, /let accessToken = params\.get\('accessToken'\) \|\| ''/);
  assert.match(frontend, /google\.script\.url/);
  assert.match(frontend, /accessToken=String\(runtimeParams\.accessToken\|\|accessToken\|\|''\)/);
  assert.match(frontend, /securedPayload=Object\.assign\(\{\},payload\|\|\{\},\{accessToken\}\)/);
  assert.doesNotMatch(frontend, /console\.(?:log|debug|info|warn|error)/);
});

test('owned binaries always enter the strict neutral courier', () => {
  const materialCard = frontend.slice(frontend.indexOf('function materialCard'), frontend.indexOf('async function bootstrap'));
  const gridClick = frontend.slice(frontend.indexOf('function handleGridClick'), frontend.indexOf('function handleGridKeydown'));
  assert.match(materialCard, /const courierHref=downloadCourierHref\(item\)/);
  assert.match(materialCard, /document\.createElement\(courierHref\|\|directHref\?'a':'article'\)/);
  assert.match(materialCard, /card\.href=courierHref;card\.target='_blank';card\.rel='noopener noreferrer';card\.referrerPolicy='no-referrer'/);
  assert.match(materialCard, /card\.dataset\.downloadCourier='true'/);
  assert.match(materialCard, /const action=canPrepareDownload\(item\)\?'\u0421\u043a\u0430\u0447\u0430\u0442\u044c'/);
  assert.match(gridClick, /if\(itemCard\.tagName==='A'\)\{if\(itemCard\.dataset\.directOpen==='true'\)recentDrivePageIds\.add/);
  assert.ok(gridClick.indexOf("const edit=event.target.closest('[data-edit-id]')") < gridClick.indexOf("const itemCard=event.target.closest('[data-item-id]')"));
  assert.match(gridClick, /if\(edit\)\{event\.preventDefault\(\);event\.stopPropagation\(\);openEdit/);
  assert.doesNotMatch(frontend, /function directHostedDownload\(item\)|#v2=/);
});

test('courier href carries the service URL only in a fragment and uses a fresh cryptographic ticket', () => {
  const helpersSource = frontend.slice(frontend.indexOf('function strongDownloadTicket'), frontend.indexOf('function canPrepareDownload'));
  let seed = 0;
  const windowMock = { crypto: { getRandomValues(bytes) { for (let i=0;i<bytes.length;i+=1) bytes[i]=(seed+i)&255; seed+=1; return bytes; } } };
  const normalizeUuid = (value) => String(value || '').toLowerCase();
  const canPrepareDownload = (item) => Boolean(item?.canDownload && item?.widgetOwned && !item?.archived);
  const state = { authoritative:true, serviceUrl:'https://script.google.com/macros/s/abcdefghijklmnopqrstuvwxyz0123456789_-AB/exec' };
  const taskPageId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',accessToken='A'.repeat(48);
  const downloadGrants=new Map();
  const build = new Function('window','TextEncoder','btoa','URL','normalizeUuid','state','taskPageId','accessToken','canPrepareDownload','DOWNLOAD_COURIER_URL','downloadGrants',`${helpersSource};return {strongDownloadTicket,downloadCourierHref};`);
  const helpers = build(windowMock,TextEncoder,btoa,URL,normalizeUuid,state,taskPageId,accessToken,canPrepareDownload,'https://ravilvaliev1999-spec.github.io/notion-widgets/download-courier.html',downloadGrants);
  const item={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',canDownload:true,widgetOwned:true};
  const first=helpers.downloadCourierHref(item),second=helpers.downloadCourierHref(item);
  assert.match(first,/^https:\/\/ravilvaliev1999-spec\.github\.io\/notion-widgets\/download-courier\.html#v1=[A-Za-z0-9_-]+$/);
  assert.equal(first.split('#')[0].includes(accessToken),false);
  assert.notEqual(first,second);
  const encoded=first.split('#v1=')[1],padded=encoded.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-encoded.length%4)%4);
  const service=new URL(Buffer.from(padded,'base64').toString('utf8'));
  assert.equal(service.origin,'https://script.google.com');
  assert.equal(service.searchParams.get('task'),taskPageId);
  assert.equal(service.searchParams.get('accessToken'),accessToken);
  assert.equal(service.searchParams.get('downloadPageId'),item.id);
  assert.match(service.searchParams.get('downloadTicket'),/^[0-9a-f]{64}$/);
  assert.deepEqual([...service.searchParams.keys()].sort(),['accessToken','downloadPageId','downloadTicket','task']);
});

test('a fresh memory-only server grant replaces the random ticket without putting a direct URL in the fragment', () => {
  const helpersSource = frontend.slice(frontend.indexOf('function strongDownloadTicket'), frontend.indexOf('function canPrepareDownload'));
  let seed = 0;
  const windowMock = { crypto: { getRandomValues(bytes) { for (let i=0;i<bytes.length;i+=1) bytes[i]=(seed+i)&255; seed+=1; return bytes; } } };
  const normalizeUuid = (value) => String(value || '').toLowerCase();
  const canPrepareDownload = (item) => Boolean(item?.canDownload && item?.widgetOwned && !item?.archived);
  const state = { authoritative:true, serviceUrl:'https://script.google.com/macros/s/abcdefghijklmnopqrstuvwxyz0123456789_-AB/exec' };
  const taskPageId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',accessToken='A'.repeat(48);
  const item={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',canDownload:true,widgetOwned:true};
  const grant='a'.repeat(96),downloadGrants=new Map([[item.id,{downloadGrant:grant,expiresAt:'2099-01-01T00:00:00.000Z'}]]);
  const build = new Function('window','TextEncoder','btoa','URL','normalizeUuid','state','taskPageId','accessToken','canPrepareDownload','DOWNLOAD_COURIER_URL','downloadGrants',`${helpersSource};return {freshDownloadGrant,downloadCourierHref};`);
  const helpers = build(windowMock,TextEncoder,btoa,URL,normalizeUuid,state,taskPageId,accessToken,canPrepareDownload,'https://ravilvaliev1999-spec.github.io/notion-widgets/download-courier.html',downloadGrants);
  const fast=helpers.downloadCourierHref(item);
  assert.match(fast,/^https:\/\/ravilvaliev1999-spec\.github\.io\/notion-widgets\/download-courier\.html#v1=[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(fast,/#v2=/);
  const encoded=fast.split('#v1=')[1],padded=encoded.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-encoded.length%4)%4);
  const serviceText=Buffer.from(padded,'base64').toString('utf8'),service=new URL(serviceText);
  assert.equal(service.searchParams.get('downloadTicket'),grant);
  assert.doesNotMatch(serviceText,/prod-files-secure|notion-static|file\.notion\.so/i);
  downloadGrants.set(item.id,{downloadGrant:grant,expiresAt:'2000-01-01T00:00:00.000Z'});
  const fallback=helpers.downloadCourierHref(item),fallbackEncoded=fallback.split('#v1=')[1];
  const fallbackService=new URL(Buffer.from(fallbackEncoded.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-fallbackEncoded.length%4)%4),'base64').toString('utf8'));
  assert.match(fallbackService.searchParams.get('downloadTicket'),/^[a-f0-9]{64}$/);
  assert.notEqual(fallbackService.searchParams.get('downloadTicket'),grant);
});

test('authoritative bootstrap primes downloadable binaries asynchronously and keeps grants in memory only', () => {
  const bootstrap=frontend.slice(frontend.indexOf('function applyBootstrapData'),frontend.indexOf('function refresh('));
  const prime=frontend.slice(frontend.indexOf('function freshDownloadGrant'),frontend.indexOf('function downloadCourierHref'));
  assert.match(frontend,/const downloadGrants = new Map\(\)/);
  assert.match(frontend,/const downloadGrantPrimeInFlight = new Map\(\)/);
  assert.match(frontend,/const downloadGrantRetryNotBefore = new Map\(\)/);
  assert.match(bootstrap,/downloadPrimeGeneration\+=1;downloadGrants\.clear\(\);downloadGrantRetryNotBefore\.clear\(\)/);
  assert.match(bootstrap,/if\(state\.authoritative\)scheduleDownloadGrantPrime\(downloadPrimeGeneration\)/);
  assert.match(prime,/window\.setTimeout\(async\(\)=>/);
  assert.match(prime,/Promise\.all\(\[worker\(\),worker\(\)\]\)/);
  assert.match(prime,/call\('apiPrepareDownload',\{taskPageId,pageId:materialId\}\)/);
  assert.match(prime,/data&&data\.mode==='grant'/);
  assert.match(prime,/downloadGrants\.set\(materialId,\{downloadGrant:grant,expiresAt:[^}]+refreshNotBefore:0,refreshFailures:0\}\)/);
  assert.match(prime,/refreshDownloadGrantLink\(materialId\)/);
  assert.match(frontend,/upsert\(data\.material\);render\(\);primeDownloadGrant\(data\.material&&data\.material\.id,downloadPrimeGeneration\)/);
  assert.doesNotMatch(prime,/localStorage|sessionStorage|indexedDB|downloadUrl|attachmentUrl/);
});

test('visible download grants renew just before expiry with one timer, bounded workers and intent refresh', () => {
  const prime=frontend.slice(frontend.indexOf('function downloadCardIsVisible'),frontend.indexOf('function downloadCourierHref'));
  assert.match(frontend,/const DOWNLOAD_GRANT_RENEW_LEAD_MS = 15000/);
  assert.match(prime,/document\.visibilityState==='hidden'/);
  assert.match(prime,/function scheduleDownloadGrantRenewal\(\)/);
  assert.match(prime,/expiresAt-DOWNLOAD_GRANT_RENEW_LEAD_MS/);
  assert.match(prime,/downloadGrantRenewTimer=window\.setTimeout/);
  assert.doesNotMatch(prime,/setInterval/);
  assert.match(prime,/refreshVisibleDownloadGrants\(false\)/);
  assert.match(prime,/Promise\.all\(\[worker\(\),worker\(\)\]\)/);
  assert.match(frontend,/grid\.addEventListener\('pointerover',handleDownloadGrantIntent\)/);
  assert.match(frontend,/grid\.addEventListener\('focusin',handleDownloadGrantIntent\)/);
  assert.match(frontend,/refreshVisibleDownloadGrants\(true\)\.catch\(\(\)=>\{\}\)/);
  assert.match(prime,/downloadGrantPrimeInFlight\.get\(materialId\)/);
  assert.match(prime,/downloadGrantRetryNotBefore\.set\(materialId,permanent\?Number\.POSITIVE_INFINITY/);
});

test('grant refresh eligibility honors expiry lead and suppresses repeated proxy intent calls', () => {
  const source=frontend.slice(frontend.indexOf('function downloadGrantNeedsRefresh'),frontend.indexOf('function deferDownloadGrantRefresh'));
  const downloadGrants=new Map(),downloadGrantRetryNotBefore=new Map();
  const normalizeUuid=(value)=>String(value||'').toLowerCase();
  const needs=new Function('normalizeUuid','downloadGrants','downloadGrantRetryNotBefore','DOWNLOAD_GRANT_RENEW_LEAD_MS',`${source};return downloadGrantNeedsRefresh;`)(normalizeUuid,downloadGrants,downloadGrantRetryNotBefore,15000);
  const item={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},grant='a'.repeat(96),now=Date.now();
  downloadGrants.set(item.id,{downloadGrant:grant,expiresAt:new Date(now+30000).toISOString()});
  assert.equal(needs(item,true),false);
  downloadGrants.set(item.id,{downloadGrant:grant,expiresAt:new Date(now+10000).toISOString()});
  assert.equal(needs(item,false),true);
  downloadGrants.delete(item.id);downloadGrantRetryNotBefore.set(item.id,Number.POSITIVE_INFINITY);
  assert.equal(needs(item,true),false);
  downloadGrantRetryNotBefore.delete(item.id);
  assert.equal(needs(item,true),true);
});

test('Index performs no background binary fetch, Blob preparation, synthetic download or popup', () => {
  const downloadHelpers = frontend.slice(frontend.indexOf('function strongDownloadTicket'), frontend.indexOf('function openEdit'));
  const renderCard = frontend.slice(frontend.indexOf('function render'), frontend.indexOf('async function bootstrap'));
  assert.doesNotMatch(downloadHelpers, /call(?:Background)?\('apiDownload'/);
  assert.doesNotMatch(downloadHelpers, /scheduleDownloadPrefetch|runDownloadQueue|prepareDownloadForClick|downloadReadyFromPopup/);
  assert.doesNotMatch(`${downloadHelpers}\n${renderCard}`, /URL\.createObjectURL|new Blob|anchor\.click\(\)|window\.open\('about:blank'/);
  assert.doesNotMatch(frontend, /downloadCache|downloadQueue|DOWNLOAD_CACHE_MAX|DOWNLOAD_POPUP_LIFETIME/);
});

test('neutral courier is credentialless, fragment-only, strict, referrerless and self-closing', () => {
  assert.match(publicCourier, /<meta name="referrer" content="no-referrer">/);
  assert.match(publicCourier, /frame-ancestors 'none'/);
  assert.match(publicCourier, /<iframe[^>]+name="downloadRunner"[^>]+credentialless[^>]+referrerpolicy="no-referrer"/);
  assert.match(publicCourier, /\^#v1=\(\[A-Za-z0-9_-\]\{80,6000\}\)\$/);
  assert.doesNotMatch(publicCourier, /#v2|payload\.direct|directKeys/);
  assert.match(publicCourier, /history\.replaceState\(null,'',location\.pathname\)/);
  assert.ok(publicCourier.indexOf("const fragment=location.hash") < publicCourier.indexOf("history.replaceState(null,'',location.pathname)"));
  assert.match(publicCourier, /url\.hostname!=='script\.google\.com'/);
  assert.match(publicCourier, /allowed=new Set\(\['task','accessToken','downloadPageId','downloadTicket'\]\)/);
  assert.match(publicCourier, /entries\.length!==4/);
  assert.match(publicCourier, /form-action https:\/\/script\.google\.com https:\/\/\*\.googleusercontent\.com/);
  assert.match(publicCourier, /const keys=\['task','accessToken','downloadPageId','downloadTicket'\]/);
  assert.match(publicCourier, /form\.method='post';form\.action=action\.href;form\.target='downloadRunner';form\.enctype='application\/x-www-form-urlencoded'/);
  assert.match(publicCourier, /document\.body\.appendChild\(form\);form\.submit\(\)/);
  assert.match(publicCourier, /Object\.keys\(request\.fields\)\.length!==4/);
  assert.doesNotMatch(publicCourier, /runner\.src=|\.method='get'/i);
  assert.match(publicCourier, /function isRunnerDescendant\(source\)/);
  assert.match(publicCourier, /if\(!isRunnerDescendant\(event\.source\)\)return/);
  assert.match(publicCourier, /if\(depth>=4\)return false/);
  assert.match(publicCourier, /event\.origin!=='null'/);
  assert.match(publicCourier, /data\.downloadTicket!==expectedTicket/);
  assert.match(publicCourier, /data\.status==='direct'/);
  assert.match(publicCourier, /validateDirectDownload\(data\)/);
  assert.match(publicCourier, /prod-files-secure\\\.s3/);
  assert.match(publicCourier, /DIRECT_CLOSE_AFTER_MS=2500/);
  assert.match(publicCourier, /\},1200\)/);
  assert.match(publicCourier, /const TIMEOUT_MS=180\*1000/);
  assert.match(publicCourier, /window\.clearTimeout\(responseTimer\)/);
  assert.doesNotMatch(publicCourier, /script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(publicCourier, /analytics|gtag|google-analytics|fetch\(|XMLHttpRequest|sendBeacon/i);
});

test('Apps Script courier fetches only after its page is opened and forces an exact named download', () => {
  assert.match(downloader, /id="runtimeParams" data-params="<\?= runtimeParamsJson \?>"/);
  assert.match(downloader, /id="precomputedResult" data-result="<\?= precomputedResultJson \?>"/);
  assert.doesNotMatch(downloader, /google\.script\.url|getLocation/);
  assert.match(downloader, /apiPrepareDownload\(input\)/);
  assert.match(downloader, /apiDownload\(input\)/);
  assert.match(downloader, /params\.downloadPageId\|\|params\.pageId/);
  assert.match(downloader, /const input=\{taskPageId,pageId,accessToken\}/);
  assert.match(downloader, /const precomputed=precomputedResult\(\)/);
  assert.ok(downloader.indexOf('const precomputed=precomputedResult()') < downloader.indexOf('const params=resolveRuntimeParams()'));
  assert.match(downloader, /if\(precomputed\)[\s\S]*notifyCourierDirect\(direct\)/);
  assert.match(downloader, /data\.mode==='grant'[\s\S]*downloadGrant:grant/);
  assert.doesNotMatch(downloader, /payload=\{[^\n]+status:'direct'[^\n]+opener\.postMessage/);
  assert.match(downloader, /const MAX_DOWNLOAD_BYTES=20\*1024\*1024/);
  assert.match(downloader, /encoded\.length\/4\*3-padding!==expected/);
  assert.match(downloader, /new Blob\(chunks,\{type:'application\/octet-stream'\}\)/);
  assert.match(downloader, /anchor\.download=safeDownloadName\(data\.name\)/);
  assert.match(downloader, /document\.body\.appendChild\(anchor\);anchor\.click\(\);anchor\.remove\(\)/);
  assert.match(downloader, /downloadTicket,status:result/);
  assert.match(downloader, /window\.top&&window\.top!==window/);
  assert.match(downloader, /const SUCCESS_SETTLE_MS=2500/);
  assert.doesNotMatch(downloader, /postMessage\([^\n]*(?:accessToken|base64)/);
});

test('create courier uses a credentialless fragment-only handoff and opens only Google file URLs', () => {
  assert.match(publicCreateCourier, /<iframe[^>]+name="createRunner"[^>]+credentialless[^>]+referrerpolicy="no-referrer"/);
  assert.match(publicCreateCourier, /\^#v1=\(\[A-Za-z0-9_-\]\{80,6000\}\)\$/);
  assert.match(publicCreateCourier, /allowed=new Set\(\['task','accessToken','createSection','createRequestId'\]\)/);
  assert.match(publicCreateCourier, /entries\.length!==4/);
  assert.match(publicCreateCourier, /history\.replaceState\(null,'',location\.pathname\)/);
  assert.match(publicCreateCourier, /form-action https:\/\/script\.google\.com https:\/\/\*\.googleusercontent\.com/);
  assert.match(publicCreateCourier, /const keys=\['task','accessToken','createSection','createRequestId'\]/);
  assert.match(publicCreateCourier, /form\.method='post';form\.action=action\.href;form\.target='createRunner';form\.enctype='application\/x-www-form-urlencoded'/);
  assert.match(publicCreateCourier, /document\.body\.appendChild\(form\);form\.submit\(\)/);
  assert.match(publicCreateCourier, /Object\.keys\(request\.fields\)\.length!==4/);
  assert.doesNotMatch(publicCreateCourier, /runner\.src=serviceUrl|\.method='get'/i);
  assert.match(publicCreateCourier, /data\.type!=='notion-widget-v20-create'/);
  assert.match(publicCreateCourier, /function isRunnerDescendant\(source\)/);
  assert.match(publicCreateCourier, /if\(!isRunnerDescendant\(event\.source\)\)return/);
  assert.match(publicCreateCourier, /if\(depth>=4\)return false/);
  assert.match(publicCreateCourier, /url\.hostname!=='docs\.google\.com'&&url\.hostname!=='drive\.google\.com'/);
  assert.match(publicCreateCourier, /location\.replace\(allowedOpenUrl\(data\.openUrl\)\)/);
  assert.match(publicCreateCourier, /data\.status==='pending'/);
  assert.doesNotMatch(publicCreateCourier, /window\.open\(|accessToken[^\n]+postMessage|analytics|fetch\(/i);
  assert.match(creator, /id="runtimeParams" data-params="<\?= runtimeParamsJson \?>"/);
  assert.match(creator, /id="precomputedResult" data-result="<\?= precomputedResultJson \?>"/);
  assert.match(creator, /const prepared=precomputedResult\(\)/);
  assert.ok(creator.indexOf('const prepared=precomputedResult()') < creator.indexOf('const response=await callCreate'));
  assert.match(creator, /apiCreateGoogle\(input\)/);
  assert.match(creator, /idempotencyKey:requestId/);
  assert.match(creator, /prepared\.status==='pending'/);
  assert.match(creator, /type:'notion-widget-v20-create'/);
  assert.match(creator, /window\.top&&window\.top!==window/);
  assert.doesNotMatch(creator, /window\.open|window\.opener/);
});

test('rename synchronization polls immediately on return and uses a staggered visible interval', () => {
  assert.match(frontend, /const DRIVE_POLL_INTERVAL_MS = 15000/);
  assert.match(frontend, /const DRIVE_POLL_MIN_GAP_MS = 12000/);
  assert.match(frontend, /window\.addEventListener\('focus',refreshOnReturn\)/);
  assert.match(frontend, /visibilitychange[\s\S]*visibilityState==='visible'\)refreshOnReturn\(\)/);
  assert.match(frontend, /const firstPoll=beforeRefresh\.size\?await pollDriveMetadata\(true,beforeRefresh\):null/);
  assert.ok(frontend.indexOf('pollDriveMetadata(true,beforeRefresh)') < frontend.indexOf("if(fullRefresh&&!(firstPoll&&firstPoll.refreshed))await refresh(true)"));
  assert.match(frontend, /pollInterval=DRIVE_POLL_INTERVAL_MS\+Math\.floor\(Math\.random\(\)\*5000\)/);
  assert.match(frontend, /window\.setInterval\([\s\S]*pollDriveMetadata\(false\)[\s\S]*,pollInterval\)/);
  const poll = frontend.slice(frontend.indexOf('async function pollDriveMetadata'), frontend.indexOf('async function createGoogle'));
  assert.match(frontend, /const urgentDriveTargets = new Set\(\)/);
  assert.match(frontend, /let urgentDrivePromise = null/);
  assert.match(frontend, /let refreshPromise = null/);
  assert.match(frontend, /if\(refreshPromise\)return refreshPromise/);
  assert.match(frontend, /function scheduleUrgentDriveRetry\(\)/);
  assert.match(frontend, /if\(state\.busy\.size\)\{scheduleUrgentDriveRetry\(\);return \{refreshed:false\};\}/);
  assert.match(frontend, /async function drainUrgentDrivePolls\(\)/);
  assert.match(frontend, /const authoritativelyRetried=new Set\(\)/);
  assert.match(frontend, /const refreshUnconfirmed=async\(unconfirmed\)=>/);
  assert.match(frontend, /requiresRefresh=Array\.from\(unconfirmed\)\.some\(\(id\)=>!authoritativelyRetried\.has\(id\)\)/);
  assert.match(frontend, /authoritativelyRetried\.add\(id\);attempted\.delete\(id\)/);
  assert.match(poll, /if\(!urgentDrivePromise\)urgentDrivePromise=drainUrgentDrivePolls\(\)/);
  assert.match(frontend, /const confirmed=drivePollResultPageIds\(data\.materials\)/);
  assert.match(frontend, /confirmed\.forEach\([\s\S]*recentDrivePageIds\.delete\(id\)/);
  assert.doesNotMatch(frontend, /recentDrivePageIds\.clear\(\)/);
  assert.doesNotMatch(poll, /apiSyncTask/);
  assert.match(frontend, /\^Google \(\?:Docs\|Sheets\|Slides\)\$/);
  assert.match(frontend, /currentName:item\.name/);
  assert.match(frontend, /claim:item\.drivePollClaim/);
  assert.match(frontend, /claimRefreshNotBefore=Date\.now\(\)\+5\*60\*1000/);
});

test('an unconfirmed urgent rename target gets one authoritative refresh and retry before retirement', async () => {
  const source=frontend.slice(frontend.indexOf('async function drainUrgentDrivePolls'),frontend.indexOf('async function pollDriveMetadata'));
  const pageId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const urgentDriveTargets=new Set([pageId]),recentDrivePageIds=new Set([pageId]);
  const state={bootstrapped:true,busy:new Set(),materials:[{id:pageId}],urgentDrivePolling:false,claimRefreshNotBefore:0};
  let pollCalls=0,refreshCalls=0,retryScheduled=0;
  const drain=new Function('taskPageId','state','urgentDriveTargets','recentDrivePageIds','drivePollCoordinates','normalizeUuid','call','applyDriveMetadata','drivePollResultPageIds','refresh','pruneDrivePollTargets','scheduleUrgentDriveRetry','urgentDriveRetryDelay',`${source};return drainUrgentDrivePolls;`)(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',state,urgentDriveTargets,recentDrivePageIds,
    ()=>[{pageId}],(value)=>value,
    async()=>{pollCalls+=1;if(pollCalls===2)assert.equal(refreshCalls,1,'retry must happen after authoritative refresh');return {materials:[],refreshRequired:false};},
    ()=>{},()=>new Set(),
    async()=>{refreshCalls+=1;assert.equal(urgentDriveTargets.has(pageId),true,'target must survive until refresh');return true;},
    ()=>{},()=>{retryScheduled+=1;},250
  );
  const result=await drain();
  assert.equal(result.refreshed,true);
  assert.equal(refreshCalls,1);
  assert.equal(pollCalls,2);
  assert.equal(urgentDriveTargets.has(pageId),false);
  assert.equal(recentDrivePageIds.has(pageId),false);
  assert.equal(retryScheduled,0);
});

test('native create clicks render one optimistic card and poll only the server ledger until the safe material is ready', () => {
  assert.match(frontend, /data\.type==='notion-widget-v20-create-started'/);
  assert.match(frontend, /startOptimisticCreate\(data\.section,data\.requestId\)/);
  assert.match(frontend, /pendingCreatePolls\.get\(normalized\)/);
  assert.match(frontend, /pendingId:`pending:create:\$\{normalized\}`/);
  assert.match(frontend, /call\('apiGetCreateStatus',\{taskPageId,section:record\.section,createRequestId:record\.requestId\}\)/);
  assert.match(frontend, /data\.status==='done'&&data\.material/);
  assert.match(frontend, /state\.materials=state\.materials\.filter\(\(item\)=>item\.id!==record\.pendingId\);upsert\(data\.material\)/);
  assert.match(frontend, /pendingCreatePolls\.delete\(requestId\);recentDrivePageIds\.add\(completed\.id\)/);
  assert.match(frontend, /call\('apiWarmCreateContext',\{taskPageId\}\)\.catch\(\(\)=>\{\}\)/);
  assert.doesNotMatch(frontend, /apiGetCreateStatus[^\n]+idempotencyKey/);
});

test('sync triggers coalesce in one background RPC lane', async () => {
  const background = frontend.slice(frontend.indexOf('function callBackground'), frontend.indexOf('function cardMarkup'));
  const refresh = frontend.slice(frontend.indexOf('function refresh('), frontend.indexOf('function drivePollCoordinates'));
  assert.match(background, /request=backgroundRpcTail\.then\(run,run\)/);
  assert.match(background, /backgroundRpcTail=request\.catch\(\(\)=>\{\}\)/);
  assert.match(refresh, /if\(!taskPageId\|\|!state\.bootstrapped\)return Promise\.resolve\(false\)/);
  assert.match(refresh, /if\(refreshPromise\)return refreshPromise/);
  assert.match(refresh, /finally \{ state\.syncing=false; \}/);
  assert.match(refresh, /\.finally\(\(\)=>\{refreshPromise=null;\}\)/);
  let active=0,maxActive=0;
  const lane=new Function('call',`let backgroundRpcTail=Promise.resolve();${background};return callBackground;`)(async(method)=>{active+=1;maxActive=Math.max(maxActive,active);await new Promise((resolve)=>setTimeout(resolve,2));active-=1;return method;});
  assert.deepEqual(await Promise.all([lane('one'),lane('two'),lane('three')]),['one','two','three']);
  assert.equal(maxActive,1);
});

test('a degraded force refresh never unlocks provisional cards', async () => {
  const applyBootstrapData=frontend.slice(frontend.indexOf('function applyBootstrapData'),frontend.indexOf('async function bootstrap'));
  const bootstrap=frontend.slice(frontend.indexOf('async function bootstrap'),frontend.indexOf('function refresh('));
  assert.match(bootstrap,/if\(fresh\.cached\|\|fresh\.authoritative!==true\)/);
  assert.ok(bootstrap.indexOf('fresh.cached||fresh.authoritative!==true') < bootstrap.indexOf('applyBootstrapData(fresh,true)'));
  const responses=[
    {task:{id:'task',name:'Cached'},materials:[{id:'cached'}],cached:true,authoritative:false},
    {task:{id:'task',name:'Still cached'},materials:[{id:'stale'}],cached:true,authoritative:false}
  ];
  const state={task:null,folderUrl:null,serviceUrl:null,materials:[],maxUploadBytes:8388608,claimRefreshNotBefore:0,bootstrapped:false,authoritative:false};
  const fatals=[];
  const harness=new Function('state','taskPageId','clearFatal','call','render','announceEmbedBridgeReady','pollDriveMetadata','showFatal','pendingCreatePolls','recentCompletedCreates','recentDrivePageIds',`let downloadPrimeGeneration=0;const downloadGrants=new Map();const scheduleDownloadGrantPrime=()=>{};${applyBootstrapData};${bootstrap};return {bootstrap};`)(
    state,'task',()=>{},async()=>responses.shift(),()=>{},()=>{},()=>{throw new Error('provisional bootstrap must not poll Drive');},(message)=>fatals.push(message),new Map(),new Map(),new Set()
  );
  await harness.bootstrap();
  assert.equal(state.authoritative,false);
  assert.deepEqual(state.materials,[{id:'cached'}]);
  assert.equal(fatals.length,1);
});

test('production bridge and local mock expose all required scenarios and scripts parse', () => {
  assert.match(frontend, /window\.google && google\.script && google\.script\.run/);
  for (const method of ['apiBootstrap','apiPollDriveMetadata','apiSyncTask','apiCreateGoogle','apiAddLink','apiUpload','apiDownload']) assert.ok(frontend.includes(`method==='${method}'`), `mock does not implement ${method}`);
  for (const html of [frontend,downloader,creator,publicCourier,publicCreateCourier]) {
    const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match)=>match[1]);
    assert.ok(scripts.length>0);scripts.forEach((script)=>assert.doesNotThrow(()=>new Function(script)));
  }
});
