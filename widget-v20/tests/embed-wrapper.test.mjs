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

test('public wrapper isolates Apps Script from multi-login cookies', () => {
  assert.match(wrapper, /<iframe[^>]+id="widget"[^>]+credentialless|<iframe[^>]+credentialless[^>]+id="widget"/);
  assert.match(wrapper, /referrerpolicy="no-referrer"/);
  assert.match(wrapper, /script src="apps-script-embed\.js"/);
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
  assert.match(wrapperJs, /bridge = \{ source: event\.source, origin: event\.origin, instanceId: data\.instanceId \}/);
  assert.match(wrapperJs, /bridge\.source\.postMessage\(Object\.assign\(\{\}, message, \{ embedNonce \}\), bridge\.origin\)/);
  assert.doesNotMatch(wrapperJs, /postMessage\([^\n]+, '\*'\)/);
  assert.doesNotMatch(wrapperJs, /type: 'notion-widget-v20-upload-files'|\bFile\b|dataBase64/);
  assert.match(frontend, /event\.origin===EMBED_BRIDGE_ORIGIN&&isBoundedAncestor\(event\.source\)/);
  assert.match(frontend, /data\.embedNonce===embedNonce/);
  assert.match(frontend, /chooseFiles\(upload\.dataset\.uploadSection\)/);
  assert.match(frontend, /\$\('fileInput'\)\.addEventListener\('change'/);
});

test('credentialless create uses a synchronous wrapper-owned popup', () => {
  assert.match(wrapper, /class="interaction-slot" data-slot="Docs"/);
  assert.match(wrapper, /primary-control-pencil-top/);
  assert.match(wrapper, /primary-control-pencil-bottom/);
  assert.match(wrapperJs, /\['main', 'pencil-top', 'pencil-right', 'pencil-bottom'\]/);
  assert.match(wrapperJs, /const pencilLeft=Number\(row\.pencil\.left\)-left,pencilTop=Number\(row\.pencil\.top\)-top/);
  assert.match(wrapperJs, /\{left:pencilRight,top:pencilTop,width:width-pencilRight,height:pencilHeight\}/);
  assert.match(wrapperJs, /const popup = window\.open\('about:blank', '_blank'\)/);
  assert.match(wrapperJs, /type: 'notion-widget-v20-primary-action'/);
  assert.match(wrapperJs, /record\.popup\.location\.replace\(data\.openUrl\)/);
  assert.match(wrapperJs, /existing \? existing\.message\.requestId : randomId\(\)/);
  assert.match(wrapperJs, /410000/);
  assert.match(frontend, /data\.type==='notion-widget-v20-primary-action'/);
  assert.match(frontend, /createGoogle\(data\.section,\{source:event\.source,origin:event\.origin,requestId:data\.requestId\}\)/);
  assert.match(frontend, /type:'notion-widget-v20-primary-result'/);
  assert.match(frontend, /if\(isEmbedBridgeMode\(\)\)return;/);
  assert.match(frontend, /card\.tabIndex=-1/);
  assert.match(frontend, /type:'notion-widget-v20-primary-geometry'/);
  assert.match(frontend, /pencilRect=pencil\.getBoundingClientRect\(\)/);
});

test('wrapper runtime opens the placeholder before sending one authenticated create request', () => {
  class FakeElement {
    constructor() {
      this.children = [];
      this.dataset = {};
      this.listeners = {};
      this.style = {};
      this.hidden = false;
      this.disabled = false;
      this.textContent = '';
    }
    appendChild(child) { this.children.push(child); return child; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    setAttribute(name, value) { this[name] = value; }
  }

  const slots = ['Drive', 'Docs', 'Sheets', 'Slides'].map((section) => {
    const slot = new FakeElement();
    slot.dataset.slot = section;
    return slot;
  });
  const widget = new FakeElement();
  const interactionGrid = new FakeElement();
  interactionGrid.hidden = true;
  interactionGrid.querySelectorAll = (selector) => {
    if (selector === '[data-slot]') return slots;
    const section = selector.match(/^\[data-section="([A-Za-z]+)"\]$/)?.[1];
    return section ? slots.flatMap((slot) => slot.children).filter((control) => control.dataset.section === section) : [];
  };
  const fatal = new FakeElement();
  fatal.hidden = true;
  const events = [];
  const popup = {
    opener: {},
    closed: false,
    document: { open() {}, write() {}, close() {} },
    location: { replace(url) { events.push(['navigate', url]); } },
    close() { this.closed = true; }
  };
  const bridgeSource = { length: 0, frames: [], postMessage(message, origin) { events.push(['post', message, origin]); } };
  widget.contentWindow = { length: 1, frames: [bridgeSource] };
  const windowListeners = {};
  const windowObject = {
    crypto: { randomUUID: (() => {
      const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
      return () => ids.shift();
    })(), getRandomValues() {} },
    addEventListener(type, listener) { windowListeners[type] = listener; },
    open() { events.push(['open']); return popup; },
    setTimeout() { return 1; },
    clearTimeout() {}
  };
  const context = {
    window: windowObject,
    document: {
      getElementById(id) { return { widget, interactionGrid, fatal }[id]; },
      createElement() { return new FakeElement(); }
    },
    location: { hash: `#task=3c62d627-39a1-80a1-aac7-ec19ffc9ef8e&accessToken=${'a'.repeat(64)}&release=test` },
    URL,
    URLSearchParams,
    Uint8Array,
    Array,
    Object,
    String,
    Number,
    Boolean,
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
  const docsSlot = slots.find((slot) => slot.dataset.slot === 'Docs');
  assert.equal(docsSlot.style.left, '220px');
  assert.equal(docsSlot.style.height, '70px');
  assert.equal(docsSlot.children[0].style.width, '180px');
  assert.equal(docsSlot.children[1].style.height, '7px');
  assert.equal(docsSlot.children[2].style.left, '202px');
  assert.equal(docsSlot.children[3].style.top, '29px');

  const docsPrimary = docsSlot.children[0];
  docsPrimary.listeners.click();
  assert.equal(events[0][0], 'open');
  assert.equal(events[1][0], 'post');
  assert.equal(events[1][1].type, 'notion-widget-v20-primary-action');
  assert.equal(events[1][1].embedNonce, embedNonce);
  assert.equal(events[1][2], origin);

  windowListeners.message({
    source: bridgeSource,
    origin,
    data: {
      type: 'notion-widget-v20-primary-result',
      requestId: events[1][1].requestId,
      embedNonce,
      ok: true,
      openUrl: 'https://docs.google.com/document/d/exact-file-id/edit'
    }
  });
  assert.deepEqual(events[2], ['navigate', 'https://docs.google.com/document/d/exact-file-id/edit']);
  assert.equal(popup.opener, null);
});
