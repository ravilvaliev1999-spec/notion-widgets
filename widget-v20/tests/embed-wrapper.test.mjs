import assert from 'node:assert/strict';
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

test('public wrapper isolates Apps Script from multi-login cookies', () => {
  assert.match(wrapper, /<iframe[^>]+id="widget"[^>]+credentialless|<iframe[^>]+credentialless[^>]+id="widget"/);
  assert.match(wrapper, /referrerpolicy="no-referrer"/);
  assert.match(wrapper, /script src="apps-script-embed\.js\?v=38"/);
  assert.match(wrapper, /class="skeleton"/);
  assert.match(wrapper, /body\.widget-ready iframe\{opacity:1\}/);
});

test('wrapper forwards only validated task runtime parameters', () => {
  assert.match(wrapperJs, /location\.hash\.length <= 1/);
  assert.match(wrapperJs, /new URLSearchParams\(location\.hash\.slice\(1\)\)/);
  assert.doesNotMatch(wrapperJs, /location\.search/);
  assert.match(wrapperJs, /\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$/);
  assert.match(wrapperJs, /\^\[A-Za-z0-9\._~-\]\{32,256\}\$/);
  assert.match(wrapperJs, /new URLSearchParams\(\{ task, accessToken, embedNonce \}\)/);
  assert.doesNotMatch(wrapperJs, /localStorage|sessionStorage|document\.cookie/);
});

test('wrapper binds one authenticated child channel without relaying local file contents', () => {
  assert.match(wrapperJs, /type === 'notion-widget-v20-bridge-ready'/);
  assert.match(wrapperJs, /bridge = \{ source: event\.source, origin: event\.origin, instanceId: data\.instanceId, authoritative: data\.authoritative === true, actionReady: data\.actionReady === true, folderUrl: allowedDriveFolderUrl\(data\.folderUrl\) \}/);
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
  assert.match(wrapperJs, /const existing = createRequests\.get\(section\)/);
  assert.match(wrapperJs, /completeCreateRequests\(data\.completedCreateRequestIds\)/);
  assert.match(wrapperJs, /const requestId = rememberedCreateRequest\(section\) \|\| randomId\(\)/);
  assert.match(wrapperJs, /service\.searchParams\.set\('task', params\.get\('task'\)\)/);
  assert.match(wrapperJs, /service\.searchParams\.set\('accessToken', params\.get\('accessToken'\)\)/);
  assert.match(wrapperJs, /service\.searchParams\.set\('createSection', section\)/);
  assert.match(wrapperJs, /service\.searchParams\.set\('createRequestId', requestId\)/);
  assert.match(wrapperJs, /Array\.from\(service\.searchParams\.keys\(\)\)\.length !== 4/);
  assert.match(wrapperJs, /createRequests\.set\(section, record\)/);
  assert.match(wrapperJs, /now - record\.lastNavigationAt < 1500/);
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
  const bridgeSource = { length: 0, frames: [], postMessage(message, origin) { events.push(['post', message, origin]); } };
  widget.contentWindow = { length: 1, frames: [bridgeSource] };
  const windowListeners = {};
  let intervalCallback = null;
  let now = 10000;
  const windowObject = {
    crypto: { randomUUID: (() => { let index=1;return () => `11111111-1111-4111-8111-${String(index++).padStart(12,'0')}`; })(), getRandomValues() {} },
    addEventListener(type, listener) { windowListeners[type] = listener; },
    setTimeout() { return 1; },
    setInterval(callback) { intervalCallback=callback; return 2; },
    clearTimeout() {}
  };
  const context = {
    window: windowObject,
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      body: { classList: { add(value) { events.push(['class',value]); } } },
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
  assert.match(docsPrimary.href,/^https:\/\/ravilvaliev1999-spec\.github\.io\/notion-widgets\/create-courier\.html#v2=[A-Za-z0-9_-]+$/);
  const encoded=docsPrimary.href.split('#v2=')[1];
  const padded=encoded.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-encoded.length%4)%4);
  const service=new URL(Buffer.from(padded,'base64').toString('utf8'));
  assert.equal(service.origin,'https://script.google.com');
  assert.deepEqual(Array.from(service.searchParams.keys()).sort(),['accessToken','createRequestId','createSection','task']);
  assert.equal(service.searchParams.get('task'),'3c62d627-39a1-80a1-aac7-ec19ffc9ef8e');
  assert.equal(service.searchParams.get('accessToken'),'a'.repeat(64));
  assert.equal(service.searchParams.get('createSection'),'Docs');
  assert.match(service.searchParams.get('createRequestId'),/^[0-9a-f-]{36}$/);
  assert.equal(primaryAction[1].requestId,service.searchParams.get('createRequestId'));
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
    type:'notion-widget-v20-primary-result',embedNonce,requestId:service.searchParams.get('createRequestId'),ok:false,message:'temporary failure'
  }});
  docsPrimary.listeners.click({preventDefault(){throw new Error('a failed warm action must allow one native recovery navigation');}});
  assert.equal(docsPrimary.href,firstCreateHref,'a recovery click must retain the original idempotency key');
  const recoveryActions=events.filter((entry)=>entry[0]==='post'&&entry[1].type==='notion-widget-v20-primary-action');
  assert.equal(recoveryActions.length,2,'a reported warm-action failure must unlock exactly one retry');
  assert.equal(recoveryActions[1][1].requestId,service.searchParams.get('createRequestId'),'the retry must reuse the same request id');
  windowListeners.message({source:bridgeSource,origin,data:{
    type:'notion-widget-v20-bridge-ready',embedNonce,instanceId:'33333333-3333-4333-8333-333333333333',authoritative:true,
    actionReady:true,folderUrl:'https://drive.google.com/drive/folders/TaskFolder12345',completedCreateRequestIds:[service.searchParams.get('createRequestId')],
    viewport:{width:868,height:523},geometry:['Drive','Docs','Sheets','Slides'].map((section,index)=>({section,left:index*220,top:0,width:208,height:70,pencil:{left:index*220+180,top:7,width:22,height:22}}))
  }});
  assert.notEqual(docsPrimary.href,firstCreateHref,'a confirmed knowledge must release the key for the next intentional create');
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
