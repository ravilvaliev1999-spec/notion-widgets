import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const frontend = fs.readFileSync(path.join(here, '..', 'Index.html'), 'utf8');
const wrapper = fs.readFileSync(path.join(root, 'apps-script-embed.html'), 'utf8');
const wrapperJs = fs.readFileSync(path.join(root, 'apps-script-embed.js'), 'utf8');
const createCourier = fs.readFileSync(path.join(root, 'create-courier.html'), 'utf8');
const earlyBootstrap = wrapper.match(/<script id="earlyWidgetBootstrap">([\s\S]*?)<\/script>/)?.[1] || '';
const earlySnapshot = frontend.match(/<meta id="initialBootstrap"[\s\S]*?\/>\s*<script>\s*([\s\S]*?)<\/script>/)?.[1] || '';

test('public wrapper isolates Apps Script from multi-login cookies', () => {
  assert.match(wrapper, /<iframe[^>]+id="widget"[^>]+credentialless|<iframe[^>]+credentialless[^>]+id="widget"/);
  assert.match(wrapper, /<iframe[^>]+loading="eager"[^>]+fetchpriority="high"/);
  assert.match(wrapper, /referrerpolicy="no-referrer"/);
  assert.match(wrapper, /<link rel="preload" href="apps-script-embed\.js\?v=48" as="script" fetchpriority="high">/);
  assert.match(wrapper, /j\.src='apps-script-embed\.js\?v=48'/);
  assert.doesNotMatch(wrapper, /<script[^>]+src="apps-script-embed\.js/);
  assert.match(wrapper, /class="skeleton"/);
  assert.match(wrapper, /body\.widget-ready iframe\{opacity:1\}/);
  assert.match(wrapper, /\.snapshot-ready \.skeleton,\.widget-action-ready \.skeleton,\.widget-action-ready \.snapshot-grid\{opacity:0;visibility:hidden\}/);
  assert.match(wrapper, /\.snapshot-grid\{[^}]*pointer-events:auto/);
  assert.match(wrapper, /id="snapshotGrid"[^>]+hidden/);
  assert.equal((wrapper.match(/data-snapshot-section="(?:Drive|Docs|Sheets|Slides)"/g)||[]).length,4);
  assert.equal((wrapper.match(/class="skeleton-count"><\/span>/g)||[]).length,4,'static shell must not invent unverified zero counts');
  assert.match(wrapper,/\.skeleton-count:empty\{display:none\}/);
  assert.match(wrapper, /class="skeleton-pencil"/);
  assert.doesNotMatch(wrapper, /class="[^"]*chevron/);
});

