import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
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
  assert.match(frontend, /const payload=\{taskPageId,section,idempotencyKey:operation\.value\}/);
  assert.match(frontend, /if\(bridgeRequest&&bridgeRequest\.reservationId\)payload\.reservationId=bridgeRequest\.reservationId/);
  assert.match(frontend, /createGoogleWithRecovery\(payload\)/);
  assert.match(frontend, /call\('apiUpload',\{taskPageId,name:file\.name,mimeType:file\.type\|\|'application\/octet-stream',section,dataBase64,idempotencyKey:operation\.value\}\)/);
  assert.doesNotMatch(frontend, /seedDownloadFromFile\(data\.material,file\)/);
});

test('authoritative prepared files open directly and bind the background claim to the same request', () => {
  assert.match(frontend, /preparedCreates:\{\}/);
  assert.match(frontend, /function safePreparedCreate\(value\)/);
  assert.match(frontend, /url\.hostname!=='docs\.google\.com'/);
  assert.match(frontend, /url\.search\|\|url\.hash/);
  assert.match(frontend, /function warmPreparedCreates\(\)/);
  assert.match(frontend, /!state\.authoritative\|\|!state\.actionReady/);
  assert.match(frontend, /call\('apiWarmCreateContext',\{taskPageId\}\)/);
  assert.match(frontend, /state\.authoritative&&state\.actionReady\?Object\.values\(state\.preparedCreates\)/);
  assert.match(frontend, /issuedPreparedCreates\.get\(reservationId\)!==data\.section/);
  assert.match(frontend, /type:'notion-widget-v20-primary-started',requestId/);
  assert.match(frontend, /activeBridgeCreateRequests\.get\(data\.section\)===requestId/);
  assert.match(frontend, /if\(bridgeRequest&&bridgeRequest\.reservationId\)payload\.reservationId=bridgeRequest\.reservationId/);
  assert.match(frontend, /prepared&&prepared\.reservationId===bridgeRequest\.reservationId\)delete state\.preparedCreates\[section\]/);
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

test('owned binaries use only a server-prepared direct Drive link or the strict neutral courier', () => {
  const materialCard = frontend.slice(frontend.indexOf('function materialCard'), frontend.indexOf('async function bootstrap'));
  const gridClick = frontend.slice(frontend.indexOf('function handleGridClick'), frontend.indexOf('function handleGridKeydown'));
  assert.match(materialCard, /const directDownloadHref=freshDirectDownloadUrl\(item\),courierHref=downloadCourierHref\(item\)/);
  assert.match(materialCard, /document\.createElement\(courierHref\|\|directHref\?'a':'article'\)/);
  assert.match(materialCard, /card\.href=courierHref;card\.target='_blank';card\.rel='noopener noreferrer';card\.referrerPolicy='no-referrer'/);
  assert.match(materialCard, /if\(directDownloadHref\)card\.dataset\.downloadDirect='true';else card\.dataset\.downloadCourier='true'/);
  assert.match(materialCard, /const action=canPrepareDownload\(item\)\?'\u0421\u043a\u0430\u0447\u0430\u0442\u044c'/);
  assert.match(gridClick, /itemCard\.dataset\.downloadDirect==='true'[\s\S]*freshDirectDownloadUrl\(item\)/);
  assert.match(gridClick, /if\(!item\|\|!freshHref\)[\s\S]*downloadCourierHref\(item\)[\s\S]*delete itemCard\.dataset\.downloadDirect/);
  assert.match(gridClick, /if\(!fallbackHref\)\{itemCard\.removeAttribute\('href'\)[\s\S]*delete itemCard\.dataset\.downloadDirect[\s\S]*delete itemCard\.dataset\.downloadCourier/);
  assert.match(gridClick, /itemCard\.dataset\.directOpen==='true'\)recentDrivePageIds\.add/);
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
  const state = { authoritative:true, bootstrapped:true, serviceUrl:'https://script.google.com/macros/s/abcdefghijklmnopqrstuvwxyz0123456789_-AB/exec' };
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

test('a fresh memory-only package uses v3 immediately while a grant keeps the strict v1 fallback', () => {
  const helpersSource = frontend.slice(frontend.indexOf('function strongDownloadTicket'), frontend.indexOf('function canPrepareDownload'));
  let seed = 0;
  const windowMock = { crypto: { getRandomValues(bytes) { for (let i=0;i<bytes.length;i+=1) bytes[i]=(seed+i)&255; seed+=1; return bytes; } } };
  const normalizeUuid = (value) => String(value || '').toLowerCase();
  const canPrepareDownload = (item) => Boolean(item?.canDownload && item?.widgetOwned && !item?.archived);
  const state = { authoritative:true, bootstrapped:true, serviceUrl:'https://script.google.com/macros/s/abcdefghijklmnopqrstuvwxyz0123456789_-AB/exec' };
  const taskPageId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',accessToken='A'.repeat(48);
  const item={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',canDownload:true,widgetOwned:true};
  const grant='a'.repeat(96),downloadPackage='B'.repeat(80),packageExpiresAt=new Date(Date.now()+30000).toISOString();
  const downloadGrants=new Map([[item.id,{downloadGrant:grant,expiresAt:'2099-01-01T00:00:00.000Z',downloadPackage,packageExpiresAt}]]);
  const build = new Function('window','TextEncoder','btoa','URL','normalizeUuid','state','taskPageId','accessToken','canPrepareDownload','DOWNLOAD_COURIER_URL','downloadGrants',`${helpersSource};return {freshDownloadGrant,downloadCourierHref};`);
  const helpers = build(windowMock,TextEncoder,btoa,URL,normalizeUuid,state,taskPageId,accessToken,canPrepareDownload,'https://ravilvaliev1999-spec.github.io/notion-widgets/download-courier.html',downloadGrants);
  const fast=helpers.downloadCourierHref(item);
  assert.equal(fast,`https://ravilvaliev1999-spec.github.io/notion-widgets/download-courier.html#v3=${downloadPackage}`);
  assert.equal(fast.includes(accessToken),false);
  downloadGrants.set(item.id,{downloadGrant:grant,expiresAt:'2099-01-01T00:00:00.000Z'});
  const fallbackGrant=helpers.downloadCourierHref(item);
  assert.match(fallbackGrant,/^https:\/\/ravilvaliev1999-spec\.github\.io\/notion-widgets\/download-courier\.html#v1=[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(fallbackGrant,/#v2=/);
  const encoded=fallbackGrant.split('#v1=')[1],padded=encoded.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-encoded.length%4)%4);
  const serviceText=Buffer.from(padded,'base64').toString('utf8'),service=new URL(serviceText);
  assert.equal(service.searchParams.get('downloadTicket'),grant);
  assert.doesNotMatch(serviceText,/prod-files-secure|notion-static|file\.notion\.so/i);
  downloadGrants.set(item.id,{downloadGrant:grant,expiresAt:'2000-01-01T00:00:00.000Z'});
  const fallback=helpers.downloadCourierHref(item),fallbackEncoded=fallback.split('#v1=')[1];
  const fallbackService=new URL(Buffer.from(fallbackEncoded.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-fallbackEncoded.length%4)%4),'base64').toString('utf8'));
  assert.match(fallbackService.searchParams.get('downloadTicket'),/^[a-f0-9]{64}$/);
  assert.notEqual(fallbackService.searchParams.get('downloadTicket'),grant);
});

test('a short-lived server-prepared Drive URL bypasses the courier only for the exact material', () => {
  const helpersSource = frontend.slice(frontend.indexOf('function strongDownloadTicket'), frontend.indexOf('function canPrepareDownload'));
  const normalizeUuid = (value) => String(value || '').toLowerCase();
  const canPrepareDownload = (item) => Boolean(item?.canDownload && item?.widgetOwned && !item?.archived);
  const state = { bootstrapped:true, serviceUrl:'https://script.google.com/macros/s/abcdefghijklmnopqrstuvwxyz0123456789_-AB/exec' };
  const taskPageId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',accessToken='A'.repeat(48);
  const item={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',googleFileId:'DRIVEFILE123',canDownload:true,widgetOwned:true};
  const direct='https://drive.google.com/uc?export=download&authuser=owner%40example.com&id=DRIVEFILE123';
  const downloadGrants=new Map([[item.id,{downloadGrant:'a'.repeat(96),expiresAt:new Date(Date.now()+30000).toISOString(),directDownloadUrl:direct,directDownloadExpiresAt:new Date(Date.now()+30000).toISOString()}]]);
  const build = new Function('window','TextEncoder','btoa','URL','normalizeUuid','state','taskPageId','accessToken','canPrepareDownload','DOWNLOAD_COURIER_URL','downloadGrants',`${helpersSource};return {freshDirectDownloadUrl,downloadCourierHref};`);
  const helpers = build({crypto:{getRandomValues(){}}},TextEncoder,btoa,URL,normalizeUuid,state,taskPageId,accessToken,canPrepareDownload,'https://ravilvaliev1999-spec.github.io/notion-widgets/download-courier.html',downloadGrants);
  assert.equal(helpers.freshDirectDownloadUrl(item),direct);
  assert.equal(helpers.downloadCourierHref(item),direct);
  assert.equal(direct.includes(accessToken),false);
  assert.equal(helpers.freshDirectDownloadUrl({...item,googleFileId:'OTHERFILE123'}),'');
  downloadGrants.get(item.id).directDownloadUrl='https://drive.google.com/uc?authuser=owner%40example.com&export=download&id=DRIVEFILE123';
  assert.equal(helpers.freshDirectDownloadUrl(item),'','query order is canonical and fail-closed');
  downloadGrants.get(item.id).directDownloadUrl='https://drive.google.com/uc?export=download&authuser=owner%40example.com&id=DRIVEFILE123&extra=1';
  assert.equal(helpers.freshDirectDownloadUrl(item),'','extra parameters are rejected');
});

test('bootstrap primes downloads while preserving unchanged unexpired packages in memory', () => {
  const bootstrap=frontend.slice(frontend.indexOf('function applyBootstrapData'),frontend.indexOf('function refresh('));
  const prime=frontend.slice(frontend.indexOf('function freshDownloadGrant'),frontend.indexOf('function downloadCourierHref'));
  assert.match(frontend,/const downloadGrants = new Map\(\)/);
  assert.match(frontend,/const downloadGrantPrimeInFlight = new Map\(\)/);
  assert.match(frontend,/const downloadGrantRetryNotBefore = new Map\(\)/);
  assert.match(frontend,/const DOWNLOAD_GRANT_PRIME_WORKERS = 4/);
  assert.match(bootstrap,/const previousDownloadFingerprints=new Map\(state\.materials\.filter\(canPrepareDownload\)\.map/);
  assert.match(bootstrap,/downloadGrants\.forEach\(\(_record,pageId\)=>/);
  assert.match(bootstrap,/previousDownloadFingerprints\.get\(pageId\)!==downloadMaterialFingerprint\(current\)/);
  assert.match(bootstrap,/downloadGrants\.delete\(pageId\)/);
  assert.doesNotMatch(bootstrap,/downloadGrants\.clear\(\)/);
  assert.match(bootstrap,/downloadGrantRetryNotBefore\.clear\(\)/);
  assert.match(bootstrap,/scheduleDownloadGrantPrime\(downloadPrimeGeneration\)/);
  assert.match(prime,/window\.setTimeout\(async\(\)=>/);
  assert.match(prime,/Promise\.all\(Array\.from\(\{length:Math\.min\(DOWNLOAD_GRANT_PRIME_WORKERS,candidates\.length\)\},\(\)=>worker\(\)\)\)/);
  assert.match(prime,/visible:downloadCardIsVisible\(item\.id\)/);
  assert.match(prime,/Number\(right\.visible\)-Number\(left\.visible\)/);
  assert.match(prime,/call\('apiPrepareDownload',\{taskPageId,pageId:materialId\}\)/);
  assert.match(prime,/const requestedFingerprint=downloadMaterialFingerprint\(item\)/);
  assert.match(prime,/const current=currentDownloadMaterialForPrime\(materialId,requestedFingerprint\)/);
  assert.match(prime,/card\.dataset\.downloadPath=data&&data\.mode==='grant'\?'grant':'proxy'/);
  assert.match(prime,/dataset\.downloadReason=proxyReason/);
  assert.match(prime,/data&&data\.mode==='grant'/);
  assert.match(prime,/downloadPackage:packageValid\?downloadPackage:''/);
  assert.match(prime,/packageExpiresAt:packageValid\?new Date\(packageExpiresAt\)\.toISOString\(\):''/);
  assert.match(prime,/refreshDownloadGrantLink\(materialId\)/);
  assert.match(frontend,/upsert\(data\.material\);render\(\);primeDownloadGrant\(data\.material&&data\.material\.id,downloadPrimeGeneration\)/);
  assert.doesNotMatch(prime,/localStorage|sessionStorage|indexedDB|downloadUrl|attachmentUrl/);
});

test('an in-flight download preparation is reusable only for the exact unchanged material', () => {
  const source=frontend.slice(frontend.indexOf('function currentDownloadMaterialForPrime'),frontend.indexOf('function primeDownloadGrant'));
  const original={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',googleFileId:'DRIVEFILE123',name:'report.pdf',canDownload:true,widgetOwned:true};
  const state={materials:[original]};
  const fingerprint=(item)=>[item&&item.id,item&&item.googleFileId,item&&item.name].map((value)=>String(value??'')).join('|');
  const current=new Function('state','canPrepareDownload','downloadMaterialFingerprint',`${source};return currentDownloadMaterialForPrime;`)(
    state,
    (item)=>Boolean(item&&item.canDownload&&item.widgetOwned&&!item.archived),
    fingerprint
  );
  const requested=fingerprint(original);
  assert.equal(current(original.id,requested),original);
  state.materials=[{...original,name:'renamed.pdf'}];
  assert.equal(current(original.id,requested),null,'renamed coordinates reject the old response');
  state.materials=[{...original,widgetOwned:false}];
  assert.equal(current(original.id,requested),null,'lost ownership rejects the old response');
});

test('server-rendered safe registry cards paint before the first client RPC', () => {
  const startup=frontend.slice(frontend.indexOf('function readInitialBootstrap'),frontend.indexOf('if(state.mock)'));
  const startupTail=frontend.slice(frontend.lastIndexOf('const initialBootstrap=readInitialBootstrap()'),frontend.indexOf('if(state.mock)'));
  assert.match(frontend,/id="initialBootstrap" data-bootstrap="<\?= initialBootstrapJson \?>"/);
  assert.match(startup,/data\.cached!==true/);
  assert.match(startup,/data\.authoritative!==false/);
  assert.match(startup,/Array\.isArray\(data\.materials\)/);
  assert.match(startup,/applyBootstrapData\(initialBootstrap,false,\{skipDownloadPrime:true\}\)/);
  assert.ok(startup.indexOf('applyBootstrapData(initialBootstrap,false')<startup.indexOf('resolveRuntimeLocation().then'));
  assert.match(frontend,/state\.actionReady=Boolean\(state\.authoritative&&runtimeLocationResolved&&data&&data\.actionReady===true&&state\.trustedUntil>Date\.now\(\)\)/);
  assert.match(frontend,/if\(!runtimeLocationResolved\|\|!isEmbedBridgeMode\(\)\|\|!state\.bootstrapped\)return/);
  assert.ok(startupTail.indexOf('runtimeLocationResolved=true')<startupTail.lastIndexOf('applyBootstrapData(initialBootstrap,false'));
  assert.match(startupTail,/deferInitialDownloadPrimeUntilAuthoritative=true/);
  assert.match(startupTail,/scheduleCachedRefresh\(0\)/);
  assert.match(startupTail,/if\(state\.actionReady\)scheduleDownloadGrantPrime\(downloadPrimeGeneration\)/);
  assert.ok(startupTail.lastIndexOf('applyBootstrapData(initialBootstrap,false')<startupTail.indexOf('if(state.actionReady)scheduleDownloadGrantPrime'));
  assert.ok(startupTail.indexOf('if(state.actionReady)scheduleDownloadGrantPrime')<startupTail.indexOf('scheduleCachedRefresh(0)'));
  assert.match(frontend,/if\(state\.authoritative\)deferInitialDownloadPrimeUntilAuthoritative=false/);
  assert.match(frontend,/!deferInitialDownloadPrimeUntilAuthoritative\)scheduleDownloadGrantPrime\(downloadPrimeGeneration\)/);
});

test('visible download grants renew just before expiry with one timer, bounded workers and intent refresh', () => {
  const prime=frontend.slice(frontend.indexOf('function downloadCardIsVisible'),frontend.indexOf('function downloadCourierHref'));
  assert.match(frontend,/const DOWNLOAD_GRANT_RENEW_LEAD_MS = 15000/);
  assert.match(prime,/document\.visibilityState==='hidden'/);
  assert.match(prime,/function scheduleDownloadGrantRenewal\(\)/);
  assert.match(prime,/downloadGrants\.forEach\(\(_record,pageId\)=>refreshDownloadGrantLink\(pageId\)\)/);
  assert.match(prime,/expiresAt-DOWNLOAD_GRANT_RENEW_LEAD_MS/);
  assert.match(prime,/downloadGrantRenewTimer=window\.setTimeout/);
  assert.match(prime,/downloadGrantExpiryTimer=window\.setTimeout/);
  assert.match(prime,/nextExpiryAt=Math\.min\(nextExpiryAt,Math\.max\(now\+250,expiresAt-1000\)\)/);
  assert.doesNotMatch(prime,/setInterval/);
  assert.match(prime,/refreshVisibleDownloadGrants\(false\)/);
  assert.match(prime,/downloadGrants\.forEach\(\(_record,pageId\)=>refreshDownloadGrantLink\(pageId\)\)/);
  assert.match(prime,/Promise\.all\(Array\.from\(\{length:Math\.min\(DOWNLOAD_GRANT_PRIME_WORKERS,candidates\.length\)\},\(\)=>worker\(\)\)\)/);
  assert.match(frontend,/grid\.addEventListener\('pointerover',handleDownloadGrantIntent\)/);
  assert.match(frontend,/grid\.addEventListener\('focusin',handleDownloadGrantIntent\)/);
  assert.match(frontend,/refreshVisibleDownloadGrants\(true\)\.catch\(\(\)=>\{\}\)/);
  assert.match(frontend,/document\.visibilityState==='visible'\)\{\s*scheduleDownloadGrantRenewal\(\)/);
  assert.match(prime,/downloadGrantPrimeInFlight\.get\(materialId\)/);
  assert.match(prime,/downloadGrantRetryNotBefore\.set\(materialId,permanent\?Number\.POSITIVE_INFINITY/);
});

test('an expired direct link is removed when no protected fallback can be built', () => {
  const source=frontend.slice(frontend.indexOf('function refreshDownloadGrantLink'),frontend.indexOf('function primeDownloadGrant'));
  const item={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
  const classes=new Set(['download-ready']);
  const card={tagName:'A',href:'https://drive.google.com/uc?export=download&authuser=owner%40example.com&id=DRIVEFILE123',dataset:{downloadDirect:'true'},classList:{remove(value){classes.delete(value);},add(value){classes.add(value);}},removeAttribute(name){if(name==='href')delete this.href;}};
  const refresh=new Function('state','document','freshDirectDownloadUrl','downloadCourierHref',`${source};return refreshDownloadGrantLink;`)(
    {materials:[item]},
    {querySelector(){return card;}},
    ()=>'',
    ()=>''
  );
  refresh(item.id);
  assert.equal('href' in card,false);
  assert.equal(card.dataset.downloadDirect,undefined);
  assert.equal(card.dataset.downloadCourier,undefined);
  assert.equal(classes.has('download-ready'),false);
});

test('grant refresh eligibility honors expiry lead and suppresses repeated proxy intent calls', () => {
  const source=frontend.slice(frontend.indexOf('function trustedPreparedDriveDownloadUrl'),frontend.indexOf('function deferDownloadGrantRefresh'));
  const downloadGrants=new Map(),downloadGrantRetryNotBefore=new Map();
  const normalizeUuid=(value)=>String(value||'').toLowerCase();
  const needs=new Function('URL','normalizeUuid','downloadGrants','downloadGrantRetryNotBefore','DOWNLOAD_GRANT_RENEW_LEAD_MS',`${source};return downloadGrantNeedsRefresh;`)(URL,normalizeUuid,downloadGrants,downloadGrantRetryNotBefore,15000);
  const item={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',googleFileId:'DRIVEFILE123'},grant='a'.repeat(96),now=Date.now();
  downloadGrants.set(item.id,{downloadGrant:grant,expiresAt:new Date(now+30000).toISOString(),downloadPackage:'B'.repeat(80),packageExpiresAt:new Date(now+30000).toISOString()});
  assert.equal(needs(item,true),false);
  downloadGrants.set(item.id,{downloadGrant:grant,expiresAt:new Date(now+10000).toISOString(),downloadPackage:'B'.repeat(80),packageExpiresAt:new Date(now+10000).toISOString()});
  assert.equal(needs(item,false),true);
  downloadGrants.set(item.id,{downloadGrant:grant,expiresAt:new Date(now+30000).toISOString()});
  assert.equal(needs(item,false),false,'a valid fallback grant is not refreshed on every timer tick');
  assert.equal(needs(item,true),true,'explicit intent upgrades a legacy grant to the fast path');
  downloadGrants.get(item.id).expiresAt=new Date(now-1000).toISOString();
  assert.equal(needs(item,false),true,'an expired fallback grant is renewed automatically');
  downloadGrants.set(item.id,{downloadGrant:grant,expiresAt:new Date(now+30000).toISOString(),directDownloadUrl:'https://drive.google.com/uc?export=download&authuser=owner%40example.com&id=DRIVEFILE123',directDownloadExpiresAt:new Date(now+30000).toISOString()});
  assert.equal(needs(item,true),false,'a fresh exact Drive link needs no refresh');
  downloadGrants.get(item.id).directDownloadExpiresAt=new Date(now+10000).toISOString();
  assert.equal(needs(item,false),true,'the direct link renews before expiry');
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
  assert.match(publicCourier, /validateDirectDownload\(data,minRemainingMs,allowDrive\)/);
  assert.match(publicCourier, /startDirectDownload\(decoded\.direct,0,false\)/);
  assert.match(publicCourier, /data\.downloadTicket!==expectedTicket[\s\S]*startDirectDownload\(data,30000,true\)/);
  assert.match(publicCourier, /prod-files-secure\\\.s3/);
  assert.match(publicCourier, /DIRECT_CLOSE_AFTER_MS=2500/);
  assert.match(publicCourier, /\},1200\)/);
  assert.match(publicCourier, /const TIMEOUT_MS=180\*1000/);
  assert.match(publicCourier, /window\.clearTimeout\(responseTimer\)/);
  assert.doesNotMatch(publicCourier, /script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(publicCourier, /analytics|gtag|google-analytics|fetch\(|XMLHttpRequest|sendBeacon/i);
});

test('public courier allows canonical Drive URLs only on the ticket-authenticated v1 path', () => {
  const source=publicCourier.slice(publicCourier.indexOf('function safeDownloadName'),publicCourier.indexOf('function startDirectDownload'));
  const validate=new Function(`${source};return validateDirectDownload;`)();
  const direct={
    url:'https://drive.google.com/uc?export=download&authuser=owner%40example.com&id=DriveBinaryFile123',
    name:'report.xlsx',expiresAt:new Date(Date.now()+120000).toISOString()
  };
  assert.throws(()=>validate(direct,0,false));
  assert.doesNotThrow(()=>validate(direct,30000,true));
  assert.throws(()=>validate({...direct,url:`${direct.url}&extra=1`},30000,true));
  assert.throws(()=>validate({...direct,url:direct.url.replace('DriveBinaryFile123','../bad')},30000,true));
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
  assert.match(publicCreateCourier, /\^#v2=\(\[A-Za-z0-9_-\]\{80,6000\}\)\$/);
  assert.match(publicCreateCourier, /window\.addEventListener\('pagehide',cleanup\)/);
  assert.match(publicCreateCourier, /allowed=new Set\(\['task','accessToken','createSection','createRequestId'\]\)/);
  assert.match(publicCreateCourier, /entries\.length!==4/);
  assert.match(publicCreateCourier, /history\.replaceState\(null,'',location\.pathname\)/);
  assert.match(publicCreateCourier, /form-action https:\/\/script\.google\.com https:\/\/\*\.googleusercontent\.com/);
  assert.match(publicCreateCourier, /const keys=\['task','accessToken','createSection','createRequestId'\]/);
  assert.match(publicCreateCourier, /form\.method='post';form\.action=action\.href;form\.target='createRunner';form\.enctype='application\/x-www-form-urlencoded'/);
  assert.match(publicCreateCourier, /document\.body\.appendChild\(form\);form\.submit\(\)/);
  assert.match(publicCreateCourier, /Object\.keys\(request\.fields\)\.length!==4/);
  assert.match(publicCreateCourier, /if\(mode==='v2'\)runner\.src=request\.href;else submitCreate\(request\)/);
  assert.match(publicCreateCourier, /data\.type!=='notion-widget-v20-create'/);
  assert.match(publicCreateCourier, /function isRunnerDescendant\(source\)/);
  assert.match(publicCreateCourier, /if\(!isRunnerDescendant\(event\.source\)\)return/);
  assert.match(publicCreateCourier, /if\(depth>=4\)return false/);
  assert.match(publicCreateCourier, /url\.hostname!=='docs\.google\.com'&&url\.hostname!=='drive\.google\.com'/);
  assert.match(publicCreateCourier, /const openUrl=allowedOpenUrl\(data\.openUrl\)[\s\S]*location\.replace\(openUrl\)/);
  assert.match(publicCreateCourier, /data\.status==='pending'/);
  assert.doesNotMatch(publicCreateCourier, /window\.open\(|BroadcastChannel|accessToken[^\n]+postMessage|analytics|fetch\(/i);
  assert.match(creator, /id="runtimeParams" data-params="<\?= runtimeParamsJson \?>"/);
  assert.match(creator, /id="precomputedResult" data-result="<\?= precomputedResultJson \?>"/);
  assert.match(creator, /const prepared=precomputedResult\(\)/);
  assert.match(creator, /apiGetCreateStatus\(input\)/);
  assert.doesNotMatch(creator, /\.apiCreateGoogle\(/);
  assert.match(creator, /const statusInput=\{taskPageId,accessToken,section,createRequestId:requestId\}/);
  assert.match(creator, /state==='drive_ready'&&allowedOpenUrl\(data\.openUrl\)/);
  assert.match(creator, /notifyDriveReady\(result\.openUrl\)/);
  assert.match(creator, /if\(result\.state==='failed'\)throw new Error/);
  assert.match(creator, /error\.code==='OPERATION_IN_PROGRESS'/);
  assert.match(creator, /for\(const delay of POLL_DELAYS\)/);
  assert.doesNotMatch(creator, /randomUUID|createRequestId:\s*(?:uid|random)/);
  assert.match(creator, /prepared\.status==='pending'/);
  assert.match(creator, /type:'notion-widget-v20-create'/);
  assert.match(creator, /window\.top&&window\.top!==window/);
  assert.doesNotMatch(creator, /window\.open|window\.opener/);
});

test('Create GET rendezvous is status-only and never issues a second create RPC', async () => {
  const script=creator.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const taskPageId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e',requestId='77777777-7777-4777-8777-777777777777',accessToken='a'.repeat(64);
  async function run(statusResponses){
    const calls=[],posts=[];
    let successHandler=()=>{},failureHandler=()=>{};
    const runtime={
      withSuccessHandler(handler){successHandler=handler;return this;},
      withFailureHandler(handler){failureHandler=handler;return this;},
      apiGetCreateStatus(input){calls.push(['status',input]);const value=statusResponses.shift();if(value instanceof Error)failureHandler(value);else successHandler(value);}
    };
    let resolveTerminal;
    const terminal=new Promise((resolve)=>{resolveTerminal=resolve;});
    const top={postMessage(payload){posts.push(payload);resolveTerminal(payload);}};
    const windowObject={google:{script:{run:runtime}},top,setTimeout(callback){queueMicrotask(callback);return 1;}};
    const metas={
      status:{textContent:''},
      runtimeParams:{dataset:{params:JSON.stringify({task:taskPageId,accessToken,createSection:'Docs',createRequestId:requestId})}},
      precomputedResult:{dataset:{result:'null'}}
    };
    vm.runInNewContext(script,{window:windowObject,google:windowObject.google,document:{getElementById(id){return metas[id];}},URL,Promise,Error,Object,Array,String,Boolean,RegExp});
    await terminal;
    return {calls,posts};
  }
  const doneMaterial={openUrl:'https://docs.google.com/document/d/CreatedDocument12345/edit'};
  const immediate=await run([{ok:true,data:{status:'done',material:doneMaterial}}]);
  assert.deepEqual(immediate.calls.map(([kind])=>kind),['status']);
  assert.equal(immediate.posts[0].status,'success');

  const driveReady=await run([{ok:true,data:{status:'drive_ready',openUrl:'https://docs.google.com/document/d/DriveReadyDocument123/edit'}}]);
  assert.deepEqual(driveReady.calls.map(([kind])=>kind),['status']);
  assert.equal(driveReady.posts[0].status,'success');
  assert.equal(driveReady.posts[0].openUrl,'https://docs.google.com/document/d/DriveReadyDocument123/edit');

  const recovered=await run([
    {ok:true,data:{status:'missing'}},{ok:true,data:{status:'missing'}},{ok:true,data:{status:'pending'}},{ok:true,data:{status:'done',material:doneMaterial}}
  ]);
  assert.deepEqual(recovered.calls.map(([kind])=>kind),['status','status','status','status']);
  assert.equal(recovered.calls.filter(([kind])=>kind==='create').length,0);
  assert.ok(recovered.calls.filter(([kind])=>kind==='status').every(([,input])=>input.createRequestId===requestId));
  assert.equal(recovered.posts[0].status,'success');

  const failed=await run([{ok:true,data:{status:'failed'}},{ok:true,data:{status:'done',material:doneMaterial}}]);
  assert.deepEqual(failed.calls.map(([kind])=>kind),['status']);
  assert.equal(failed.posts[0].status,'error');
});

test('rename synchronization polls immediately on return and uses a staggered visible interval', () => {
  assert.match(frontend, /const DRIVE_POLL_INTERVAL_MS = 15000/);
  assert.match(frontend, /const DRIVE_POLL_MIN_GAP_MS = 12000/);
  assert.match(frontend, /window\.addEventListener\('focus',refreshOnReturn\)/);
  assert.match(frontend, /visibilitychange[\s\S]*visibilityState==='visible'\)\{[\s\S]*refreshOnReturn\(\)/);
  assert.match(frontend, /let returnRefreshPromise = null/);
  assert.match(frontend, /if\(returnRefreshPromise\)return returnRefreshPromise/);
  assert.match(frontend, /Promise\.resolve\(refreshOnReturn\(\)\)\.finally\(\(\)=>\{[\s\S]*scheduleActionProofRefresh\(0\)/);
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
  assert.match(frontend, /function completeOptimisticCreate\(requestId,material,announce\)/);
  assert.match(frontend, /state\.materials=state\.materials\.filter\(\(item\)=>item\.id!==record\.pendingId\)/);
  assert.match(frontend, /upsert\(material\);if\(material\)\{recentCompletedCreates\.set\(normalized,material\);rememberCompletedCreate\(normalized\);recentDrivePageIds\.add\(material\.id\);\}/);
  assert.match(frontend, /startOptimisticCreate\(section,bridgeRequest\.requestId,false\)/);
  assert.match(frontend, /function createGoogleWithRecovery\(payload\)/);
  assert.match(frontend, /const delays=\[0,900,2400\]/);
  assert.match(frontend, /if\(delay\)await new Promise\(\(resolve\)=>window\.setTimeout\(resolve,delay\)\)/);
  assert.match(frontend, /return await call\('apiCreateGoogle',payload\)/);
  assert.match(frontend, /if\(!error\.retryable\)throw error/);
  assert.match(frontend, /createGoogleWithRecovery\(payload\)/);
  assert.match(frontend, /completeOptimisticCreate\(bridgeRequest\.requestId,data\.material,false\);reply\(\{ok:true,openUrl:/);
  const createSource=frontend.slice(frontend.indexOf('async function createGoogle(section,bridgeRequest)'),frontend.indexOf('function openLinkModal'));
  const releaseAt=createSource.indexOf('delete state.preparedCreates[section]'),replyAt=createSource.indexOf('reply({ok:true,openUrl:'),announceAt=createSource.indexOf('announceEmbedBridgeReady();',replyAt);
  assert.ok(releaseAt>=0&&releaseAt<replyAt&&replyAt<announceAt,'the consumed descriptor must disappear before success is announced');
  assert.match(frontend, /if\(state\.authoritative!==true\|\|state\.actionReady!==true\)/);
  assert.match(frontend, /actionReady:state\.actionReady===true/);
  assert.doesNotMatch(frontend, /actionReady:state\.actionReady===true\|\|state\.authoritative/);
  assert.match(frontend, /state\.materials\.slice\(\)\.reverse\(\)\.filter\(\(item\)=>item&&!String\(item\.id\|\|''\)\.startsWith\('pending:'\)&&item\.syncStatus!=='pending'\)/);
  assert.match(frontend, /pendingCreatePolls\.delete\(requestId\);rememberCompletedCreate\(requestId\);recentDrivePageIds\.add\(completed\.id\)/);
  assert.match(frontend, /warmPreparedCreates\(\)\.catch\(\(\)=>\{\}\)/);
  assert.doesNotMatch(frontend, /apiGetCreateStatus[^\n]+idempotencyKey/);
});

test('action proof is renewed before expiry and authoritative data never bypasses it', () => {
  const action=frontend.slice(frontend.indexOf('function scheduleActionProofRefresh'),frontend.indexOf('function downloadMaterialFingerprint'));
  assert.match(frontend,/const ACTION_READY_RENEW_LEAD_MS = 30000/);
  assert.match(frontend,/const ACTION_READY_RETRY_DELAYS_MS = \[750,1500,3000,7000,15000\]/);
  assert.match(action,/remaining-ACTION_READY_RENEW_LEAD_MS/);
  assert.match(action,/refreshActionProof\(\)/);
  assert.match(action,/callBackground\('apiBootstrap',\{taskPageId,forceRefresh:true\}\)/);
  assert.match(action,/actionProofIsFresh\(fresh\)/);
  assert.match(action,/fresh&&fresh\.cached===false&&fresh\.authoritative===true/);
  assert.match(action,/scheduleActionProofRetry\(\)/);
  assert.match(action,/actionReadyRefreshAttempt>=ACTION_READY_RETRY_DELAYS_MS\.length/);
  assert.match(action,/state\.busy\.size\)\{actionReadyRefreshDeferredForBusy=true/);
  assert.match(frontend,/resumeDeferredActionProofRefresh\(\)/);
  assert.match(frontend,/runtimeLocationResolved&&state\.authoritative&&!state\.actionReady&&!\(options&&options\.deferActionProofRetry\)\)scheduleActionProofRetry\(\)/);
  assert.match(frontend,/applyBootstrapData\(fresh,true,\{deferActionProofRetry:true\}\)/);
  assert.match(frontend,/state\.trustedUntil-Date\.now\(\)<=ACTION_READY_RENEW_LEAD_MS\)\)scheduleActionProofRefresh\(0\)/);
  assert.match(frontend,/state\.actionReady=Boolean\(state\.authoritative&&runtimeLocationResolved&&data&&data\.actionReady===true&&state\.trustedUntil>Date\.now\(\)\)/);
  assert.doesNotMatch(frontend,/state\.actionReady=state\.authoritative\|\|/);
  assert.doesNotMatch(frontend,/const actionReady=state\.actionReady\|\|state\.authoritative/);

  const proofSource=frontend.slice(frontend.indexOf('function actionProofIsFresh'),frontend.indexOf('function scheduleActionProofRetry'));
  const proof=new Function(`${proofSource};return actionProofIsFresh;`)();
  const future=new Date(Date.now()+60000).toISOString();
  assert.equal(proof({cached:false,authoritative:true,actionReady:true,trustedUntil:future}),true);
  assert.equal(proof({cached:true,authoritative:false,actionReady:true,trustedUntil:future}),false);
  assert.equal(proof({cached:false,authoritative:true,actionReady:false,trustedUntil:future}),false);
  assert.equal(proof({cached:false,authoritative:true,actionReady:true,trustedUntil:new Date(Date.now()-1).toISOString()}),false);

  const retrySource=frontend.slice(frontend.indexOf('function scheduleActionProofRetry'),frontend.indexOf('function scheduleActionReadyExpiry'));
  const retryHarness=new Function('state','ACTION_READY_RETRY_DELAYS_MS','scheduleActionProofRefresh',`
    let actionReadyRefreshAttempt=0,actionReadyRefreshDeferredForBusy=false;
    ${retrySource}
    return {retry:scheduleActionProofRetry,resume:resumeDeferredActionProofRefresh,deferred:()=>actionReadyRefreshDeferredForBusy,attempts:()=>actionReadyRefreshAttempt};
  `);
  const retryDelays=[],retryState={busy:new Set()};
  const retries=retryHarness(retryState,[750,1500,3000],(delay)=>retryDelays.push(delay));
  assert.equal(retries.retry(),true);assert.equal(retries.retry(),true);assert.equal(retries.retry(),true);assert.equal(retries.retry(),false);
  assert.deepEqual(retryDelays,[750,1500,3000]);assert.equal(retries.attempts(),3);
  const busyState={busy:new Set(['create:Docs'])},resumedDelays=[];
  const busyHarness=retryHarness(busyState,[750],(delay)=>resumedDelays.push(delay));
  assert.equal(busyHarness.retry(),false);assert.equal(busyHarness.deferred(),true);assert.equal(busyHarness.attempts(),0);
  busyState.busy.clear();busyHarness.resume();
  assert.equal(busyHarness.deferred(),false);assert.deepEqual(resumedDelays,[0]);
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
  const refreshCachedBootstrap=frontend.slice(frontend.indexOf('async function refreshCachedBootstrap'),frontend.indexOf('async function bootstrap'));
  assert.match(refreshCachedBootstrap,/if\(fresh\.cached\|\|fresh\.authoritative!==true\)/);
  assert.ok(refreshCachedBootstrap.indexOf('fresh.cached||fresh.authoritative!==true') < refreshCachedBootstrap.indexOf('applyBootstrapData(fresh,true)'));
  const stale={task:{id:'task',name:'Still cached'},materials:[{id:'stale'}],cached:true,authoritative:false};
  const state={authoritative:false,materials:[{id:'cached'}]};
  const applications=[],scheduled=[],toasts=[];
  const refresh=new Function('state','taskPageId','call','applyBootstrapData','toast','scheduleCachedRefresh','pollDriveMetadata','window',`let cachedRefreshAttempt=0;${refreshCachedBootstrap};return refreshCachedBootstrap;`)(
    state,'task',async()=>stale,(data,authoritative)=>{applications.push([data,authoritative]);state.authoritative=Boolean(authoritative);state.materials=data.materials;},
    (message)=>toasts.push(message),(delay)=>scheduled.push(delay),()=>{throw new Error('provisional refresh must not poll Drive');},{setTimeout(){throw new Error('provisional refresh must not schedule Drive polling');}}
  );
  await refresh();
  assert.equal(state.authoritative,false);
  assert.deepEqual(state.materials,[{id:'stale'}]);
  assert.deepEqual(applications,[[stale,false]]);
  assert.deepEqual(scheduled,[2000]);
  assert.equal(toasts.length,1);
});

test('production bridge and local mock expose all required scenarios and scripts parse', () => {
  assert.match(frontend, /window\.google && google\.script && google\.script\.run/);
  for (const method of ['apiBootstrap','apiPollDriveMetadata','apiSyncTask','apiCreateGoogle','apiAddLink','apiUpload','apiDownload']) assert.ok(frontend.includes(`method==='${method}'`), `mock does not implement ${method}`);
  assert.match(frontend,/const mockActionProof=\(\)=>\(\{authoritative:true,actionReady:true,trustedUntil:new Date\(Date\.now\(\)\+120000\)\.toISOString\(\)\}\)/);
  assert.match(frontend,/method==='apiBootstrap'[\s\S]*mockActionProof\(\)/);
  assert.match(frontend,/method==='apiSyncTask'[\s\S]*mockActionProof\(\)/);
  for (const html of [frontend,downloader,creator,publicCourier,publicCreateCourier]) {
    const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match)=>match[1]);
    assert.ok(scripts.length>0);scripts.forEach((script)=>assert.doesNotThrow(()=>new Function(script)));
  }
});
