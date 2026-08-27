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

test('public wrapper isolates Apps Script from multi-login cookies', () => {
  assert.match(wrapper, /<iframe[^>]+id="widget"[^>]+credentialless|<iframe[^>]+credentialless[^>]+id="widget"/);
  assert.match(wrapper, /<iframe[^>]+loading="eager"[^>]+fetchpriority="high"/);
  assert.match(wrapper, /referrerpolicy="no-referrer"/);
  assert.match(wrapper, /j\.src='apps-script-embed\.js\?v=46'/);
  assert.doesNotMatch(wrapper, /<script[^>]+src="apps-script-embed\.js/);
  assert.match(wrapper, /class="skeleton"/);
  assert.match(wrapper, /body\.widget-ready iframe\{opacity:1\}/);
  assert.match(wrapper, /\.widget-action-ready \.skeleton\{opacity:0;visibility:hidden\}/);
  assert.match(wrapper, /class="skeleton-pencil"/);
  assert.doesNotMatch(wrapper, /class="[^"]*chevron/);
});

test('wrapper paints before starting the credentialless Apps Script frame and runtime', () => {
  assert.ok(earlyBootstrap);
  const hash = crypto.createHash('sha256').update(earlyBootstrap).digest('base64');
  assert.match(wrapper, new RegExp(`script-src 'self' 'sha256-${hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));

  const widget = { src: '' };
  const bytes = Uint8Array.from({ length: 16 }, (_value, index) => index + 1);
  const earlyListeners = {};
  const timers = [];
  const frames = [];
  const scripts = [];
  const windowObject = {
    addEventListener(type, listener) { earlyListeners[type] = listener; },
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; }
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
    crypto: { getRandomValues(target) { target.set(bytes); return target; } },
    URL, URLSearchParams, Uint8Array, Array, String
  });
  assert.equal(widget.src, '', 'the nested iframe must not delay the outer iframe load event');
  assert.equal(scripts.length, 0, 'the runtime must not delay the outer iframe load event');
  earlyListeners.load();
  assert.equal(widget.src, '', 'the heavyweight work must wait until Notion can paint the shell');
  assert.equal(frames.length, 1);
  frames[0]();
  assert.equal(frames.length, 2);
  assert.equal(timers.length, 0, 'one paint is not enough to start the nested frame');
  frames[1]();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 0);
  timers[0].callback();
  const earlyUrl = new URL(widget.src);
  assert.equal(earlyUrl.origin, 'https://script.google.com');
  assert.deepEqual(Array.from(earlyUrl.searchParams.keys()).sort(), ['accessToken', 'embedNonce', 'release', 'task']);
  assert.equal(earlyUrl.searchParams.get('embedNonce'), windowObject.__notionWidgetEarlyBridge.nonce);
  assert.match(windowObject.__notionWidgetEarlyBridge.nonce, /^[0-9a-f]{32}$/);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].src, 'apps-script-embed.js?v=46');
  assert.equal(scripts[0].async, true);
  assert.equal(scripts[0].fetchPriority, 'high');
  earlyListeners.message({origin:'https://evil.example',data:{embedNonce:windowObject.__notionWidgetEarlyBridge.nonce}});
  earlyListeners.message({origin:'https://script.googleusercontent.com',data:{embedNonce:windowObject.__notionWidgetEarlyBridge.nonce}});
  assert.equal(windowObject.__notionWidgetEarlyBridge.events.length, 1, 'only the authenticated early Google message is buffered');

  const rejectedWidget = { src: '' }, rejectedTimers = [], rejectedFrames = [], rejectedScripts = [], rejectedListeners = {};
  vm.runInNewContext(earlyBootstrap, {
    window: {
      addEventListener(type, listener) { rejectedListeners[type] = listener; },
      requestAnimationFrame(callback) { rejectedFrames.push(callback); return rejectedFrames.length; },
      setTimeout(callback, delay) { rejectedTimers.push({ callback, delay }); return rejectedTimers.length; }
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
  rejectedListeners.load();
  rejectedFrames[0]();
  rejectedFrames[1]();
  rejectedTimers[0].callback();
  assert.equal(rejectedWidget.src, '');
  assert.equal(rejectedScripts.length, 1, 'the runtime still renders the validation error after first paint');
});

test('wrapper forwards only validated task runtime parameters', () => {
  assert.match(wrapperJs, /location\.hash\.length <= 1/);
  assert.match(wrapperJs, /new URLSearchParams\(location\.hash\.slice\(1\)\)/);
  assert.doesNotMatch(wrapperJs, /location\.search/);
  assert.match(wrapperJs, /\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$/);
  assert.match(wrapperJs, /\^\[A-Za-z0-9\._~-\]\{32,256\}\$/);
  assert.match(wrapperJs, /new URLSearchParams\(\{ task, accessToken, embedNonce \}\)/);
  assert.match(wrapperJs, /const embedNonce = earlyEmbedNonce \|\| randomId\(\)\.replace\(\/-\/g, ''\)/);
  assert.match(wrapperJs, /earlyBridgeEvents = Array\.isArray\(early\.events\) \? early\.events : \[\]/);
  assert.doesNotMatch(wrapperJs, /early\.events\.slice/);
  assert.match(wrapperJs, /if \(widget\.src !== widgetUrl\) widget\.src = widgetUrl/);
  assert.doesNotMatch(wrapperJs, /localStorage|sessionStorage|document\.cookie/);
});

test('wrapper binds one authenticated child channel without relaying local file contents', () => {
  assert.match(wrapperJs, /type === 'notion-widget-v20-bridge-ready'/);
  assert.match(wrapperJs, /bridge = \{ source: event\.source, origin: event\.origin, instanceId: data\.instanceId, authoritative: data\.authoritative === true, actionReady: data\.actionReady === true, folderUrl: allowedDriveFolderUrl\(data\.folderUrl\), preparedCreates:/);
  assert.match(wrapperJs, /if \(bridge\.authoritative && bridge\.actionReady\) document\.body\.classList\.add\('widget-action-ready'\)/);
  assert.doesNotMatch(wrapperJs, /classList\.toggle\('widget-action-ready'/);
  assert.match(wrapperJs, /data\.authoritative === true && data\.actionReady === true \? preparedCreateMap\(data\.preparedCreates\) : \{\}/);
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
  assert.match(wrapperJs, /bridge\.actionReady !== true/);
  assert.doesNotMatch(wrapperJs, /bridge\.actionReady \|\| bridge\.authoritative/);
  assert.match(wrapperJs, /completeCreateRequests\(data\.completedCreateRequestIds\)/);
  assert.match(wrapperJs, /const requestId = rememberedCreateRequest\(section\) \|\| randomId\(\)/);
  assert.match(wrapperJs, /service\.searchParams\.set\('task', params\.get\('task'\)\)/);
  assert.match(wrapperJs, /service\.searchParams\.set\('accessToken', params\.get\('accessToken'\)\)/);
  assert.match(wrapperJs, /service\.searchParams\.set\('createSection', section\)/);
  assert.match(wrapperJs, /service\.searchParams\.set\('createRequestId', requestId\)/);
  assert.match(wrapperJs, /Array\.from\(service\.searchParams\.keys\(\)\)\.length !== 4/);
  assert.match(wrapperJs, /createRequests\.set\(section, record\)/);
  assert.match(wrapperJs, /reservationId: prepared\.reservationId, href: prepared\.openUrl/);
  assert.match(wrapperJs, /if \(record\.reservationId\) message\.reservationId = record\.reservationId/);
  assert.match(wrapperJs, /type === 'notion-widget-v20-primary-started'/);
  assert.match(wrapperJs, /record\.navigationCommitted = true/);
  assert.match(wrapperJs, /const expectedReservationId = prepared && prepared\.reservationId \|\| ''/);
  assert.match(wrapperJs, /record\.ackAttempts < 2 && dispatchCreateAction\(record\)/);
  assert.match(wrapperJs, /data\.retryable === false\) \{ createRequests\.delete\(section\);forgetCreateRequest\(section\);terminalSections\.push\(section\)/);
  assert.match(wrapperJs, /url\.hostname !== 'docs\.google\.com'/);
  assert.match(wrapperJs, /url\.search \|\| url\.hash/);
  assert.match(wrapperJs, /now - record\.lastNavigationAt < 1500/);
  assert.match(wrapperJs, /control\.addEventListener\('auxclick'/);
  assert.match(wrapperJs, /#v2=\$\{encodeCourierFragment\(service\.href\)\}/);
  assert.match(wrapperJs, /type: 'notion-widget-v20-primary-action', section: record\.section, requestId: record\.requestId/);
  assert.doesNotMatch(wrapperJs, /window\.open|BroadcastChannel/);
  assert.match(frontend, /if\(isEmbedBridgeMode\(\)\)return;/);
  assert.match(frontend, /card\.tabIndex=-1/);
  assert.match(frontend, /type:'notion-widget-v20-primary-geometry'/);
  assert.match(frontend, /data\.type==='notion-widget-v20-primary-geometry-request'/);
  assert.match(frontend, /pencilRect=pencil\.getBoundingClientRect\(\)/);
  assert.match(wrapperJs, /window\.setInterval\(runGeometryHeartbeat, 750\)/);
  assert.match(wrapperJs, /Date\.now\(\) - lastGeometryAckAt > 2000/);
  assert.match(wrapperJs, /numbers\[0\] < -tolerance/);
});

test('wrapper runtime exposes validated native create links without opening a popup', () => {
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
  const events = [];
  const bodyClasses = new Set();
  const bridgeSource = { length: 0, frames: [], postMessage(message, origin) { events.push(['post', message, origin]); } };
  widget.contentWindow = { length: 1, frames: [bridgeSource] };
  const windowListeners = {};
  let intervalCallback = null;
  let now = 10000;
  const timeouts=[];
  const windowObject = {
    crypto: { randomUUID: (() => { let index=1;return () => `11111111-1111-4111-8111-${String(index++).padStart(12,'0')}`; })(), getRandomValues() {} },
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
      getElementById(id) { return { widget, interactionGrid, fatal }[id]; },
      createElement(tagName) { const element=new FakeElement();element.tagName=String(tagName).toUpperCase();return element; }
    },
    location: { hash: `#task=3c62d627-39a1-80a1-aac7-ec19ffc9ef8e&accessToken=${'a'.repeat(64)}&release=test` },
    URL,
    URLSearchParams,
    TextEncoder,
    btoa,
    Uint8Array,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Date: { now: () => now },
    Math,
    RegExp
  };
  vm.runInNewContext(wrapperJs, context);

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
      folderUrl: 'https://drive.google.com/drive/folders/TaskFolder12345',
      preparedCreates: [{section:'Docs',reservationId:preparedDocsId,openUrl:preparedDocsUrl}],
      viewport: {width:868,height:523},
      geometry: ['Drive', 'Docs', 'Sheets', 'Slides'].map((section, index) => ({
        section,left:index*220,top:0,width:208,height:70,pencil:{left:index*220+180,top:7,width:22,height:22}
      }))
    }
  });
  assert.equal(bodyClasses.has('widget-ready'), true, 'cached content may render immediately');
  assert.equal(bodyClasses.has('widget-action-ready'), false, 'the full-color safe shell must cover disabled primary cards');
  assert.equal(slots.find((slot)=>slot.dataset.slot==='Docs').children[0].href, undefined, 'cached bootstrap must not enable creation');
  windowListeners.message({
    source: bridgeSource,
    origin,
    data: {
      type: 'notion-widget-v20-bridge-ready',
      embedNonce,
      instanceId: '33333333-3333-4333-8333-333333333333',
      authoritative: true,
      actionReady: true,
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
    actionReady:true,folderUrl:'https://drive.google.com/drive/folders/TaskFolder12345',preparedCreates:[{section:'Docs',reservationId:nextPreparedDocsId,openUrl:nextPreparedDocsUrl},{section:'Slides',reservationId:preparedSlidesId,openUrl:preparedSlidesUrl}],
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
    actionReady:true,folderUrl:'https://drive.google.com/drive/folders/TaskFolder12345',completedCreateRequestIds:[preparedDocsId],
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