test('wrapper starts its local cache runtime immediately but defers the credentialless Apps Script frame', () => {
  assert.ok(earlyBootstrap);
  const hash = crypto.createHash('sha256').update(earlyBootstrap).digest('base64');
  assert.match(wrapper, new RegExp(`script-src 'self' 'sha256-${hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));

  const widget = { src: '' };
  const bytes = Uint8Array.from({ length: 16 }, (_value, index) => index + 1);
  const earlyListeners = {};
  const timers = [];
  const frames = [];
  const scripts = [];
  const earlyStorage = new Map();
  const earlyLocalStorage = {getItem(key){return earlyStorage.get(key)||null;},setItem(key,value){earlyStorage.set(key,String(value));}};
  const windowObject = {
    addEventListener(type, listener) { earlyListeners[type] = listener; },
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    setTimeout(callback, delay) { const timer={callback,delay,cancelled:false};timers.push(timer);return timer; },
    clearTimeout(timer) { if(timer)timer.cancelled=true; }
  };
  vm.runInNewContext(earlyBootstrap, {
    window: windowObject,
    document: {
      readyState: 'loading',
      head: { appendChild(value) { scripts.push(value); } },
      createElement(tag) { return { tagName: String(tag).toUpperCase() }; },
      getElementById(id) { return id === 'widget' ? widget : null; }
    },
    location: { hash: `#task=3c62d627-39a1-80a1-aac7-ec19ffc9ef8e&accessToken=${'a'.repeat(64)}&release=test` },
    localStorage:earlyLocalStorage,
    crypto: { getRandomValues(target) { target.set(bytes); return target; } },
    URL, URLSearchParams, Uint8Array, Array, String
  });
  assert.equal(widget.src, '', 'the nested iframe waits for the first two shell paints');
  assert.equal(scripts.length, 1, 'the local decrypt runtime starts immediately in parallel with the outer page load');
  assert.equal(scripts[0].src, 'apps-script-embed.js?v=48');
  assert.equal(scripts[0].async, true);
  assert.equal(scripts[0].fetchPriority, 'high');
  assert.equal(widget.src, '', 'the heavyweight work must wait until Notion can paint the shell');
  assert.equal(earlyListeners.load, undefined, 'the Apps Script cold start must not wait for the wrapper load event');
  assert.equal(scripts.length, 1);
  assert.equal(windowObject.__notionWidgetDeferChild, true);
  const watchdog=timers.find((timer)=>timer.delay===200);
  assert.ok(watchdog,'hidden frames must still start the child within a bounded delay');
  assert.equal(frames.length, 1);
  frames[0]();
  assert.equal(frames.length, 2);
  assert.equal(timers.some((timer)=>timer.delay===0&&!timer.cancelled), false, 'one paint is not enough to start the nested frame');
  frames[1]();
  assert.equal(watchdog.cancelled,true,'the two-paint path cancels its hidden-frame watchdog');
  const childStart=timers.find((timer)=>timer.delay===0&&!timer.cancelled);
  assert.ok(childStart);
  childStart.callback();
  assert.equal(windowObject.__notionWidgetDeferChild, false);
  const earlyUrl = new URL(widget.src);
  assert.equal(earlyUrl.origin, 'https://script.google.com');
  assert.deepEqual(Array.from(earlyUrl.searchParams.keys()).sort(), ['accessToken', 'clientId', 'embedNonce', 'release', 'task']);
  assert.match(earlyUrl.searchParams.get('clientId'),/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(earlyUrl.searchParams.get('clientId'),windowObject.__notionWidgetEarlyBridge.clientId);
  assert.equal(earlyUrl.searchParams.get('embedNonce'), windowObject.__notionWidgetEarlyBridge.nonce);
  assert.match(windowObject.__notionWidgetEarlyBridge.nonce, /^[0-9a-f]{32}$/);
  assert.equal(scripts.length, 1);
  earlyListeners.message({origin:'https://evil.example',data:{embedNonce:windowObject.__notionWidgetEarlyBridge.nonce}});
  earlyListeners.message({origin:'https://script.googleusercontent.com',data:{embedNonce:windowObject.__notionWidgetEarlyBridge.nonce}});
  assert.equal(windowObject.__notionWidgetEarlyBridge.events.length, 1, 'only the authenticated early Google message is buffered');

  const hiddenWidget={src:''},hiddenTimers=[],hiddenFrames=[],hiddenListeners={};
  vm.runInNewContext(earlyBootstrap,{
    window:{
      addEventListener(type,listener){hiddenListeners[type]=listener;},
      requestAnimationFrame(callback){hiddenFrames.push(callback);return hiddenFrames.length;},
      setTimeout(callback,delay){const timer={callback,delay,cancelled:false};hiddenTimers.push(timer);return timer;},
      clearTimeout(timer){if(timer)timer.cancelled=true;}
    },
    document:{readyState:'loading',head:{appendChild(){}},createElement(){return {};},getElementById(){return hiddenWidget;}},
    location:{hash:`#task=3c62d627-39a1-80a1-aac7-ec19ffc9ef8e&accessToken=${'a'.repeat(64)}`},
    localStorage:earlyLocalStorage,
    crypto:{getRandomValues(target){target.set(bytes);return target;}},URL,URLSearchParams,Uint8Array,Array,String
  });
  assert.equal(hiddenFrames.length,1,'the hidden simulation intentionally leaves requestAnimationFrame suspended');
  const hiddenWatchdog=hiddenTimers.find((timer)=>timer.delay===200);
  hiddenWatchdog.callback();
  hiddenTimers.find((timer)=>timer.delay===0&&!timer.cancelled).callback();
  assert.equal(new URL(hiddenWidget.src).origin,'https://script.google.com','the watchdog starts Apps Script without a visible animation frame');
  assert.equal(new URL(hiddenWidget.src).searchParams.get('clientId'),earlyUrl.searchParams.get('clientId'),'the per-task browser client id stays stable across reloads');

  const rejectedWidget = { src: '' }, rejectedTimers = [], rejectedFrames = [], rejectedScripts = [], rejectedListeners = {};
  vm.runInNewContext(earlyBootstrap, {
    window: {
      addEventListener(type, listener) { rejectedListeners[type] = listener; },
      requestAnimationFrame(callback) { rejectedFrames.push(callback); return rejectedFrames.length; },
      setTimeout(callback, delay) { const timer={callback,delay,cancelled:false};rejectedTimers.push(timer);return timer; },
      clearTimeout(timer) { if(timer)timer.cancelled=true; }
    },
    document: {
      readyState: 'loading',
      head: { appendChild(value) { rejectedScripts.push(value); } },
      createElement(tag) { return { tagName: String(tag).toUpperCase() }; },
      getElementById() { return rejectedWidget; }
    },
    location: { hash: '#task=invalid&accessToken=invalid' },
    crypto: { getRandomValues() { throw new Error('invalid parameters must stop before entropy is requested'); } },
    URL, URLSearchParams, Uint8Array, Array, String
  });
  rejectedFrames[0]();
  rejectedFrames[1]();
  rejectedTimers.find((timer)=>timer.delay===0&&!timer.cancelled).callback();
  assert.equal(rejectedWidget.src, '');
  assert.equal(rejectedScripts.length, 1, 'the runtime still renders the validation error after first paint');
});

test('wrapper forwards only validated task runtime parameters', () => {
  assert.match(wrapperJs, /location\.hash\.length <= 1/);
  assert.match(wrapperJs, /new URLSearchParams\(location\.hash\.slice\(1\)\)/);
  assert.doesNotMatch(wrapperJs, /location\.search/);
  assert.match(wrapperJs, /\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$/);
  assert.match(wrapperJs, /\^\[A-Za-z0-9\._~-\]\{32,256\}\$/);
  assert.match(wrapperJs, /new URLSearchParams\(\{ task, accessToken, embedNonce, clientId \}\)/);
  assert.match(wrapperJs, /notion-widget-client-v1:\$\{task\}/);
  assert.match(wrapperJs, /const clientId = stableClientId\(task\)/);
  assert.match(wrapperJs, /const embedNonce = earlyEmbedNonce \|\| randomId\(\)\.replace\(\/-\/g, ''\)/);
  assert.match(wrapperJs, /earlyBridgeEvents = Array\.isArray\(early\.events\) \? early\.events : \[\]/);
  assert.doesNotMatch(wrapperJs, /early\.events\.slice/);
  assert.match(wrapperJs, /if \(window\.__notionWidgetDeferChild !== true && widget\.src !== widgetUrl\) widget\.src = widgetUrl/);
  assert.doesNotMatch(wrapperJs, /sessionStorage|document\.cookie/);
});

test('wrapper caches only an encrypted passive presentation snapshot', () => {
  assert.match(wrapperJs, /function safeSnapshotMaterials\(value\)/);
  assert.match(wrapperJs, /const sourceTop = document\.querySelector\(`\[data-snapshot-section="\$\{section\}"\]`\)/);
  assert.match(wrapperJs, /const top = sourceTop\.cloneNode\(true\)/);
  assert.doesNotMatch(wrapper,/snapshot-spacer/);
  assert.match(wrapperJs, /rows\.push\(\{ name: rawName, section, format: rawFormat \|\| 'Файл', position: Math\.round\(position\) \}\)/);
  assert.match(wrapperJs, /window\.crypto\.subtle\.encrypt\(\{ name: 'AES-GCM', iv, additionalData: context\.aad \}/);
  assert.match(wrapperJs, /window\.crypto\.subtle\.decrypt\(\{ name: 'AES-GCM', iv, additionalData: context\.aad \}/);
  assert.match(wrapperJs, /store\.setItem\(context\.slot, JSON\.stringify\(\{ schema: SNAPSHOT_CACHE_SCHEMA, savedAt, iv: bytesToBase64Url\(iv\), ciphertext: bytesToBase64Url\(ciphertext\) \}\)\)/);
  assert.match(wrapperJs, /if \(generation !== snapshotPersistGeneration \|\| fingerprint !== lastPersistedSnapshotFingerprint\) return false/);
  assert.match(wrapperJs, /const generation = \+\+snapshotPersistGeneration/);
  assert.match(wrapperJs, /SNAPSHOT_CACHE_MAX_AGE_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(wrapperJs, /key\.startsWith\('notion-widget-preview-v1:'\)/);
  assert.doesNotMatch(wrapperJs, /store\.setItem\([^\n]+materials/);
  assert.doesNotMatch(wrapperJs, /snapshot-card[^\n]+(?:openUrl|googleFileId|notion|accessToken|drivePollClaim)/i);
  assert.match(frontend, /type:'notion-widget-v20-snapshot-ready',embedNonce:nonce,materials/);
  assert.match(frontend, /snapshotMaterials:presentationSnapshotMaterials\(\)/);
  assert.match(frontend, /item\.archived!==true[^\n]+!\['pending','deleting','deleted'\]\.includes/);
});

test('prepared create cache is short-lived, encrypted, origin-bound and one-shot across tabs', () => {
  assert.match(wrapperJs, /ACTION_CACHE_MAX_TTL_MS = 2 \* 60 \* 1000/);
  assert.match(wrapperJs, /ACTION_CACHE_USED_TTL_MS = 15 \* 60 \* 1000/);
  assert.match(wrapperJs, /ACTION_CACHE_HOST = 'ravilvaliev1999-spec\.github\.io'/);
  assert.match(wrapperJs, /notion-widget-action-key-v1\\u0000\$\{host\}\\u0000\$\{task\}\\u0000\$\{token\}/);
  assert.match(wrapperJs, /notion-widget-action-v1\\u0000\$\{host\}\\u0000\$\{task\}\\u0000\$\{release\}/);
  assert.doesNotMatch(wrapperJs, /notion-widget-preview-key-v1[^\n]+notion-widget-action-key-v1/);
  assert.match(wrapperJs, /window\.crypto\.subtle\.encrypt\(\{ name: 'AES-GCM', iv, additionalData: context\.aad \}/);
  assert.match(wrapperJs, /window\.crypto\.subtle\.decrypt\(\{ name: 'AES-GCM', iv, additionalData: context\.aad \}/);
  assert.match(wrapperJs, /payload\.host === context\.host && payload\.task === context\.task/);
  assert.match(wrapperJs, /payload\.release === context\.release/);
  assert.match(wrapperJs, /trusted - saved <= ACTION_CACHE_MAX_TTL_MS/);
  assert.match(wrapperJs, /ACTION_DESCRIPTOR_V1_KEYS = \['section', 'reservationId', 'openUrl'\]/);
  assert.match(wrapperJs, /function safeCachedPreparedCreateV1\(value\)/);
  assert.match(wrapperJs, /hasExactObjectKeys\(value, ACTION_DESCRIPTOR_V1_KEYS\) \? safePreparedCreateBase\(value\) : null/);
  assert.match(wrapperJs, /url\.hostname !== 'docs\.google\.com'/);
  assert.match(wrapperJs, /openUrl !== url\.href/);
  assert.match(wrapperJs, /\^\/\$\{segment\}\/d\/\[A-Za-z0-9_-\]\{10,200\}\/edit\$/);
  assert.match(wrapperJs, /store\.setItem\(context\.usedSlot, JSON\.stringify\(\{ schema: context\.schema, updatedAt: Date\.now\(\), entries:/);
  assert.match(wrapperJs, /if \(entries\.some\(\(entry\) => entry\.digest === record\.actionDigest\)\) return false/);
  assert.match(wrapperJs, /store\.removeItem\(context\.slot\)/);
  assert.match(wrapperJs, /window\.addEventListener\('storage', handleActionCacheStorage\)/);
  assert.match(wrapperJs, /new window\.BroadcastChannel\(context\.channel\)/);
  assert.match(wrapperJs, /record\.actionQueued = true/);
  assert.match(wrapperJs, /record\.actionQueued = false/);
  assert.match(wrapperJs, /record\.cachedActionConsumed && record\.liveConfirmed !== true/);
  assert.match(wrapperJs, /record\.liveConfirmed = true/);
  assert.match(wrapper, /body\.action-cache-ready:not\(\.action-cache-measured\) \.interaction-grid/);
  const cacheWrite=wrapperJs.match(/store\.setItem\(context\.slot, JSON\.stringify\(\{ schema: ACTION_CACHE_SCHEMA[^\n]+/i)?.[0]||'';
  assert.ok(cacheWrite);
  assert.doesNotMatch(cacheWrite,/openUrl|reservationId|accessToken|docs\.google\.com/);
});

test('device-bound prepared create cache v2 is release-independent, exact and long-lived only under proof', () => {
  assert.match(wrapperJs,/ACTION_CACHE_V2_SCHEMA = 2/);
  assert.match(wrapperJs,/ACTION_CACHE_V2_MAX_TTL_MS = 30 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(wrapperJs,/ACTION_CACHE_V2_USED_TTL_MS = 31 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(wrapperJs,/ACTION_DESCRIPTOR_V2_KEYS = \['section', 'reservationId', 'openUrl', 'generation', 'navigateUntil', 'reservationProof', 'preparedName'\]/);
  assert.match(wrapperJs,/notion-widget-action-key-v2\\u0000\$\{domain\}/);
  assert.match(wrapperJs,/notion-widget-action-slot-v2\\u0000\$\{domain\}/);
  assert.match(wrapperJs,/const domain = `\$\{host\}\\u0000\$\{task\}\\u0000\$\{token\}\\u0000\$\{clientId\}`/);
  const v2Context=wrapperJs.slice(wrapperJs.indexOf('function actionCacheV2Context()'),wrapperJs.indexOf('async function actionDescriptorDigest'));
  assert.doesNotMatch(v2Context,/release/,'the v2 cache must survive wrapper release changes');
  assert.match(wrapperJs,/payload\.clientId === context\.clientId/);
  assert.match(wrapperJs,/const generation = value && value\.generation/);
  assert.match(wrapperJs,/Number\.isSafeInteger\(generation\).*generation < 1 \|\| generation > 2147483647/s);
  assert.match(wrapperJs,/new Date\(parsed\)\.toISOString\(\) === source/);
  assert.match(wrapperJs,/navigateUntilMs - current > ACTION_CACHE_V2_MAX_TTL_MS/);
  assert.match(wrapperJs,/!\/\^\[0-9a-f\]\{64\}\$\/\.test\(reservationProof\)/);
  assert.match(wrapperJs,/source === source\.replace\(\/\\s\+\/g, ' '\)\.trim\(\)/);
  assert.match(wrapperJs,/function preparedTupleMatches\(left, right\)/);
  assert.match(wrapperJs,/left\.generation === right\.generation && left\.navigateUntil === right\.navigateUntil/);
  assert.match(wrapperJs,/left\.reservationProof === right\.reservationProof && left\.preparedName === right\.preparedName/);
  const actionMessage=wrapperJs.slice(wrapperJs.indexOf('function createActionMessage(record)'),wrapperJs.indexOf('function dispatchCreateAction(record)'));
  for(const field of ['openUrl','generation','navigateUntil','reservationProof','preparedName'])assert.match(actionMessage,new RegExp(`message\\.${field} = `));
  assert.doesNotMatch(actionMessage,/clientId/);
  assert.match(wrapperJs,/optimisticCreateCards\.set\(record\.requestId, \{ section: record\.section, preparedName: record\.preparedName, openUrl: record\.href, navigateUntil: record\.navigateUntil \}\)/);
  assert.match(wrapperJs,/row\.pending \? optimisticCreateHref\(row\) : navigationHrefForRow\(row\)/);
  assert.match(wrapperJs,/card\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(wrapperJs,/if \(isV2\) addOptimisticCreate\(record\)/);
  assert.match(wrapperJs,/completed\.forEach\(removeOptimisticCreate\)/);
  assert.match(wrapperJs,/removeOptimisticCreate\(record\.requestId\)/);
  assert.doesNotMatch(wrapperJs,/persistSafeSnapshotSoon\([^\n]+optimistic/i,'pending cards must never enter the confirmed passive cache');
});

test('saved-card navigation cache is a separate encrypted read-only capability', () => {
  assert.match(wrapperJs,/NAVIGATION_CACHE_MAX_AGE_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(wrapperJs,/NAVIGATION_DIRECT_MAX_TTL_MS = 60 \* 1000/);
  assert.match(wrapperJs,/notion-widget-navigation-key-v1\\u0000\$\{domain\}/);
  assert.match(wrapperJs,/notion-widget-navigation-slot-v1\\u0000\$\{domain\}/);
  assert.match(wrapperJs,/aad: encoder\.encode\(`notion-widget-navigation-v1\\u0000\$\{domain\}`\)/);
  assert.match(wrapperJs,/safeSavedGoogleOpenUrl\(source\.openUrl, row\.section\)/);
  assert.match(wrapperJs,/keys\.join\('\|'\) === 'export\|authuser\|id'/);
  assert.match(wrapperJs,/expiresAt - Number\(now\) > NAVIGATION_DIRECT_MAX_TTL_MS/);
  assert.match(wrapperJs,/source\.name !== row\.name \|\| source\.section !== row\.section \|\| source\.format !== row\.format/);
  assert.match(wrapperJs,/navigationCacheSnapshotFingerprint !== snapshotFingerprint\(confirmedSnapshotRows\)/);
  assert.match(wrapperJs,/document\.createElement\(navigationHref \? 'a' : 'article'\)/);
  assert.match(wrapperJs,/card\.target = '_blank'/);
  assert.match(wrapperJs,/card\.rel = 'noopener noreferrer'/);
  assert.match(wrapperJs,/card\.referrerPolicy = 'no-referrer'/);
  assert.match(wrapperJs,/if \(bridge\.authoritative && bridge\.actionReady\) persistNavigationCache\(data\.navigationMaterials, data\.navigationFolderUrl, data\.snapshotMaterials\)/);
  const bridgeReady=wrapperJs.slice(wrapperJs.indexOf("if (data.type === 'notion-widget-v20-bridge-ready')"),wrapperJs.indexOf("if (!isCurrentBridgeEvent(event))"));
  assert.doesNotMatch(bridgeReady,/else invalidateNavigationCache\(\)/,'a stale bridge cannot revoke the encrypted navigation cache');
  const navigationWrite=wrapperJs.match(/store\.setItem\(context\.slot, JSON\.stringify\(\{ schema: NAVIGATION_CACHE_SCHEMA[^\n]+/i)?.[0]||'';
  assert.ok(navigationWrite);
  assert.doesNotMatch(navigationWrite,/url|token|accessToken|googleFileId|materialId|docs\.google\.com|drive\.google\.com/);
  const renderView=wrapperJs.slice(wrapperJs.indexOf('function renderSnapshotView('),wrapperJs.indexOf('function renderSafeSnapshotMaterials('));
  assert.doesNotMatch(renderView,/menu|rename|archive|delete|mutation/i,'the restored outer card exposes only its main native anchor');
});

test('server-rendered early snapshot posts only passive card presentation fields', () => {
  assert.ok(earlySnapshot);
  const nonce='0123456789abcdef0123456789abcdef';
  const messages=[];
  const parent={postMessage(message,targetOrigin){messages.push({message,targetOrigin});}};
  parent.parent=parent;
  const bootstrap={cached:true,authoritative:false,materials:[
    {id:'3c72d627-39a1-8120-bd0a-f969e6846945',name:'  Реальный   документ  ',section:'Docs',format:'Google Docs',position:2,openUrl:'https://docs.google.com/document/d/Secret/edit',googleFileId:'Secret',drivePollClaim:'claim',createRequestId:'55555555-5555-4555-8555-555555555555'},
    {id:'pending:1',name:'Ещё не создан',section:'Docs',format:'Google Docs',position:3,syncStatus:'pending'},
    {id:'3c72d627-39a1-8120-bd0a-f969e6846946',name:'Скрытый',section:'Drive',format:'PDF',position:1,archived:true}
  ]};
  vm.runInNewContext(earlySnapshot,{
    window:{parent},location:{search:`?embedNonce=${nonce}&accessToken=${'a'.repeat(64)}`},
    document:{getElementById(){return {dataset:{bootstrap:JSON.stringify(bootstrap)}};}},
    URLSearchParams,JSON,String,Number,Math,Array,RegExp
  });
  assert.equal(messages.length,1);
  assert.equal(messages[0].targetOrigin,'https://ravilvaliev1999-spec.github.io');
  const payload=JSON.parse(JSON.stringify(messages[0].message));
  assert.deepEqual(Object.keys(payload).sort(),['embedNonce','materials','type']);
  assert.equal(payload.embedNonce,nonce);
  assert.equal(payload.type,'notion-widget-v20-snapshot-ready');
  assert.deepEqual(payload.materials,[{name:'Реальный документ',section:'Docs',format:'Google Docs',position:2}]);
});

test('wrapper binds one authenticated child channel without relaying local file contents', () => {
  assert.match(wrapperJs, /type === 'notion-widget-v20-bridge-ready'/);
  assert.match(wrapperJs, /bridge = \{ source: event\.source, origin: event\.origin, instanceId: data\.instanceId, authoritative: data\.authoritative === true, actionReady: data\.actionReady === true, folderUrl: allowedDriveFolderUrl\(data\.folderUrl\), preparedCreates:/);
  assert.match(wrapperJs, /document\.body\.classList\.toggle\('widget-action-ready', bridge\.authoritative && bridge\.actionReady\)/);
  assert.match(wrapperJs, /data\.authoritative === true && data\.actionReady === true \? preparedCreateMap\(data\.preparedCreates\) : \{\}/);
  const bridgeReady=wrapperJs.slice(wrapperJs.indexOf("if (data.type === 'notion-widget-v20-bridge-ready')"),wrapperJs.indexOf("if (!isCurrentBridgeEvent(event))"));
  assert.ok(bridgeReady.indexOf("classList.add('widget-ready')")<bridgeReady.indexOf('applyPrimaryGeometry('));
  assert.ok(bridgeReady.indexOf("classList.add('widget-ready')")<bridgeReady.indexOf('acceptSnapshotMaterials('),'the live iframe is revealed before passive snapshot work');
  assert.ok(bridgeReady.indexOf('completeCreateRequests(')<bridgeReady.indexOf('adoptLivePreparedRecords('),'completed cached reservations are removed before live descriptor reconciliation');
  assert.ok(bridgeReady.indexOf('adoptLivePreparedRecords(')<bridgeReady.indexOf('dispatchCreateAction(record)'),'a queued cached action is reconciled before any dispatch');
  assert.match(wrapperJs, /bridge\.source\.postMessage\(Object\.assign\(\{\}, message, \{ embedNonce \}\), bridge\.origin\)/);
  assert.doesNotMatch(wrapperJs, /postMessage\([^\n]+, '\*'\)/);
  assert.doesNotMatch(wrapperJs, /type: 'notion-widget-v20-upload-files'|\bFile\b|dataBase64/);
  assert.match(frontend, /event\.origin===EMBED_BRIDGE_ORIGIN&&isBoundedAncestor\(event\.source\)/);
  assert.match(frontend, /data\.embedNonce===embedNonce/);
  assert.match(frontend, /chooseFiles\(upload\.dataset\.uploadSection\)/);
  assert.match(frontend, /\$\('fileInput'\)\.addEventListener\('change'/);
});

test('credentialless create uses native anchors and a fragment-only neutral courier', () => {
  assert.match(wrapper, /class="interaction-slot" data-slot="Docs"/);
  assert.match(wrapper, /primary-control-pencil-top/);
  assert.match(wrapper, /primary-control-pencil-bottom/);
  assert.match(wrapperJs, /\['main', 'pencil-top', 'pencil-right', 'pencil-bottom'\]/);
  assert.match(wrapperJs, /const pencilLeft=Number\(row\.pencil\.left\)-left,pencilTop=Number\(row\.pencil\.top\)-top/);
  assert.match(wrapperJs, /\{left:pencilRight,top:pencilTop,width:width-pencilRight,height:pencilHeight\}/);
  assert.match(wrapperJs, /document\.createElement\('a'\)/);
  assert.match(wrapperJs, /control\.target = '_blank'/);
  assert.match(wrapperJs, /control\.rel = 'noopener noreferrer'/);
  assert.match(wrapperJs, /CREATE_COURIER_URL/);
  assert.match(wrapperJs, /const createRequests = new Map\(\)/);
  assert.match(wrapperJs, /let existing = createRequests\.get\(section\)/);
  assert.match(wrapperJs, /const liveReady = hasLiveActionBridge\(\)/);
  assert.match(wrapperJs, /return Boolean\(bridge && bridge\.authoritative === true && bridge\.actionReady === true\)/);
  assert.doesNotMatch(wrapperJs, /bridge\.actionReady \|\| bridge\.authoritative/);
  assert.match(wrapperJs, /const completedCreateRequestIds = bridge\.authoritative \? data\.completedCreateRequestIds : \[\]/);
  assert.match(wrapperJs, /completeCreateRequests\(completedCreateRequestIds\)/);
  assert.match(wrapperJs, /const requestId = rememberedCreateRequest\(section\) \|\| randomId\(\)/);
  assert.match(wrapperJs, /service\.searchParams\.set\('task', params\.get\('task'\)\)/);
  assert.match(wrapperJs, /service\.searchParams\.set\('accessToken', params\.get\('accessToken'\)\)/);
  assert.match(wrapperJs, /service\.searchParams\.set\('createSection', section\)/);
  assert.match(wrapperJs, /service\.searchParams\.set\('createRequestId', requestId\)/);
  assert.match(wrapperJs, /Array\.from\(service\.searchParams\.keys\(\)\)\.length !== 4/);
  assert.match(wrapperJs, /createRequests\.set\(section, record\)/);
  assert.match(wrapperJs, /reservationId: prepared\.reservationId/);
  assert.match(wrapperJs, /href: prepared\.openUrl/);
  assert.match(wrapperJs, /if \(record\.reservationId\) message\.reservationId = record\.reservationId/);
  assert.match(wrapperJs, /type === 'notion-widget-v20-primary-started'/);
  assert.match(wrapperJs, /record\.navigationCommitted = true/);
  assert.match(wrapperJs, /const expectedReservationId = prepared && prepared\.reservationId \|\| ''/);
  assert.match(wrapperJs, /record\.ackAttempts < 2 && dispatchCreateAction\(record\)/);
  assert.match(wrapperJs, /data\.retryable === false\) \{ createRequests\.delete\(section\);forgetCreateRequest\(section\);terminalSections\.push\(section\)/);
  assert.match(wrapperJs, /url\.hostname !== 'docs\.google\.com'/);
  assert.match(wrapperJs, /url\.search \|\| url\.hash/);
  assert.match(wrapperJs, /openUrl !== url\.href/);
  assert.match(wrapperJs, /now - record\.lastNavigationAt < 1500/);
  assert.match(wrapperJs, /control\.addEventListener\('auxclick'/);
  assert.match(wrapperJs, /#v2=\$\{encodeCourierFragment\(service\.href\)\}/);
  assert.match(wrapperJs, /type: 'notion-widget-v20-primary-action', section: record\.section, requestId: record\.requestId/);
  assert.doesNotMatch(wrapperJs, /window\.open/);
  assert.match(wrapperJs, /new window\.BroadcastChannel\(context\.channel\)/);
  assert.match(frontend, /if\(isEmbedBridgeMode\(\)\)return;/);
  assert.match(frontend, /card\.tabIndex=-1/);
  assert.match(frontend, /type:'notion-widget-v20-primary-geometry'/);
  assert.match(frontend, /data\.type==='notion-widget-v20-primary-geometry-request'/);
  assert.match(frontend, /pencilRect=pencil\.getBoundingClientRect\(\)/);
  assert.match(wrapperJs, /window\.setInterval\(runGeometryHeartbeat, 750\)/);
  assert.match(wrapperJs, /Date\.now\(\) - lastGeometryAckAt > 2000/);
  assert.match(wrapperJs, /numbers\[0\] < -tolerance/);
});

test('wrapper runtime exposes validated native create links without opening a popup', async () => {
  class FakeElement {
    constructor() {
      this.children = [];
      this.dataset = {};
      this.listeners = {};
      this.style = {};
      this.hidden = false;
      this.disabled = false;
      this.textContent = '';
      this.tagName = '';
    }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    setAttribute(name, value) { this[name] = value; }
    removeAttribute(name) { delete this[name]; }
  }

  const slots = ['Drive', 'Docs', 'Sheets', 'Slides'].map((section) => {
    const slot = new FakeElement();
    slot.dataset.slot = section;
    return slot;
  });
  const widget = new FakeElement();
  widget.clientWidth = 868;
  widget.clientHeight = 523;
  const interactionGrid = new FakeElement();
  interactionGrid.hidden = true;
  interactionGrid.querySelectorAll = (selector) => {
    if (selector === '[data-slot]') return slots;
    if (selector === '[data-section]') return slots.flatMap((slot) => slot.children);
    const section = selector.match(/^\[data-section="([A-Za-z]+)"\]$/)?.[1];
    return section ? slots.flatMap((slot) => slot.children).filter((control) => control.dataset.section === section) : [];
  };
  const fatal = new FakeElement();
  fatal.hidden = true;
  const snapshotGrid = new FakeElement();
  snapshotGrid.hidden = true;
  const events = [];
  const task='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e',token='a'.repeat(64),release='test';
  const actionHost='ravilvaliev1999-spec.github.io',actionNow=10000,actionTrustedUntil=100000;
  const cachedSheetsId='44444444-4444-4444-8444-444444444444';
  const cachedSheetsUrl='https://docs.google.com/spreadsheets/d/CachedSpreadsheet123/edit';
  const encoder=new TextEncoder();
  const actionKeyDigest=await crypto.webcrypto.subtle.digest('SHA-256',encoder.encode(`notion-widget-action-key-v1\u0000${actionHost}\u0000${task}\u0000${token}`));
  const actionSlotDigest=await crypto.webcrypto.subtle.digest('SHA-256',encoder.encode(`notion-widget-action-slot-v1\u0000${actionHost}\u0000${task}\u0000${token}\u0000${release}`));
  const actionUsedSlotDigest=await crypto.webcrypto.subtle.digest('SHA-256',encoder.encode(`notion-widget-action-used-slot-v1\u0000${actionHost}\u0000${task}\u0000${token}\u0000${release}`));
  const actionSlot=`notion-widget-action-v1:${Buffer.from(actionSlotDigest).subarray(0,18).toString('base64url')}`;
  const actionUsedSlot=`notion-widget-action-used-v1:${Buffer.from(actionUsedSlotDigest).subarray(0,18).toString('base64url')}`;
  const actionKey=await crypto.webcrypto.subtle.importKey('raw',actionKeyDigest,{name:'AES-GCM'},false,['encrypt']);
  const actionIv=crypto.webcrypto.getRandomValues(new Uint8Array(12));
  const actionPayload={schema:1,host:actionHost,task,release,savedAt:actionNow,trustedUntil:actionTrustedUntil,preparedCreates:[{section:'Sheets',reservationId:cachedSheetsId,openUrl:cachedSheetsUrl}]};
  const actionCiphertext=await crypto.webcrypto.subtle.encrypt({name:'AES-GCM',iv:actionIv,additionalData:encoder.encode(`notion-widget-action-v1\u0000${actionHost}\u0000${task}\u0000${release}`)},actionKey,encoder.encode(JSON.stringify(actionPayload)));
  const actionEnvelope=JSON.stringify({schema:1,savedAt:actionNow,trustedUntil:actionTrustedUntil,iv:Buffer.from(actionIv).toString('base64url'),ciphertext:Buffer.from(actionCiphertext).toString('base64url')});
  const staleSnapshotSlot='notion-widget-preview-v1:stale-token-slot';
  const persistedSnapshot = new Map([[staleSnapshotSlot,JSON.stringify({schema:1,savedAt:-100000000,iv:'invalid',ciphertext:'invalid'})],[actionSlot,actionEnvelope]]);
  let snapshotSetCount=0;
  const bodyClasses = new Set();
  const bridgeSource = { length: 0, frames: [], postMessage(message, origin) { events.push(['post', message, origin]); } };
  widget.contentWindow = { length: 1, frames: [bridgeSource] };
  const windowListeners = {};
  let intervalCallback = null;
  let now = actionNow;
  const timeouts=[];
  const broadcastMessages=[];
  class FakeBroadcastChannel {
    constructor(name){this.name=name;this.listeners={};}
    addEventListener(type,listener){this.listeners[type]=listener;}
    postMessage(message){broadcastMessages.push(JSON.parse(JSON.stringify(message)));}
  }
  const windowObject = {
    crypto: { subtle:crypto.webcrypto.subtle,randomUUID: (() => { let index=1;return () => `11111111-1111-4111-8111-${String(index++).padStart(12,'0')}`; })(), getRandomValues(target) { return crypto.webcrypto.getRandomValues(target); } },
    localStorage:{get length(){return persistedSnapshot.size;},key(index){return Array.from(persistedSnapshot.keys())[index]||null;},getItem(key){return persistedSnapshot.get(key)||null;},setItem(key,value){if(String(key).startsWith('notion-widget-preview-v1:'))snapshotSetCount+=1;persistedSnapshot.set(key,String(value));},removeItem(key){persistedSnapshot.delete(key);}},
    BroadcastChannel:FakeBroadcastChannel,
    addEventListener(type, listener) { windowListeners[type] = listener; },
    setTimeout(callback,delay) { const timer={callback,delay,cancelled:false};timeouts.push(timer);return timer; },
    setInterval(callback) { intervalCallback=callback; return 2; },
    clearTimeout(timer) { if(timer)timer.cancelled=true; }
  };
  const context = {
    window: windowObject,
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      body: { classList: {
        add(value) { bodyClasses.add(value);events.push(['class',value]); },
        toggle(value, force) { if(force){bodyClasses.add(value);events.push(['class',value]);return true;}bodyClasses.delete(value);return false; },
        contains(value) { return bodyClasses.has(value); }
      } },
      getElementById(id) { return { widget, interactionGrid, snapshotGrid, fatal }[id]; },
      querySelector() { return null; },
      createElement(tagName) { const element=new FakeElement();element.tagName=String(tagName).toUpperCase();return element; }
    },
    location: { protocol:'https:',hostname:actionHost,port:'',hash: `#task=${task}&accessToken=${token}&release=${release}` },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    Uint8Array,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Date: { now: () => now, parse: (value) => globalThis.Date.parse(value) },
    Math,
    RegExp
  };
  vm.runInNewContext(wrapperJs, context);
  assert.equal(persistedSnapshot.has(staleSnapshotSlot),false,'expired ciphertext from a rotated token is pruned without decrypting it');
  const prebridgeSheets=slots.find((slot)=>slot.dataset.slot==='Sheets').children[0];
  for(let attempt=0;attempt<30&&prebridgeSheets.href!==cachedSheetsUrl;attempt+=1)await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(prebridgeSheets.href,cachedSheetsUrl,'a valid encrypted prepared descriptor is native-clickable before the Apps Script bridge');
  assert.equal(interactionGrid.hidden,false);
  assert.equal(bodyClasses.has('action-cache-ready'),true);
  const postsBeforeCachedClick=events.filter((entry)=>entry[0]==='post').length;
  prebridgeSheets.listeners.click({preventDefault(){throw new Error('the cached action must retain native navigation');}});
  assert.equal(events.filter((entry)=>entry[0]==='post').length,postsBeforeCachedClick,'the background action stays queued until a bridge exists');
  assert.equal(persistedSnapshot.has(actionSlot),false,'the reusable encrypted envelope is synchronously removed on the first click');
  const usedEnvelope=String(persistedSnapshot.get(actionUsedSlot)||'');
  assert.ok(usedEnvelope,'the click synchronously writes a cross-tab one-shot tombstone');
  assert.doesNotMatch(usedEnvelope,/CachedSpreadsheet|docs\.google\.com|44444444|a{32}/);
  assert.deepEqual(Object.keys(JSON.parse(usedEnvelope)).sort(),['entries','schema','updatedAt']);
  assert.equal(broadcastMessages.filter((message)=>message.type==='used').length,1);

  const forwarded = new URL(widget.src).searchParams;
  const embedNonce = forwarded.get('embedNonce');
  const origin = 'https://script.googleusercontent.com';
  const preparedDocsId = '55555555-5555-4555-8555-555555555555';
  const nextPreparedDocsId = '66666666-6666-4666-8666-666666666666';
  const preparedSlidesId = '77777777-7777-4777-8777-777777777777';
  const preparedDocsUrl = 'https://docs.google.com/document/d/PreparedDocument12345/edit';
  const nextPreparedDocsUrl = 'https://docs.google.com/document/d/NextPreparedDocument12/edit';
  const preparedSlidesUrl = 'https://docs.google.com/presentation/d/PreparedSlides123456/edit';
  windowListeners.message({
    source: bridgeSource,
    origin,
    data: {
      type: 'notion-widget-v20-bridge-ready',
      embedNonce,
      instanceId: '33333333-3333-4333-8333-333333333333',
      authoritative: false,
      actionReady: false,
      snapshotMaterials:[{name:'Конфиденциальное название',section:'Docs',format:'Google Docs',position:0,openUrl:'https://docs.google.com/document/d/MustNotPersist/edit',googleFileId:'MustNotPersist'}],
      folderUrl: 'https://drive.google.com/drive/folders/TaskFolder12345',
      preparedCreates: [{section:'Docs',reservationId:preparedDocsId,openUrl:preparedDocsUrl}],
      viewport: {width:868,height:523},
      geometry: ['Drive', 'Docs', 'Sheets', 'Slides'].map((section, index) => ({
        section,left:index*220,top:0,width:208,height:70,pencil:{left:index*220+180,top:7,width:22,height:22}
      }))
    }
  });
  assert.equal(events.filter((entry)=>entry[0]==='post'&&entry[1].type==='notion-widget-v20-primary-action'&&entry[1].requestId===cachedSheetsId).length,0,'actionReady=false must not claim a cached reservation');
  assert.equal(bodyClasses.has('widget-ready'), true, 'cached content may render immediately');
  assert.equal(snapshotGrid.hidden,false,'a real passive snapshot renders before live authority');
  assert.equal(bodyClasses.has('widget-action-ready'), false, 'the full-color safe shell must cover disabled primary cards');
  assert.equal(prebridgeSheets.href,undefined,'actionReady=false revokes the consumed cached href');
  assert.equal(slots.find((slot)=>slot.dataset.slot==='Docs').children[0].href, undefined, 'cached bootstrap must not enable creation');
  windowListeners.message({source:bridgeSource,origin,data:{
    type:'notion-widget-v20-bridge-ready',embedNonce,instanceId:'33333333-3333-4333-8333-333333333333',authoritative:true,
    actionReady:true,trustedUntil:'1970-01-01T00:01:40.000Z',folderUrl:'https://drive.google.com/drive/folders/TaskFolder12345',
    preparedCreates:[{section:'Docs',reservationId:preparedDocsId,openUrl:preparedDocsUrl},{section:'Slides',reservationId:preparedSlidesId,openUrl:preparedSlidesUrl}],
    viewport:{width:868,height:523},geometry:['Drive','Docs','Sheets','Slides'].map((section,index)=>({section,left:index*220,top:0,width:208,height:70,pencil:{left:index*220+180,top:7,width:22,height:22}}))
  }});
  assert.equal(events.filter((entry)=>entry[0]==='post'&&entry[1].type==='notion-widget-v20-primary-action'&&entry[1].requestId===cachedSheetsId).length,0,'a missing or different live descriptor must not dispatch the queued cached reservation');
  assert.equal(prebridgeSheets.href,undefined,'a mismatched live pool must not fall back to a generic create URL for the pending click');
  windowListeners.message({source:bridgeSource,origin,data:{
    type:'notion-widget-v20-bridge-ready',embedNonce,instanceId:'33333333-3333-4333-8333-333333333333',authoritative:true,
    actionReady:true,trustedUntil:'1970-01-01T00:01:40.000Z',folderUrl:'https://drive.google.com/drive/folders/TaskFolder12345',
    preparedCreates:[{section:'Docs',reservationId:preparedDocsId,openUrl:preparedDocsUrl},{section:'Sheets',reservationId:cachedSheetsId,openUrl:cachedSheetsUrl},{section:'Slides',reservationId:preparedSlidesId,openUrl:preparedSlidesUrl}],
    viewport:{width:868,height:523},geometry:['Drive','Docs','Sheets','Slides'].map((section,index)=>({section,left:index*220,top:0,width:208,height:70,pencil:{left:index*220+180,top:7,width:22,height:22}}))
  }});
  const queuedAction=events.find((entry)=>entry[0]==='post'&&entry[1].type==='notion-widget-v20-primary-action'&&entry[1].requestId===cachedSheetsId);
  assert.ok(queuedAction,'the authenticated bridge receives a queued cached action only after an exact live match');
  assert.equal(queuedAction[1].reservationId,cachedSheetsId);
  windowListeners.message({source:bridgeSource,origin,data:{type:'notion-widget-v20-primary-started',embedNonce,requestId:cachedSheetsId}});
  windowListeners.message({source:bridgeSource,origin,data:{type:'notion-widget-v20-snapshot-ready',embedNonce,materials:[{name:'Последнее подтверждённое название',section:'Docs',format:'Google Docs',position:0}]}});
  windowListeners.message({
    source: bridgeSource,
    origin,
    data: {
      type: 'notion-widget-v20-bridge-ready',
      embedNonce,
      instanceId: '33333333-3333-4333-8333-333333333333',
      authoritative: true,
      actionReady: true,
      trustedUntil: '1970-01-01T00:01:40.000Z',
      completedCreateRequestIds:[cachedSheetsId],
      folderUrl: 'https://drive.google.com/drive/folders/TaskFolder12345',
      preparedCreates: [{section:'Docs',reservationId:preparedDocsId,openUrl:preparedDocsUrl},{section:'Slides',reservationId:preparedSlidesId,openUrl:preparedSlidesUrl}],
      viewport: {width:868,height:523},
      geometry: ['Drive', 'Docs', 'Sheets', 'Slides'].map((section, index) => ({
        section,
        left: index * 220,
        top: 0,
        width: 208,
        height: 70,
        pencil: { left: index * 220 + 180, top: 7, width: 22, height: 22 }
      }))
    }
  });
  assert.equal(interactionGrid.hidden, false);
  assert.ok(events.some((entry)=>entry[0]==='class'&&entry[1]==='widget-ready'));
  assert.equal(bodyClasses.has('widget-action-ready'), true, 'authoritative action readiness reveals live primary cards');
  const geometryRequest=events.find((entry)=>entry[0]==='post'&&entry[1].type==='notion-widget-v20-primary-geometry-request');
  assert.equal(geometryRequest[1].requestId,1);
  windowListeners.message({source:bridgeSource,origin,data:{type:'notion-widget-v20-primary-geometry',embedNonce,requestId:1,viewport:{width:868,height:523},geometry:['Drive','Docs','Sheets','Slides'].map((section,index)=>({section,left:index*220,top:-105,width:208,height:70,pencil:{left:index*220+180,top:-98,width:22,height:22}}))}});
  assert.equal(interactionGrid.hidden,true);
  intervalCallback();
  const retryRequest=events.filter((entry)=>entry[0]==='post'&&entry[1].type==='notion-widget-v20-primary-geometry-request').at(-1);
  assert.equal(retryRequest[1].requestId,2);
  windowListeners.message({source:bridgeSource,origin,data:{type:'notion-widget-v20-primary-geometry',embedNonce,requestId:2,viewport:{width:868,height:523},geometry:['Drive','Docs','Sheets','Slides'].map((section,index)=>({section,left:index*220,top:0,width:208,height:70,pencil:{left:index*220+180,top:7,width:22,height:22}}))}});
  assert.equal(interactionGrid.hidden,false);
  events.length=0;
  const docsSlot = slots.find((slot) => slot.dataset.slot === 'Docs');
  assert.equal(docsSlot.style.left, '220px');
  assert.equal(docsSlot.style.height, '70px');
  assert.equal(docsSlot.children[0].style.width, '180px');
  assert.equal(docsSlot.children[1].style.height, '7px');
  assert.equal(docsSlot.children[2].style.left, '202px');
  assert.equal(docsSlot.children[3].style.top, '29px');

  const docsPrimary = docsSlot.children[0];
  assert.equal(docsPrimary.tagName,'A');
  assert.equal(docsPrimary.target,'_blank');
  assert.equal(docsPrimary.rel,'noopener noreferrer');
  docsPrimary.listeners.click({preventDefault(){throw new Error('valid create link must keep native navigation');}});
  const primaryAction=events.find((entry)=>entry[0]==='post'&&entry[1].type==='notion-widget-v20-primary-action');
  assert.equal(primaryAction[1].section,'Docs');
  assert.equal(docsPrimary.href,preparedDocsUrl);
  assert.equal(primaryAction[1].requestId,preparedDocsId);
  assert.equal(primaryAction[1].reservationId,preparedDocsId);
  const firstAckTimer=timeouts.find((timer)=>timer.delay===1000&&!timer.cancelled);
  assert.ok(firstAckTimer,'the native action waits for an explicit iframe acknowledgement');
  windowListeners.message({source:bridgeSource,origin,data:{type:'notion-widget-v20-primary-started',embedNonce,requestId:preparedDocsId}});
  assert.equal(firstAckTimer.cancelled,true,'the iframe acknowledgement cancels the bounded resend');
  const sheetsPrimary=slots.find((slot)=>slot.dataset.slot==='Sheets').children[0];
  assert.match(sheetsPrimary.href,/^https:\/\/ravilvaliev1999-spec\.github\.io\/notion-widgets\/create-courier\.html#v2=[A-Za-z0-9_-]+$/);
  const encoded=sheetsPrimary.href.split('#v2=')[1];
  const padded=encoded.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-encoded.length%4)%4);
  const service=new URL(Buffer.from(padded,'base64').toString('utf8'));
  assert.equal(service.origin,'https://script.google.com');
  assert.deepEqual(Array.from(service.searchParams.keys()).sort(),['accessToken','createRequestId','createSection','task']);
  assert.equal(service.searchParams.get('task'),'3c62d627-39a1-80a1-aac7-ec19ffc9ef8e');
  assert.equal(service.searchParams.get('accessToken'),'a'.repeat(64));
  assert.equal(service.searchParams.get('createSection'),'Sheets');
  assert.match(service.searchParams.get('createRequestId'),/^[0-9a-f-]{36}$/);
  const firstCreateHref=docsPrimary.href;
  let preventedClicks=0;
  docsPrimary.listeners.click({preventDefault(){preventedClicks+=1;}});
  assert.equal(docsPrimary.href,firstCreateHref,'double click must reuse one idempotency key');
  assert.equal(preventedClicks,1,'double click must navigate to the create courier only once');
  assert.equal(events.filter((entry)=>entry[0]==='post'&&entry[1].type==='notion-widget-v20-primary-action').length,1,'double click must send one create RPC');
  now+=1500;
  docsPrimary.listeners.click({preventDefault(){preventedClicks+=1;}});
  assert.equal(preventedClicks,2,'an in-flight request must never open a second courier tab');
  assert.equal(events.filter((entry)=>entry[0]==='post'&&entry[1].type==='notion-widget-v20-primary-action').length,1,'reopening the same request must not repeat the RPC');
  windowListeners.message({source:bridgeSource,origin,data:{
    type:'notion-widget-v20-primary-result',embedNonce,requestId:preparedDocsId,ok:false,message:'temporary failure'
  }});
  windowListeners.message({source:bridgeSource,origin,data:{
    type:'notion-widget-v20-bridge-ready',embedNonce,instanceId:'33333333-3333-4333-8333-333333333333',authoritative:true,
    actionReady:true,trustedUntil:'1970-01-01T00:01:40.000Z',folderUrl:'https://drive.google.com/drive/folders/TaskFolder12345',preparedCreates:[{section:'Docs',reservationId:nextPreparedDocsId,openUrl:nextPreparedDocsUrl},{section:'Slides',reservationId:preparedSlidesId,openUrl:preparedSlidesUrl}],
    viewport:{width:868,height:523},geometry:['Drive','Docs','Sheets','Slides'].map((section,index)=>({section,left:index*220,top:0,width:208,height:70,pencil:{left:index*220+180,top:7,width:22,height:22}}))
  }});
  assert.equal(docsPrimary.href,firstCreateHref,'a retryable result must retain the committed reservation even when the pool advertises another file');
  docsPrimary.listeners.click({preventDefault(){throw new Error('a failed warm action must allow one native recovery navigation');}});
  assert.equal(docsPrimary.href,firstCreateHref,'a recovery click must retain the original idempotency key');
  const recoveryActions=events.filter((entry)=>entry[0]==='post'&&entry[1].type==='notion-widget-v20-primary-action');
  assert.equal(recoveryActions.length,2,'a reported warm-action failure must unlock exactly one retry');
  assert.equal(recoveryActions[1][1].requestId,preparedDocsId,'the retry must reuse the same request id');
  assert.equal(recoveryActions[1][1].reservationId,preparedDocsId,'the retry must retain the bound reservation id');
  windowListeners.message({source:bridgeSource,origin,data:{
    type:'notion-widget-v20-bridge-ready',embedNonce,instanceId:'33333333-3333-4333-8333-333333333333',authoritative:true,
    actionReady:true,trustedUntil:'1970-01-01T00:01:40.000Z',folderUrl:'https://drive.google.com/drive/folders/TaskFolder12345',completedCreateRequestIds:[preparedDocsId],
    preparedCreates:[{section:'Docs',reservationId:nextPreparedDocsId,openUrl:nextPreparedDocsUrl},{section:'Slides',reservationId:preparedSlidesId,openUrl:preparedSlidesUrl}],
    viewport:{width:868,height:523},geometry:['Drive','Docs','Sheets','Slides'].map((section,index)=>({section,left:index*220,top:0,width:208,height:70,pencil:{left:index*220+180,top:7,width:22,height:22}}))
  }});
  assert.equal(docsPrimary.href,nextPreparedDocsUrl,'a confirmed knowledge must release the key and expose the replenished direct file');
  const slidesPrimary=slots.find((slot)=>slot.dataset.slot==='Slides').children[0];
  slidesPrimary.listeners.auxclick({button:1,preventDefault(){throw new Error('middle click must keep native navigation');}});
  const slideActions=events.filter((entry)=>entry[0]==='post'&&entry[1].type==='notion-widget-v20-primary-action'&&entry[1].requestId===preparedSlidesId);
  assert.equal(slideActions.length,1,'middle click must start the background claim');
  assert.equal(slideActions[0][1].reservationId,preparedSlidesId);
  const slideAckOne=timeouts.filter((timer)=>timer.delay===1000&&!timer.cancelled).at(-1);slideAckOne.callback();
  const slideAckTwo=timeouts.filter((timer)=>timer.delay===1000&&!timer.cancelled).at(-1);slideAckTwo.callback();
  assert.equal(events.filter((entry)=>entry[0]==='post'&&entry[1].type==='notion-widget-v20-primary-action'&&entry[1].requestId===preparedSlidesId).length,2,'lost acknowledgement retries the same request only once');
  const drivePrimary=slots.find((slot)=>slot.dataset.slot==='Drive').children[0];
  assert.equal(drivePrimary.href,'https://drive.google.com/drive/folders/TaskFolder12345');

  for(let attempt=0;attempt<20&&!Array.from(persistedSnapshot.keys()).some((key)=>key.startsWith('notion-widget-preview-v1:'));attempt+=1)await new Promise((resolve)=>setImmediate(resolve));
  const previewEntries=Array.from(persistedSnapshot.entries()).filter(([key])=>key.startsWith('notion-widget-preview-v1:'));
  assert.equal(previewEntries.length,1,'one encrypted presentation envelope is persisted');
  assert.equal(snapshotSetCount,1,'an overtaken encryption can never write an older snapshot');
  const [[slotKey,storedEnvelope]]=previewEntries;
  assert.match(slotKey,/^notion-widget-preview-v1:[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(`${slotKey}\n${storedEnvelope}`,/Конфиденциальное|Последнее подтверждённое|MustNotPersist|docs\.google\.com|a{32}/);
  const envelope=JSON.parse(storedEnvelope);
  assert.deepEqual(Object.keys(envelope).sort(),['ciphertext','iv','savedAt','schema']);
  const keyDigest=await crypto.webcrypto.subtle.digest('SHA-256',encoder.encode(`notion-widget-preview-key-v1\u0000${task}\u0000${token}`));
  const key=await crypto.webcrypto.subtle.importKey('raw',keyDigest,{name:'AES-GCM'},false,['decrypt']);
  const iv=Buffer.from(envelope.iv,'base64url'),ciphertext=Buffer.from(envelope.ciphertext,'base64url');
  const plaintext=await crypto.webcrypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:encoder.encode(`notion-widget-preview-v1\u0000${task}\u0000test`)},key,ciphertext);
  const cachedPayload=JSON.parse(new TextDecoder().decode(plaintext));
  assert.deepEqual(cachedPayload.materials,[{name:'Последнее подтверждённое название',section:'Docs',format:'Google Docs',position:0}]);
  for(let attempt=0;attempt<20&&!persistedSnapshot.has(actionSlot);attempt+=1)await new Promise((resolve)=>setImmediate(resolve));
  const storedActionEnvelope=String(persistedSnapshot.get(actionSlot)||'');
  assert.ok(storedActionEnvelope,'live prepared descriptors replenish the encrypted action cache');
  assert.doesNotMatch(storedActionEnvelope,/PreparedDocument|PreparedSlides|docs\.google\.com|55555555|77777777|a{32}/);
  const replenishedActionEnvelope=JSON.parse(storedActionEnvelope);
  assert.deepEqual(Object.keys(replenishedActionEnvelope).sort(),['ciphertext','iv','savedAt','schema','trustedUntil']);
  const actionDecryptKey=await crypto.webcrypto.subtle.importKey('raw',actionKeyDigest,{name:'AES-GCM'},false,['decrypt']);
  const replenishedPlaintext=await crypto.webcrypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(replenishedActionEnvelope.iv,'base64url'),additionalData:encoder.encode(`notion-widget-action-v1\u0000${actionHost}\u0000${task}\u0000${release}`)},actionDecryptKey,Buffer.from(replenishedActionEnvelope.ciphertext,'base64url'));
  const replenishedPayload=JSON.parse(new TextDecoder().decode(replenishedPlaintext));
  assert.equal(replenishedPayload.host,actionHost);
  assert.equal(replenishedPayload.task,task);
  assert.equal(replenishedPayload.release,release);
  assert.equal(replenishedPayload.trustedUntil,replenishedActionEnvelope.trustedUntil);
  assert.equal(replenishedPayload.preparedCreates.some((item)=>item.reservationId===cachedSheetsId),false,'a synchronously tombstoned descriptor is never re-cached');
});

test('v2 cached navigation paints one real pending card and binds only after an exact live proof tuple', async () => {
  class Element {
    constructor(tag=''){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.style={};this.listeners={};this.hidden=false;this.attributes={};this.className='';this.href=undefined;this.textContent='';this.clientWidth=868;this.clientHeight=523;}
    appendChild(child){this.children.push(child);return child;}
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this.children=children;}
    addEventListener(type,listener){this.listeners[type]=listener;}
    setAttribute(name,value){this.attributes[name]=String(value);this[name]=String(value);}
    removeAttribute(name){delete this.attributes[name];delete this[name];}
    querySelector(){return null;}
    querySelectorAll(){return [];}
  }
  const task='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e',token='c'.repeat(64),release='release-a';
  const clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',host='ravilvaliev1999-spec.github.io';
  let now=1_000_000;
  const navigateUntilMs=now+20*24*60*60*1000;
  const navigateUntil=new globalThis.Date(navigateUntilMs).toISOString();
  const descriptor={section:'Docs',reservationId:'88888888-8888-4888-8888-888888888888',openUrl:'https://docs.google.com/document/d/DevicePreparedDoc123/edit',generation:7,navigateUntil,reservationProof:'d'.repeat(64),preparedName:'Новый быстрый документ'};
  const encoder=new TextEncoder(),domain=`${host}\u0000${task}\u0000${token}\u0000${clientId}`;
  const keyDigest=await crypto.webcrypto.subtle.digest('SHA-256',encoder.encode(`notion-widget-action-key-v2\u0000${domain}`));
  const slotDigest=await crypto.webcrypto.subtle.digest('SHA-256',encoder.encode(`notion-widget-action-slot-v2\u0000${domain}`));
  const usedSlotDigest=await crypto.webcrypto.subtle.digest('SHA-256',encoder.encode(`notion-widget-action-used-slot-v2\u0000${domain}`));
  const slot=`notion-widget-action-v2:${Buffer.from(slotDigest).subarray(0,18).toString('base64url')}`;
  const usedSlot=`notion-widget-action-used-v2:${Buffer.from(usedSlotDigest).subarray(0,18).toString('base64url')}`;
  const key=await crypto.webcrypto.subtle.importKey('raw',keyDigest,{name:'AES-GCM'},false,['encrypt']);
  const iv=crypto.webcrypto.getRandomValues(new Uint8Array(12));
  const payload={schema:2,host,task,clientId,savedAt:now,expiresAt:navigateUntilMs,preparedCreates:[descriptor]};
  const ciphertext=await crypto.webcrypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(`notion-widget-action-v2\u0000${domain}`)},key,encoder.encode(JSON.stringify(payload)));
  const storage=new Map([
    [`notion-widget-client-v1:${task}`,clientId],
    [slot,JSON.stringify({schema:2,savedAt:now,expiresAt:navigateUntilMs,iv:Buffer.from(iv).toString('base64url'),ciphertext:Buffer.from(ciphertext).toString('base64url')})]
  ]);
  const slots=['Drive','Docs','Sheets','Slides'].map((section)=>{const value=new Element();value.dataset.slot=section;return value;});
  const interactionGrid=new Element();interactionGrid.hidden=true;
  interactionGrid.querySelectorAll=(selector)=>selector==='[data-slot]'?slots:selector==='[data-section]'?slots.flatMap((item)=>item.children):[];
  const snapshotGrid=new Element();snapshotGrid.hidden=true;
  const widget=new Element(),fatal=new Element(),events=[],broadcast=[];
  const bridgeSource={length:0,frames:[],postMessage(message,origin){events.push({message:JSON.parse(JSON.stringify(message)),origin});}};
  widget.contentWindow={length:1,frames:[bridgeSource]};
  const listeners={};
  class BroadcastChannel {constructor(name){this.name=name;}addEventListener(){}postMessage(message){broadcast.push(JSON.parse(JSON.stringify(message)));}}
  class ClockDate extends globalThis.Date {static now(){return now;}}
  const bodyClasses=new Set();
  const windowObject={
    crypto:{subtle:crypto.webcrypto.subtle,randomUUID:(()=>{let n=1;return()=>`99999999-9999-4999-8999-${String(n++).padStart(12,'0')}`;})(),getRandomValues(target){return crypto.webcrypto.getRandomValues(target);}},
    localStorage:{get length(){return storage.size;},key(index){return Array.from(storage.keys())[index]||null;},getItem(key){return storage.get(key)||null;},setItem(key,value){storage.set(key,String(value));},removeItem(key){storage.delete(key);}},
    BroadcastChannel,addEventListener(type,listener){listeners[type]=listener;},setTimeout(callback,delay){return{callback,delay};},clearTimeout(){},setInterval(){return 1;}
  };
  vm.runInNewContext(wrapperJs,{
    window:windowObject,document:{visibilityState:'visible',addEventListener(){},body:{classList:{add(value){bodyClasses.add(value);},toggle(value,force){if(force){bodyClasses.add(value);return true;}bodyClasses.delete(value);return false;},contains(value){return bodyClasses.has(value);}}},
      getElementById(id){return{widget,interactionGrid,snapshotGrid,fatal}[id];},querySelector(){return null;},createElement(tag){return new Element(tag);}},
    location:{protocol:'https:',hostname:host,port:'',hash:`#task=${task}&accessToken=${token}&release=${release}`},URL,URLSearchParams,TextEncoder,TextDecoder,atob,btoa,Uint8Array,Array,Object,String,Number,Boolean,Date:ClockDate,Math,RegExp
  });
  const docsControl=slots.find((item)=>item.dataset.slot==='Docs').children[0];
  for(let attempt=0;attempt<30&&docsControl.href!==descriptor.openUrl;attempt+=1)await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(docsControl.href,descriptor.openUrl,'release-independent v2 ciphertext restores a native Google URL before the bridge');
  const embedNonce=new URL(widget.src).searchParams.get('embedNonce'),origin='https://script.googleusercontent.com';
  listeners.message({source:bridgeSource,origin,data:{type:'notion-widget-v20-bridge-ready',embedNonce,instanceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',authoritative:false,actionReady:false,completedCreateRequestIds:[descriptor.reservationId],preparedCreates:[],geometry:[],viewport:{width:868,height:523}}});
  assert.equal(docsControl.href,descriptor.openUrl,'a stale non-authoritative bridge cannot revoke the device-bound native action');
  assert.equal(storage.has(slot),true,'the stale bridge preserves the encrypted v2 descriptor');
  assert.equal(events.filter((entry)=>entry.message.type==='notion-widget-v20-primary-action').length,0,'a stale bridge cannot dispatch the cached action');
  listeners.message({source:bridgeSource,origin,data:{type:'notion-widget-v20-bridge-ready',embedNonce,instanceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',authoritative:true,actionReady:false,preparedCreates:[],geometry:[],viewport:{width:868,height:523}}});
  assert.equal(docsControl.href,descriptor.openUrl,'authority without a fresh action proof still preserves the signed v2 navigation');
  assert.equal(storage.has(slot),true);
  docsControl.listeners.click({preventDefault(){throw new Error('the first v2 cache click must navigate natively');}});
  const descendants=(root)=>root.children.flatMap((child)=>[child,...descendants(child)]);
  assert.equal(descendants(snapshotGrid).filter((item)=>String(item.className).includes('optimistic-create')).length,1,'one synchronous pending card is painted');
  const pending=descendants(snapshotGrid).find((item)=>String(item.className).includes('optimistic-create'));
  assert.equal(pending.attributes['aria-busy'],'true');
  assert.equal(pending.tagName,'A');
  assert.equal(pending.href,descriptor.openUrl,'the pending card immediately reopens the exact already-prepared document');
  assert.equal(pending.target,'_blank');
  pending.listeners.click({preventDefault(){throw new Error('the pending prepared document must keep native navigation');}});
  assert.equal(events.filter((entry)=>entry.message.type==='notion-widget-v20-primary-action').length,0,'reopening the pending card does not create or bind another document');
  assert.ok(descendants(pending).some((item)=>item.textContent===descriptor.preparedName),'the card uses the server-proved exact name');
  let prevented=0;docsControl.listeners.click({preventDefault(){prevented+=1;}});
  assert.equal(prevented,1);
  assert.equal(descendants(snapshotGrid).filter((item)=>String(item.className).includes('optimistic-create')).length,1,'a double click cannot duplicate the optimistic card');
  assert.equal(storage.has(slot),false,'the v2 reusable ciphertext is removed synchronously');
  const tombstone=JSON.parse(storage.get(usedSlot));
  assert.equal(tombstone.schema,2);
  assert.ok(tombstone.entries[0].expiresAt-now>=30*24*60*60*1000,'the consumed proof stays tombstoned for at least thirty days');
  assert.doesNotMatch(JSON.stringify(tombstone),/DevicePrepared|Новый быстрый|d{32}|docs\.google\.com/);
  assert.equal(Array.from(storage.entries()).some(([key,value])=>key.startsWith('notion-widget-preview-v1:')&&String(value).includes(descriptor.preparedName)),false,'the optimistic row is never persisted as confirmed presentation state');
  const mismatch=Object.assign({},descriptor,{generation:8,reservationProof:'e'.repeat(64)});
  listeners.message({source:bridgeSource,origin,data:{type:'notion-widget-v20-bridge-ready',embedNonce,instanceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',authoritative:true,actionReady:true,preparedCreates:[mismatch],geometry:[],viewport:{width:868,height:523}}});
  assert.equal(events.filter((entry)=>entry.message.type==='notion-widget-v20-primary-action').length,0,'a different generation/proof tuple never binds the cached navigation');
  assert.equal(descendants(snapshotGrid).filter((item)=>String(item.className).includes('optimistic-create')).length,0,'a proof mismatch removes the pending card');
  assert.match(fatal.textContent,/защищённая фоновая привязка/);
  listeners.message({source:bridgeSource,origin,data:{type:'notion-widget-v20-bridge-ready',embedNonce,instanceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',authoritative:true,actionReady:true,preparedCreates:[descriptor],geometry:[],viewport:{width:868,height:523}}});
  const actions=events.filter((entry)=>entry.message.type==='notion-widget-v20-primary-action');
  assert.equal(actions.length,1,'the queue binds after the exact live tuple arrives');
  assert.deepEqual(Object.keys(actions[0].message).sort(),['embedNonce','generation','navigateUntil','openUrl','preparedName','requestId','reservationId','reservationProof','section','type']);
  assert.equal(actions[0].message.clientId,undefined);
  for(const field of ['generation','navigateUntil','reservationProof','preparedName'])assert.equal(actions[0].message[field],descriptor[field]);
  assert.equal(actions[0].message.openUrl,descriptor.openUrl);
  assert.equal(descendants(snapshotGrid).filter((item)=>String(item.className).includes('optimistic-create')).length,1,'an exact late confirmation restores one pending card');
  listeners.message({source:bridgeSource,origin,data:{type:'notion-widget-v20-bridge-ready',embedNonce,instanceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',authoritative:true,actionReady:true,completedCreateRequestIds:[descriptor.reservationId],preparedCreates:[],geometry:[],viewport:{width:868,height:523}}});
  assert.equal(descendants(snapshotGrid).filter((item)=>String(item.className).includes('optimistic-create')).length,0,'exact completion replaces the optimistic state');
  assert.equal(events.filter((entry)=>entry.message.type==='notion-widget-v20-primary-action').length,1,'completion is processed before reconcile and cannot redispatch');
  assert.ok(broadcast.some((message)=>message.schema===2&&message.type==='used'));
});

test('encrypted saved navigation restores native Google, Drive download and folder anchors without live mutations', async () => {
  class Element {
    constructor(tag=''){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.style={};this.listeners={};this.hidden=false;this.attributes={};this.className='';this.href=undefined;this.textContent='';this.clientWidth=868;this.clientHeight=523;}
    appendChild(child){this.children.push(child);return child;}append(...children){this.children.push(...children);}replaceChildren(...children){this.children=children;}
    addEventListener(type,listener){this.listeners[type]=listener;}setAttribute(name,value){this.attributes[name]=String(value);this[name]=String(value);}removeAttribute(name){delete this.attributes[name];delete this[name];}
    querySelector(){return null;}querySelectorAll(){return [];}
  }
  const task='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e',token='f'.repeat(64),release='navigation-release';
  const clientId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',host='ravilvaliev1999-spec.github.io';let now=2_000_000;
  const rows=[{name:'Существующий документ',section:'Docs',format:'Google Docs',position:0},{name:'Файл отчёта.pdf',section:'Drive',format:'PDF',position:0}];
  const googleUrl='https://docs.google.com/document/d/ExistingDocument123/edit';
  const directUrl='https://drive.google.com/uc?export=download&authuser=owner%40example.com&id=DriveBinaryFile123';
  const directExpiresAt=now+30_000,googleExpiresAt=now+24*60*60*1000,folderUrl='https://drive.google.com/drive/folders/TaskFolderNavigation123';
  const encoder=new TextEncoder();
  const previewKeyDigest=await crypto.webcrypto.subtle.digest('SHA-256',encoder.encode(`notion-widget-preview-key-v1\u0000${task}\u0000${token}`));
  const previewSlotDigest=await crypto.webcrypto.subtle.digest('SHA-256',encoder.encode(`notion-widget-preview-slot-v1\u0000${task}\u0000${token}`));
  const previewKey=await crypto.webcrypto.subtle.importKey('raw',previewKeyDigest,{name:'AES-GCM'},false,['encrypt']);
  const previewIv=crypto.webcrypto.getRandomValues(new Uint8Array(12));
  const previewCipher=await crypto.webcrypto.subtle.encrypt({name:'AES-GCM',iv:previewIv,additionalData:encoder.encode(`notion-widget-preview-v1\u0000${task}\u0000${release}`)},previewKey,encoder.encode(JSON.stringify({schema:1,savedAt:now,materials:rows})));
  const navDomain=`${host}\u0000${task}\u0000${token}\u0000${clientId}`;
  const navKeyDigest=await crypto.webcrypto.subtle.digest('SHA-256',encoder.encode(`notion-widget-navigation-key-v1\u0000${navDomain}`));
  const navSlotDigest=await crypto.webcrypto.subtle.digest('SHA-256',encoder.encode(`notion-widget-navigation-slot-v1\u0000${navDomain}`));
  const navKey=await crypto.webcrypto.subtle.importKey('raw',navKeyDigest,{name:'AES-GCM'},false,['encrypt']);
  const navIv=crypto.webcrypto.getRandomValues(new Uint8Array(12));
  const cardKey=(row)=>JSON.stringify([row.name,row.section,row.format,row.position]);
  const navEntries=[{cardKey:cardKey(rows[0]),kind:'google',url:googleUrl,expiresAt:googleExpiresAt},{cardKey:cardKey(rows[1]),kind:'direct',url:directUrl,expiresAt:directExpiresAt}];
  const sortedRows=[rows[1],rows[0]];
  const navPayload={schema:1,host,task,clientId,savedAt:now,expiresAt:googleExpiresAt,snapshotFingerprint:JSON.stringify(sortedRows),folderUrl,folderExpiresAt:googleExpiresAt,entries:navEntries};
  const navCipher=await crypto.webcrypto.subtle.encrypt({name:'AES-GCM',iv:navIv,additionalData:encoder.encode(`notion-widget-navigation-v1\u0000${navDomain}`)},navKey,encoder.encode(JSON.stringify(navPayload)));
  const previewSlot=`notion-widget-preview-v1:${Buffer.from(previewSlotDigest).subarray(0,18).toString('base64url')}`;
  const navSlot=`notion-widget-navigation-v1:${Buffer.from(navSlotDigest).subarray(0,18).toString('base64url')}`;
  const storage=new Map([
    [`notion-widget-client-v1:${task}`,clientId],
    [previewSlot,JSON.stringify({schema:1,savedAt:now,iv:Buffer.from(previewIv).toString('base64url'),ciphertext:Buffer.from(previewCipher).toString('base64url')})],
    [navSlot,JSON.stringify({schema:1,savedAt:now,expiresAt:googleExpiresAt,iv:Buffer.from(navIv).toString('base64url'),ciphertext:Buffer.from(navCipher).toString('base64url')})]
  ]);
  assert.doesNotMatch(String(storage.get(navSlot)),/ExistingDocument|DriveBinary|docs\.google\.com|drive\.google\.com|f{32}/,'the navigation envelope contains no plaintext URL, id or token');
  const slots=['Drive','Docs','Sheets','Slides'].map((section)=>{const value=new Element();value.dataset.slot=section;return value;});
  const interactionGrid=new Element();interactionGrid.hidden=true;interactionGrid.querySelectorAll=(selector)=>selector==='[data-slot]'?slots:selector==='[data-section]'?slots.flatMap((item)=>item.children):[];
  const snapshotGrid=new Element(),widget=new Element(),fatal=new Element(),listeners={};snapshotGrid.hidden=true;
  const bridgeSource={length:0,frames:[],postMessage(){}};widget.contentWindow={length:1,frames:[bridgeSource]};
  class ClockDate extends globalThis.Date{static now(){return now;}}
  const bodyClasses=new Set(),windowObject={
    crypto:{subtle:crypto.webcrypto.subtle,randomUUID:()=>clientId,getRandomValues(target){return crypto.webcrypto.getRandomValues(target);}},
    localStorage:{get length(){return storage.size;},key(index){return Array.from(storage.keys())[index]||null;},getItem(key){return storage.get(key)||null;},setItem(key,value){storage.set(key,String(value));},removeItem(key){storage.delete(key);}},
    addEventListener(type,listener){listeners[type]=listener;},setTimeout(callback,delay){return{callback,delay};},clearTimeout(){},setInterval(){return 1;}
  };
  vm.runInNewContext(wrapperJs,{window:windowObject,document:{visibilityState:'visible',addEventListener(){},body:{classList:{add(value){bodyClasses.add(value);},toggle(value,force){if(force){bodyClasses.add(value);return true;}bodyClasses.delete(value);return false;},contains(value){return bodyClasses.has(value);}}},
    getElementById(id){return{widget,interactionGrid,snapshotGrid,fatal}[id];},querySelector(){return null;},createElement(tag){return new Element(tag);}},
    location:{protocol:'https:',hostname:host,port:'',hash:`#task=${task}&accessToken=${token}&release=${release}`},URL,URLSearchParams,TextEncoder,TextDecoder,atob,btoa,Uint8Array,Array,Object,String,Number,Boolean,Date:ClockDate,Math,RegExp,Set
  });
  const descendants=(root)=>root.children.flatMap((child)=>[child,...descendants(child)]);
  let savedAnchors=[];
  for(let attempt=0;attempt<40;attempt+=1){savedAnchors=descendants(snapshotGrid).filter((item)=>item.tagName==='A'&&item.className.includes('snapshot-card'));if(savedAnchors.length===2)break;await new Promise((resolve)=>setImmediate(resolve));}
  const googleAnchor=savedAnchors.find((item)=>item.href===googleUrl),directAnchor=savedAnchors.find((item)=>item.href===directUrl);
  assert.ok(googleAnchor,'the confirmed Google card becomes a native anchor before the live iframe');
  assert.ok(directAnchor,'the unexpired binary card uses its exact prepared Drive URL');
  for(const anchor of savedAnchors){assert.equal(anchor.target,'_blank');assert.equal(anchor.rel,'noopener noreferrer');assert.equal(anchor.referrerPolicy,'no-referrer');assert.equal(Object.keys(anchor.listeners).some((name)=>/menu|rename|delete|archive/.test(name)),false);}
  const driveControl=slots.find((item)=>item.dataset.slot==='Drive').children[0];
  assert.equal(driveControl.href,folderUrl,'the exact cached task folder is available read-only');
  const embedNonce=new URL(widget.src).searchParams.get('embedNonce');
  listeners.message({source:bridgeSource,origin:'https://script.googleusercontent.com',data:{type:'notion-widget-v20-bridge-ready',embedNonce,instanceId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',authoritative:false,actionReady:false,snapshotMaterials:rows,geometry:[],viewport:{width:868,height:523}}});
  const staleAnchors=descendants(snapshotGrid).filter((item)=>item.tagName==='A'&&item.className.includes('snapshot-card'));
  assert.equal(staleAnchors.length,2,'a stale bridge preserves independently authenticated read-only anchors');
  assert.equal(driveControl.href,folderUrl);
  assert.equal(storage.has(navSlot),true);
  listeners.message({source:bridgeSource,origin:'https://script.googleusercontent.com',data:{type:'notion-widget-v20-bridge-ready',embedNonce,instanceId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',authoritative:true,actionReady:false,snapshotMaterials:rows,navigationMaterials:[],navigationFolderUrl:'',geometry:[],viewport:{width:868,height:523}}});
  assert.equal(storage.has(navSlot),true,'missing fresh action proof cannot revoke an independent navigation capability');
  assert.equal(driveControl.href,folderUrl);
  now+=31_000;directAnchor.listeners.pointerdown();
  assert.equal(directAnchor.href,undefined,'an expired direct download is synchronously revoked at navigation intent');
  googleAnchor.listeners.pointerdown();assert.equal(googleAnchor.href,googleUrl,'the canonical Google link remains valid within the 24-hour presentation cache');
  listeners.message({source:bridgeSource,origin:'https://script.googleusercontent.com',data:{type:'notion-widget-v20-bridge-ready',embedNonce,instanceId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',authoritative:true,actionReady:true,snapshotMaterials:rows,navigationMaterials:[],navigationFolderUrl:'',preparedCreates:[],geometry:[],viewport:{width:868,height:523}}});
  for(let attempt=0;attempt<30&&storage.has(navSlot);attempt+=1)await new Promise((resolve)=>setImmediate(resolve));
  const postRevokeAnchors=descendants(snapshotGrid).filter((item)=>item.tagName==='A'&&item.className.includes('snapshot-card'));
  assert.equal(postRevokeAnchors.length,0,'an authoritative exact empty navigation snapshot revokes the restored anchors');
  assert.equal(driveControl.href,undefined);
  assert.equal(storage.has(navSlot),false);
});

test('v2 create courier clears the fragment, loads the exact GET rendezvous and validates its result', () => {
  const script=createCourier.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const requestId='55555555-5555-4555-8555-555555555555';
  const service=new URL('https://script.google.com/macros/s/DeploymentIdentifier123456789/exec');
  service.searchParams.set('task','3c62d627-39a1-80a1-aac7-ec19ffc9ef8e');
  service.searchParams.set('accessToken','a'.repeat(64));
  service.searchParams.set('createSection','Docs');
  service.searchParams.set('createRequestId',requestId);
  const encoded=Buffer.from(service.href).toString('base64url');
  const locationObject={
    protocol:'https:',hostname:'ravilvaliev1999-spec.github.io',pathname:'/notion-widgets/create-courier.html',search:'',hash:`#v2=${encoded}`,
    replaced:'',replace(value){this.replaced=value;}
  };
  const runnerSource={length:0,frames:[]};
  const status={textContent:''},runner={removed:false,src:'',remove(){this.removed=true;},setAttribute(){},contentWindow:runnerSource};
  const timers=[];
  const listeners={};
  const windowObject={
    opener:{},
    setTimeout(callback,delay){const timer={callback,delay,cancelled:false};timers.push(timer);return timer;},
    clearTimeout(timer){if(timer)timer.cancelled=true;},
    addEventListener(type,listener){listeners[type]=listener;},
    close(){}
  };
  vm.runInNewContext(script,{
    window:windowObject,document:{getElementById(id){return id==='status'?status:runner;}},location:locationObject,
    history:{replaceState(){locationObject.hash='';}},URL,URLSearchParams,TextDecoder,Uint8Array,Set,Array,Object,String,Number,
    atob,Error,RegExp
  });
  assert.equal(runner.src,service.href);
  assert.equal(locationObject.hash,'');
  listeners.message({source:runnerSource,origin:'https://script.googleusercontent.com',data:{type:'notion-widget-v20-create',requestId:'66666666-6666-4666-8666-666666666666',status:'success',openUrl:'https://docs.google.com/document/d/Wrong/edit'}});
  assert.equal(locationObject.replaced,'');
  listeners.message({source:runnerSource,origin:'https://script.googleusercontent.com',data:{type:'notion-widget-v20-create',requestId,status:'success',openUrl:'https://docs.google.com/document/d/CreatedDocument12345/edit'}});
  assert.equal(locationObject.replaced,'https://docs.google.com/document/d/CreatedDocument12345/edit');
  assert.equal(timers.find((timer)=>timer.delay===180000).cancelled,true);
  assert.doesNotMatch(script,/BroadcastChannel|window\.open\(/);
});
