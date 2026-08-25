import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontend = fs.readFileSync(path.join(root, 'Index.html'), 'utf8');
const downloader = fs.readFileSync(path.join(root, 'Download.html'), 'utf8');
const publicCourier = fs.readFileSync(path.join(root, '..', 'download-courier.html'), 'utf8');
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
  assert.match(frontend, /document\.createElement\(courierHref\?'a':'article'\)/);
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

test('owned binaries are immediate real links to the neutral courier', () => {
  const materialCard = frontend.slice(frontend.indexOf('function materialCard'), frontend.indexOf('async function bootstrap'));
  const gridClick = frontend.slice(frontend.indexOf('function handleGridClick'), frontend.indexOf('function handleGridKeydown'));
  assert.match(materialCard, /const courierHref=downloadCourierHref\(item\)/);
  assert.match(materialCard, /document\.createElement\(courierHref\?'a':'article'\)/);
  assert.match(materialCard, /card\.href=courierHref;card\.target='_blank';card\.rel='noopener noreferrer';card\.referrerPolicy='no-referrer'/);
  assert.match(materialCard, /card\.dataset\.downloadCourier='true'/);
  assert.match(materialCard, /const action=canPrepareDownload\(item\)\?'\u0421\u043a\u0430\u0447\u0430\u0442\u044c'/);
  assert.match(gridClick, /if\(itemCard\.dataset\.downloadCourier==='true'\)return/);
  assert.ok(gridClick.indexOf("const edit=event.target.closest('[data-edit-id]')") < gridClick.indexOf("const itemCard=event.target.closest('[data-item-id]')"));
  assert.match(gridClick, /if\(edit\)\{event\.preventDefault\(\);event\.stopPropagation\(\);openEdit/);
  assert.doesNotMatch(gridClick, /downloadCourier==='true'[\s\S]{0,80}(?:preventDefault|window\.open)/);
});

test('courier href carries the service URL only in a fragment and uses a fresh cryptographic ticket', () => {
  const helpersSource = frontend.slice(frontend.indexOf('function strongDownloadTicket'), frontend.indexOf('function canPrepareDownload'));
  let seed = 0;
  const windowMock = { crypto: { getRandomValues(bytes) { for (let i=0;i<bytes.length;i+=1) bytes[i]=(seed+i)&255; seed+=1; return bytes; } } };
  const normalizeUuid = (value) => String(value || '').toLowerCase();
  const canPrepareDownload = (item) => Boolean(item?.canDownload && item?.widgetOwned && !item?.archived);
  const state = { bootstrapped:true, serviceUrl:'https://script.google.com/macros/s/abcdefghijklmnopqrstuvwxyz0123456789_-AB/exec' };
  const taskPageId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',accessToken='A'.repeat(48);
  const build = new Function('window','TextEncoder','btoa','URL','normalizeUuid','state','taskPageId','accessToken','canPrepareDownload','DOWNLOAD_COURIER_URL',`${helpersSource};return {strongDownloadTicket,downloadCourierHref};`);
  const helpers = build(windowMock,TextEncoder,btoa,URL,normalizeUuid,state,taskPageId,accessToken,canPrepareDownload,'https://ravilvaliev1999-spec.github.io/notion-widgets/download-courier.html');
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
  assert.match(publicCourier, /<iframe[^>]+credentialless[^>]+referrerpolicy="no-referrer"/);
  assert.match(publicCourier, /\^#v1=\(\[A-Za-z0-9_-\]\{80,6000\}\)\$/);
  assert.match(publicCourier, /history\.replaceState\(null,'',location\.pathname\)/);
  assert.ok(publicCourier.indexOf("const fragment=location.hash") < publicCourier.indexOf("history.replaceState(null,'',location.pathname)"));
  assert.match(publicCourier, /url\.hostname!=='script\.google\.com'/);
  assert.match(publicCourier, /allowed=new Set\(\['task','accessToken','downloadPageId','downloadTicket'\]\)/);
  assert.match(publicCourier, /entries\.length!==4/);
  assert.match(publicCourier, /runner\.setAttribute\('credentialless',''\);runner\.credentialless=true;runner\.src=serviceUrl/);
  assert.doesNotMatch(publicCourier, /event\.source/);
  assert.match(publicCourier, /event\.origin!=='null'/);
  assert.match(publicCourier, /data\.downloadTicket!==expectedTicket/);
  assert.match(publicCourier, /\},1200\)/);
  assert.match(publicCourier, /const CLOSE_AFTER_MS=60\*1000/);
  assert.doesNotMatch(publicCourier, /script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(publicCourier, /analytics|gtag|google-analytics|fetch\(|XMLHttpRequest|sendBeacon/i);
});

test('Apps Script courier fetches only after its page is opened and forces an exact named download', () => {
  assert.match(downloader, /google\.script\.url/);
  assert.match(downloader, /apiDownload\(input\)/);
  assert.match(downloader, /callDownload\(\{taskPageId,pageId,accessToken\}\)/);
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

test('rename synchronization uses a Drive-only poll on focus, visibility and every five visible seconds', () => {
  assert.match(frontend, /window\.addEventListener\('focus',pollDriveMetadata\)/);
  assert.match(frontend, /visibilitychange[\s\S]*visibilityState==='visible'\)pollDriveMetadata\(\)/);
  assert.match(frontend, /window\.setInterval\([\s\S]*,5000\)/);
  const poll = frontend.slice(frontend.indexOf('async function pollDriveMetadata'), frontend.indexOf('async function createGoogle'));
  assert.match(poll, /callBackground\('apiPollDriveMetadata',\{taskPageId,materials\}\)/);
  assert.doesNotMatch(poll, /apiSyncTask/);
  assert.match(frontend, /\^Google \(\?:Docs\|Sheets\|Slides\)\$/);
  assert.match(frontend, /currentName:item\.name/);
  assert.match(frontend, /claim:item\.drivePollClaim/);
  assert.match(poll, /claimRefreshNotBefore=Date\.now\(\)\+5\*60\*1000/);
});

test('sync triggers coalesce in one background RPC lane', async () => {
  const background = frontend.slice(frontend.indexOf('function callBackground'), frontend.indexOf('function cardMarkup'));
  const refresh = frontend.slice(frontend.indexOf('async function refresh'), frontend.indexOf('async function createGoogle'));
  assert.match(background, /request=backgroundRpcTail\.then\(run,run\)/);
  assert.match(background, /backgroundRpcTail=request\.catch\(\(\)=>\{\}\)/);
  assert.match(refresh, /if\(!taskPageId\|\|!state\.bootstrapped\|\|state\.syncing\)return/);
  assert.match(refresh, /finally \{ state\.syncing=false; \}/);
  let active=0,maxActive=0;
  const lane=new Function('call',`let backgroundRpcTail=Promise.resolve();${background};return callBackground;`)(async(method)=>{active+=1;maxActive=Math.max(maxActive,active);await new Promise((resolve)=>setTimeout(resolve,2));active-=1;return method;});
  assert.deepEqual(await Promise.all([lane('one'),lane('two'),lane('three')]),['one','two','three']);
  assert.equal(maxActive,1);
});

test('production bridge and local mock expose all required scenarios and scripts parse', () => {
  assert.match(frontend, /window\.google && google\.script && google\.script\.run/);
  for (const method of ['apiBootstrap','apiPollDriveMetadata','apiSyncTask','apiCreateGoogle','apiAddLink','apiUpload','apiDownload']) assert.ok(frontend.includes(`method==='${method}'`), `mock does not implement ${method}`);
  for (const html of [frontend,downloader,publicCourier]) {
    const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match)=>match[1]);
    assert.ok(scripts.length>0);scripts.forEach((script)=>assert.doesNotThrow(()=>new Function(script)));
  }
});
