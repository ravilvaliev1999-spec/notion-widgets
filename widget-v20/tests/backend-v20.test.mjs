import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreSource = fs.readFileSync(path.join(root, 'Core.js'), 'utf8');
const backendSource = fs.readFileSync(path.join(root, 'Code.gs'), 'utf8');
const registrySource = fs.readFileSync(path.join(root, 'Registry.gs'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'appsscript.json'), 'utf8'));

function loadCore() {
  const context = vm.createContext({ Object, String, RegExp, Error, Number, Boolean, Math, encodeURIComponent, decodeURIComponent });
  vm.runInContext(coreSource, context, { filename: 'Core.js' });
  return context.WidgetV19Core;
}

function loadBackend(activeEmail = '') {
  const core = loadCore();
  const defaultProperties = new Map();
  const defaultScriptProperties = {
    getProperty: (key) => defaultProperties.get(key) ?? null,
    setProperty: (key, value) => { defaultProperties.set(key, String(value)); },
    deleteProperty: (key) => { defaultProperties.delete(key); },
    getProperties: () => Object.fromEntries(defaultProperties),
    setProperties: (values) => Object.entries(values || {}).forEach(([key, value]) => defaultProperties.set(key, String(value)))
  };
  const context = vm.createContext({
    Object,
    String,
    RegExp,
    Error,
    Number,
    Boolean,
    Math,
    Date,
    JSON,
    Array,
    isFinite,
    encodeURIComponent,
    console: { log() {} },
    WidgetV19Core: core,
    Session: { getActiveUser: () => ({ getEmail: () => activeEmail }) },
    PropertiesService: { getScriptProperties: () => defaultScriptProperties },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }),
      getUserLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} })
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      getUuid: () => crypto.randomUUID(),
      newBlob: (value) => ({ getBytes: () => [...Buffer.from(String(value), 'utf8')] }),
      computeDigest: (_algorithm, bytes) => [...crypto.createHash('sha256').update(Buffer.from(bytes)).digest()],
      computeHmacSha256Signature: (value, key) => [...crypto.createHmac('sha256', String(key)).update(String(value)).digest()]
    }
  });
  vm.runInContext(backendSource, context, { filename: 'Code.gs' });
  vm.runInContext(registrySource, context, { filename: 'Registry.gs' });
  return context;
}

test('Google Drive metadata is authoritative for title, type and canonical open URL', () => {
  const core = loadCore();
  const doc = core.describeGoogleMetadata({
    id: 'ABCDEFGHIJKL',
    name: 'Истинное имя документа',
    mimeType: 'application/vnd.google-apps.document',
    webViewLink: 'https://docs.google.com/document/d/ABCDEFGHIJKL/edit'
  }, 'https://drive.google.com/open?id=ABCDEFGHIJKL');
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), {
    id: 'ABCDEFGHIJKL',
    name: 'Истинное имя документа',
    mimeType: 'application/vnd.google-apps.document',
    section: 'Docs',
    format: 'Google Docs',
    provider: 'Google Drive',
    knowledgeFormat: 'Файл',
    sourceUrl: 'https://docs.google.com/document/d/ABCDEFGHIJKL/edit',
    normalizedUrl: 'https://docs.google.com/document/d/ABCDEFGHIJKL/edit',
    size: null,
    driveMd5: ''
  });

  const word = core.describeGoogleMetadata({
    id: 'MNOPQRSTUVWX',
    name: 'Техническое задание.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: '2048',
    md5Checksum: 'abc',
    webViewLink: 'https://docs.google.com/document/d/MNOPQRSTUVWX/edit'
  });
  assert.equal(word.section, 'Docs');
  assert.equal(word.format, 'Word');
  assert.equal(word.size, 2048);
  assert.equal(word.driveMd5, 'abc');

  const excel = core.describeGoogleMetadata({
    id: 'EXCELFILE123',
    name: 'Финансы.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    webViewLink: 'https://docs.google.com/spreadsheets/d/EXCELFILE123/edit'
  });
  assert.equal(excel.section, 'Sheets');
  assert.equal(excel.format, 'Excel');

  const powerPoint = core.describeGoogleMetadata({
    id: 'POWERPOINT123',
    name: 'Презентация.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    webViewLink: 'https://docs.google.com/presentation/d/POWERPOINT123/edit'
  });
  assert.equal(powerPoint.section, 'Slides');
  assert.equal(powerPoint.format, 'PowerPoint');
});

test('Google folders fall back to a real folder URL and stay in Drive', () => {
  const core = loadCore();
  const folder = core.describeGoogleMetadata({
    id: 'ABCDEFGHIJKL',
    name: 'Проект',
    mimeType: 'application/vnd.google-apps.folder'
  });
  assert.equal(folder.section, 'Drive');
  assert.equal(folder.sourceUrl, 'https://drive.google.com/drive/folders/ABCDEFGHIJKL');
});

test('capability auth requires both the stored hash and the exact authorized task', () => {
  const token = 'capability_token_0123456789_ABCDEFGH';
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const task = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const cfg = {
    allowedEmail: 'owner@example.com',
    accessTokenHash: tokenHash,
    authorizedTaskPageId: task
  };
  const anonymous = loadBackend('');
  assert.equal(anonymous.w19AssertViewer_(cfg, { taskPageId: task, accessToken: token }), 'capability');
  assert.throws(
    () => anonymous.w19AssertViewer_(cfg, { taskPageId: '3ae2d627-39a1-80ad-b49c-e028699b75d9', accessToken: token }),
    (error) => error && error.code === 'AUTH_REQUIRED'
  );
  assert.throws(
    () => anonymous.w19AssertViewer_(cfg, { taskPageId: task, accessToken: 'wrong_token_0123456789_ABCDEFGHIJ' }),
    (error) => error && error.code === 'AUTH_REQUIRED'
  );
});

test('confirmed owner identity remains an independent authorization path', () => {
  const owner = loadBackend('owner@example.com');
  assert.equal(owner.w19AssertViewer_({ allowedEmail: 'owner@example.com' }, {}), 'owner');
});

test('every public data API authenticates the same input payload', () => {
  for (const name of [
    'apiBootstrap', 'apiCreateGoogle', 'apiGetCreateStatus', 'apiWarmCreateContext', 'apiAddLink', 'apiUpload', 'apiUpdateMaterial',
    'apiReorder', 'apiDeletePhysical', 'apiPrepareDownload', 'apiDownload', 'apiPollDriveMetadata', 'apiSyncTask', 'w19SetArchiveState_'
  ]) {
    const start = backendSource.indexOf(`function ${name}`);
    assert.notEqual(start, -1, `${name} must exist`);
    const next = backendSource.indexOf('\nfunction ', start + 10);
    const body = backendSource.slice(start, next === -1 ? backendSource.length : next);
    assert.match(body, /w19AuthorizedConfig_\(input\)/, `${name} must authenticate input`);
  }
  assert.match(backendSource, /taskMatches\s*&&\s*tokenMatches/);
  assert.doesNotMatch(backendSource, /w19Audit_\([^\n]+accessToken/);
});

test('web app routes download and create requests to dedicated couriers', () => {
  const doGet = backendSource.slice(backendSource.indexOf('function doGet'), backendSource.indexOf('/* ========================= Public client API'));
  assert.match(doGet, /event && event\.parameter/);
  assert.match(doGet, /params\.downloadPageId \|\| params\.downloadTicket/);
  assert.match(doGet, /createTemplateFromFile\('Download'\)/);
  assert.match(doGet, /template\.runtimeParamsJson = JSON\.stringify/);
  assert.match(doGet, /task:\s*String\(params\.task \|\| params\.taskPageId/);
  assert.match(doGet, /downloadPageId:\s*String\(params\.downloadPageId/);
  assert.match(doGet, /output = template\.evaluate\(\)/);
  assert.match(doGet, /precomputedResultJson = 'null'/);
  assert.match(doGet, /params\.createSection \|\| params\.createRequestId/);
  assert.match(doGet, /createTemplateFromFile\('Create'\)/);
  assert.match(doGet, /createSection:\s*String\(params\.createSection/);
  assert.match(doGet, /createRequestId:\s*String\(params\.createRequestId/);
  assert.match(doGet, /output = createTemplate\.evaluate\(\)/);
  assert.match(doGet, /createHtmlOutputFromFile\('Index'\)/);
  assert.match(doGet, /XFrameOptionsMode\.ALLOWALL/);
  assert.match(doGet, /function doPost\(event\)/);
  assert.match(doGet, /w20CreatePostFields_\(event\)/);
  assert.match(doGet, /template\.runtimeParamsJson = '\{\}'/);
  assert.match(doGet, /template\.precomputedResultJson = JSON\.stringify\(result\)/);
});

test('create POST accepts exactly four form fields, executes once and embeds only a safe precomputed result', () => {
  const backend = loadBackend();
  const task='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e',requestId='12345678-1234-4abc-8def-1234567890ab';
  const accessToken='capability_token_0123456789_ABCDEFGH';
  const rendered=[];
  const output={setTitle(){return this;},setXFrameOptionsMode(){return this;},addMetaTag(){return this;}};
  backend.HtmlService={
    XFrameOptionsMode:{ALLOWALL:'ALLOWALL'},
    createTemplateFromFile(name){
      assert.equal(name,'Create');
      const template={evaluate(){rendered.push({runtime:template.runtimeParamsJson,result:template.precomputedResultJson});return output;}};
      return template;
    }
  };
  let calls=0,received;
  backend.apiCreateGoogle=(input)=>{calls+=1;received=input;return {ok:true,data:{material:{openUrl:'https://docs.google.com/document/d/CreatedFile12345/edit',googleFileId:'CreatedFile12345',provider:'Google Drive',format:'Google Docs',section:'Docs',secret:'not-for-client'},internal:'hidden'}};};
  const event={
    parameters:{task:[task],accessToken:[accessToken],createSection:['Docs'],createRequestId:[requestId]},
    postData:{type:'application/x-www-form-urlencoded'}
  };
  assert.equal(backend.doPost(event),output);
  assert.equal(calls,1);
  assert.deepEqual(JSON.parse(JSON.stringify(received)),{taskPageId:task,accessToken,section:'Docs',idempotencyKey:requestId});
  assert.equal(rendered[0].runtime,'{}');
  const safe=JSON.parse(rendered[0].result);
  assert.deepEqual(safe,{requestId,status:'success',openUrl:'https://docs.google.com/document/d/CreatedFile12345/edit'});
  assert.doesNotMatch(rendered[0].result,/capability|secret|internal|accessToken/i);

  backend.doPost({...event,parameters:{...event.parameters,extra:['forbidden']}});
  assert.equal(calls,1,'an extra field must fail before create');
  assert.equal(JSON.parse(rendered[1].result).status,'error');
  backend.doPost({...event,parameters:{...event.parameters,task:[task,task]}});
  assert.equal(calls,1,'a duplicate field must fail before create');
  backend.doPost({...event,postData:{type:'application/json'}});
  assert.equal(calls,1,'a non-form body must fail before create');
  backend.doPost({...event,queryString:'task=must-not-be-in-url'});
  assert.equal(calls,1,'POST courier fields must not arrive in the query string');
});

test('concurrent create POST briefly recovers the completed registry result and otherwise reports pending without duplicating', () => {
  const backend = loadBackend();
  const task='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e',requestId='12345678-1234-4abc-8def-1234567890ab';
  const fields={valid:true,taskPageId:task,accessToken:'A'.repeat(48),section:'Docs',requestId};
  const response={ok:false,error:{code:'OPERATION_IN_PROGRESS',message:'already running'}};
  backend.Utilities.sleep=()=>{};
  let reads=0;
  backend.w20RegistryFindCreateRequest_=()=>{reads+=1;return reads===3?{openUrl:'https://docs.google.com/document/d/CreatedFile12345/edit',googleFileId:'CreatedFile12345',provider:'Google Drive',format:'Google Docs',section:'Docs'}:null;};
  assert.deepEqual(
    JSON.parse(JSON.stringify(backend.w20RecoverConcurrentCreatePost_(fields,response))),
    {requestId,status:'success',openUrl:'https://docs.google.com/document/d/CreatedFile12345/edit'}
  );
  assert.equal(reads,3);
  backend.w20RegistryFindCreateRequest_=()=>null;
  const pending=backend.w20RecoverConcurrentCreatePost_(fields,response);
  assert.equal(pending.status,'pending');
  assert.equal(pending.requestId,requestId);
  assert.match(pending.message,/Дубликат не будет создан/);
});

test('bootstrap returns the current deployment URL instead of hard-coding one', () => {
  const bootstrap = backendSource.slice(backendSource.indexOf('function apiBootstrap'), backendSource.indexOf('function apiCreateGoogle'));
  assert.match(bootstrap, /serviceUrl:\s*ScriptApp\.getService\(\)\.getUrl\(\)/);
  assert.doesNotMatch(bootstrap, /script\.google\.com\/macros\/s\//);
});

test('bootstrap falls back to the durable registry only for transient Notion transport failures', () => {
  const backend = loadBackend();
  const cfg = { authorizedTaskPageId: '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e', deniedPageIds: {} };
  backend.w19AuthorizedConfig_ = () => cfg;
  backend.w19AssertSchema_ = () => { throw new backend.W19Error_('GOOGLE_URLFETCH_QUOTA', 'quota', true); };
  backend.w20BootstrapFromRegistry_ = (_input, receivedCfg, reason) => ({ degraded: true, code: reason.code, sameCfg: receivedCfg === cfg });
  const fallback = backend.apiBootstrap({ taskPageId: cfg.authorizedTaskPageId, forceRefresh: true });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.data.degraded, true);
  assert.equal(fallback.data.code, 'GOOGLE_URLFETCH_QUOTA');
  assert.equal(fallback.data.sameCfg, true);

  backend.w19AssertSchema_ = () => { throw new backend.W19Error_('NOTION_FORBIDDEN', 'forbidden', false); };
  const forbidden = backend.apiBootstrap({ taskPageId: cfg.authorizedTaskPageId, forceRefresh: true });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error.code, 'NOTION_FORBIDDEN');
});

test('cached bootstrap paints safe registry cards without Notion or Drive calls', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-8120-bd0a-f969e6846945';
  const values = {};
  const props = {
    getProperties: () => ({...values}),
    getProperty: (key) => values[key] || null,
    setProperty: (key,value) => { values[key]=String(value); },
    setProperties: (next) => { Object.assign(values,next); },
    deleteProperty: (key) => { delete values[key]; }
  };
  backend.PropertiesService = { getScriptProperties: () => props };
  backend.ScriptApp = { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/abcdefghijklmnopqrstuvwxyz0123456789_-AB/exec' }) };
  backend.w20RegistryReplaceTask_(taskId,[{
    id:pageId,name:'Быстрая карточка',section:'Docs',format:'Google Docs',provider:'Google Drive',
    openUrl:'https://docs.google.com/document/d/NativeGoogleDoc123/edit',googleFileId:'NativeGoogleDoc123',folderId:'TaskFolder12345',widgetOwned:true,position:0,syncStatus:'synced'
  }]);
  backend.w20RegistryWriteTaskMeta_(taskId,{taskName:'Задача',folderId:'TaskFolder12345'});
  backend.w19AuthorizedConfig_ = () => ({authorizedTaskPageId:taskId,deniedPageIds:{},maxUploadBytes:8388608});
  for (const name of ['w19AssertSchema_','w19AssertTaskPage_','w19QueryTaskMaterials_','w19EnsureTaskFolder_']) backend[name]=()=>{throw new Error(`${name} must not run`);};
  const result=backend.apiBootstrap({taskPageId:taskId});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.data.cached,true);
  assert.equal(result.data.authoritative,false);
  assert.equal(result.data.materials.length,1);
  assert.equal(result.data.materials[0].name,'Быстрая карточка');
  assert.equal(result.data.materials[0].openUrl,undefined);
  assert.equal(result.data.materials[0].googleFileId,undefined);
  assert.equal(result.data.folderUrl,null);
});

test('interactive bootstrap and list refresh defer per-file Drive metadata sync', () => {
  const bootstrap = backendSource.slice(backendSource.indexOf('function apiBootstrap'), backendSource.indexOf('function apiCreateGoogle'));
  const sync = backendSource.slice(backendSource.indexOf('function apiSyncTask'), backendSource.indexOf('/* ========================= Admin-only setup'));
  assert.doesNotMatch(bootstrap,/w19SyncPageList_/);
  assert.doesNotMatch(sync,/w19SyncPageList_/);
  assert.match(bootstrap,/input && input\.forceRefresh === true/);
});

test('client materials expose only the create request id, never the canonical idempotency key', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const requestId = '11111111-1111-4111-8111-111111111111';
  backend.w20IssueDrivePollClaim_ = () => 'claim';
  const material = backend.w20MaterialForClient_({
    id: '3c72d627-39a1-4120-8d0a-f969e6846945',
    provider: 'Google Drive',
    googleFileId: 'NativeGoogleDoc123',
    format: 'Google Docs',
    section: 'Docs',
    archived: false,
    syncStatus: 'synced',
    idempotency: `${backend.WidgetV19Core.compactUuid(taskId)}|create-google-Docs|${requestId}`
  }, taskId, {});
  assert.equal(material.createRequestId, requestId);
  assert.equal(material.idempotency, undefined);
  assert.doesNotMatch(JSON.stringify(material), /create-google-Docs|3c62d62739a180a1aac7ec19ffc9ef8e/);
  const physicalDelete = backendSource.slice(backendSource.indexOf('function apiDeletePhysical'), backendSource.indexOf('function apiPrepareDownload'));
  const archiveState = backendSource.slice(backendSource.indexOf('function w19SetArchiveState_'), backendSource.indexOf('function w19Audit_'));
  assert.doesNotMatch(physicalDelete, /return \{ material: material,/);
  assert.doesNotMatch(physicalDelete, /return \{ material: w19MaterialFromPage_\(updated\),/);
  assert.match(physicalDelete, /w20MaterialForClient_\(material, task\.id, cfg\)/);
  assert.match(physicalDelete, /w20MaterialForClient_\(w19MaterialFromPage_\(updated\), task\.id, cfg\)/);
  assert.doesNotMatch(archiveState, /return \{ material: material,/);
  assert.match(archiveState, /w20MaterialForClient_\(material, task\.id, cfg\)/);
});

test('repeated Docs creation with one request id executes the document creation once', () => {
  const backend = loadBackend();
  const values = {};
  const props = {
    getProperty: (key) => values[key] || null,
    setProperty: (key, value) => { values[key] = String(value); }
  };
  const lock = { tryLock: () => true, waitLock() {}, releaseLock() {} };
  backend.PropertiesService = { getScriptProperties: () => props };
  backend.LockService = { getScriptLock: () => lock };
  let uuidIndex = 0;
  backend.Utilities.getUuid = () => `attempt-${uuidIndex += 1}`;
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const requestId = '11111111-1111-4111-8111-111111111111';
  const canonical = backend.w19CanonicalIdempotency_(taskId, 'create-google-Docs', requestId);
  let documentsCreated = 0;
  const create = () => backend.w19WithIdempotency_(canonical, () => ({ documentId: `doc-${documentsCreated += 1}` }));
  assert.equal(create().documentId, 'doc-1');
  assert.equal(create().documentId, 'doc-1');
  assert.equal(documentsCreated, 1);
});

test('fresh Google creation uses exactly one Drive CREATE and one Notion CREATE from authoritative registry state', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const existingPageId = '3c72d627-39a1-8120-bd0a-f969e6846945';
  const createdPageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const requestId = '11111111-1111-4111-8111-111111111111';
  const values = {};
  const props = {
    getProperty: (key) => Object.prototype.hasOwnProperty.call(values,key) ? values[key] : null,
    getProperties: () => ({...values}),
    setProperty: (key,value) => { values[key]=String(value); },
    setProperties: (next) => { Object.assign(values,next); },
    deleteProperty: (key) => { delete values[key]; }
  };
  const scriptLock = { tryLock: () => true, waitLock() {}, releaseLock() {} };
  let userLockCalls = 0;
  backend.PropertiesService = { getScriptProperties: () => props };
  backend.LockService = {
    getScriptLock: () => scriptLock,
    getUserLock: () => { userLockCalls += 1; throw new Error('hot path must not acquire UserLock'); }
  };
  let uuidIndex = 0;
  backend.Utilities.getUuid = () => `attempt-${uuidIndex += 1}`;
  backend.Utilities.formatDate = () => '2026-08-26 21:00';
  backend.w20RegistryReplaceTask_(taskId,[{
    id:existingPageId,name:'Существующий документ',section:'Docs',format:'Google Docs',provider:'Google Drive',
    openUrl:'https://docs.google.com/document/d/ExistingGoogleDoc123/edit',googleFileId:'ExistingGoogleDoc123',
    folderId:'TaskFolder12345',widgetOwned:true,position:7,syncStatus:'synced'
  }]);
  backend.w20RegistryWriteTaskMeta_(taskId,{
    taskName:'Задача',folderId:'TaskFolder12345',rootFolderId:'RootFolder12345',folderVerified:true,
    folderValidatedAt:new Date().toISOString(),
    context:{path:'Основная / Задача',ancestorIds:'ancestor',depth:2,sphereIds:[],directionIds:[],projectIds:[]}
  });
  const cfg={authorizedTaskPageId:taskId,deniedPageIds:{},dataSourceId:'3822d627-39a1-8018-a2dc-000b95bf5722',notionToken:'server-only',rootFolderId:'RootFolder12345'};
  backend.w19AuthorizedConfig_=()=>cfg;
  for (const name of [
    'w19AssertSchema_','w19AssertTaskPage_','w19FindMaterialByIdempotency_','w19EnsureTaskFolder_',
    'w19FindDriveByIdempotency_','w19FindMaterialByGoogleFile_','w19NextPosition_',
    'w19MarkDriveNotionPage_','w19WithMutationLock_'
  ]) backend[name]=()=>{throw new Error(`${name} must not run on the hot path`);};

  let driveCreates=0;
  backend.w19CreateGoogleFile_=(_task,folderId,section,name)=>{
    driveCreates += 1;
    assert.equal(folderId,'TaskFolder12345');
    assert.equal(section,'Docs');
    return {id:'CreatedGoogleDoc123',name,mimeType:'application/vnd.google-apps.document',webViewLink:'https://docs.google.com/document/d/CreatedGoogleDoc123/edit'};
  };
  let notionCreates=0;
  let notionBody=null;
  backend.w19NotionRequest_=(method,requestPath,body)=>{
    notionCreates += 1;
    assert.equal(method,'post');
    assert.equal(requestPath,'/v1/pages');
    notionBody=body;
    return {id:createdPageId,url:'https://www.notion.so/created',properties:body.properties,created_time:'2026-08-26T18:00:00.000Z',last_edited_time:'2026-08-26T18:00:00.000Z'};
  };

  const result=backend.apiCreateGoogle({taskPageId:taskId,section:'Docs',name:'Быстрый документ',idempotencyKey:requestId});
  assert.equal(result.ok,true);
  assert.equal(result.data.duplicate,false);
  assert.equal(result.data.material.name,'Быстрый документ');
  assert.equal(result.data.material.createRequestId,requestId);
  assert.equal(driveCreates,1);
  assert.equal(notionCreates,1);
  assert.equal(userLockCalls,0);
  assert.equal(notionBody.properties['[SYS] Позиция'].number,8);
  const canonical=backend.w19CanonicalIdempotency_(taskId,'create-google-Docs',requestId);
  assert.match(JSON.stringify(notionBody),new RegExp(canonical.replace(/[|]/g,'\\|')));
  assert.doesNotMatch(JSON.stringify(result),/create-google-Docs|3c62d62739a180a1aac7ec19ffc9ef8e/);

  const status=backend.apiGetCreateStatus({taskPageId:taskId,section:'Docs',createRequestId:requestId});
  assert.equal(status.ok,true);
  assert.equal(status.data.status,'done');
  assert.equal(status.data.material.id,createdPageId);
  assert.equal(status.data.material.createRequestId,requestId);
  assert.doesNotMatch(JSON.stringify(status),/create-google-Docs|3c62d62739a180a1aac7ec19ffc9ef8e/);
  assert.equal(driveCreates,1);
  assert.equal(notionCreates,1);
  assert.equal(userLockCalls,0);

  const pendingRequestId='22222222-2222-4222-8222-222222222222';
  const pendingCanonical=backend.w19CanonicalIdempotency_(taskId,'create-google-Docs',pendingRequestId);
  props.setProperty(backend.w19IdempotencyLedgerKey_(pendingCanonical),JSON.stringify({status:'pending',at:Date.now(),attemptId:'server-only'}));
  const pending=backend.apiGetCreateStatus({taskPageId:taskId,section:'Docs',createRequestId:pendingRequestId});
  assert.deepEqual(JSON.parse(JSON.stringify(pending.data)),{status:'pending',retryable:true});
});

test('create context warming verifies the task folder once without a Notion request', () => {
  const backend=loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const values={};
  const props={
    getProperty:(key)=>Object.prototype.hasOwnProperty.call(values,key)?values[key]:null,
    getProperties:()=>({...values}),
    setProperty:(key,value)=>{values[key]=String(value);},
    setProperties:(next)=>{Object.assign(values,next);},
    deleteProperty:(key)=>{delete values[key];}
  };
  const lock={tryLock:()=>true,waitLock(){},releaseLock(){}};
  backend.PropertiesService={getScriptProperties:()=>props};
  backend.LockService={getScriptLock:()=>lock,getUserLock:()=>lock};
  backend.w20RegistryWriteTaskMeta_(taskId,{
    taskName:'Задача',folderId:'UntrustedFolder123',rootFolderId:'RootFolder12345',folderVerified:false,
    context:{path:'Основная / Задача',ancestorIds:'ancestor',depth:2}
  });
  assert.equal(backend.w20RegistryClaimCreateSlot_(taskId,'Docs','RootFolder12345'),null);
  backend.w19AuthorizedConfig_=()=>({authorizedTaskPageId:taskId,deniedPageIds:{},rootFolderId:'RootFolder12345'});
  backend.w19NotionRequest_=()=>{throw new Error('warming must not call Notion');};
  backend.w19AssertSchema_=()=>{throw new Error('warming must not inspect schema');};
  backend.w19AssertTaskPage_=()=>{throw new Error('warming must not fetch the task');};
  let folderChecks=0;
  backend.w19EnsureTaskFolder_=(task)=>{
    folderChecks+=1;
    assert.equal(task.id,taskId);
    assert.equal(task.name,'Задача');
    return {id:'VerifiedFolder123'};
  };

  const warmed=backend.apiWarmCreateContext({taskPageId:taskId});
  assert.deepEqual(JSON.parse(JSON.stringify(warmed)),{ok:true,data:{ready:true,cached:false}});
  assert.equal(folderChecks,1);
  const meta=backend.w20RegistryReadFreshTaskMeta_(taskId);
  assert.equal(meta.folderId,'VerifiedFolder123');
  assert.equal(meta.folderVerified,true);

  const cached=backend.apiWarmCreateContext({taskPageId:taskId});
  assert.deepEqual(JSON.parse(JSON.stringify(cached)),{ok:true,data:{ready:true,cached:true}});
  assert.equal(folderChecks,1);
});

test('failed and stale Google-create ledger entries always run full duplicate recovery', () => {
  for (const ledgerEntry of [
    {status:'failed',at:Date.now()-1000,attemptId:'old-failed'},
    {status:'pending',at:Date.now()-421000,attemptId:'old-stale'}
  ]) {
    const backend=loadBackend();
    const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
    const pageId='3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
    const requestId='11111111-1111-4111-8111-111111111111';
    const canonical=backend.w19CanonicalIdempotency_(taskId,'create-google-Docs',requestId);
    const values={};
    const props={
      getProperty:(key)=>Object.prototype.hasOwnProperty.call(values,key)?values[key]:null,
      getProperties:()=>({...values}),
      setProperty:(key,value)=>{values[key]=String(value);},
      setProperties:(next)=>{Object.assign(values,next);},
      deleteProperty:(key)=>{delete values[key];}
    };
    props.setProperty(backend.w19IdempotencyLedgerKey_(canonical),JSON.stringify(ledgerEntry));
    const lock={tryLock:()=>true,waitLock(){},releaseLock(){}};
    backend.PropertiesService={getScriptProperties:()=>props};
    backend.LockService={getScriptLock:()=>lock};
    backend.Utilities.getUuid=()=>`recovery-${ledgerEntry.status}`;
    backend.Utilities.formatDate=()=> '2026-08-26 21:00';
    const cfg={authorizedTaskPageId:taskId,deniedPageIds:{},notionToken:'server-only'};
    backend.w19AuthorizedConfig_=()=>cfg;
    let schemaChecks=0,taskChecks=0,mutationLocks=0,idempotencyQueries=0,markerRepairs=0,hotClaims=0;
    backend.w19AssertSchema_=()=>{schemaChecks+=1;};
    backend.w19AssertTaskPage_=()=>{taskChecks+=1;return {id:taskId,name:'Задача',page:{properties:{}}};};
    backend.w19WithMutationLock_=(fn)=>{mutationLocks+=1;return fn();};
    const existingPage={
      id:pageId,url:'https://www.notion.so/existing',
      properties:{
        Name:{title:[{plain_text:'Уже создан'}]},
        'Ссылка':{url:'https://docs.google.com/document/d/CreatedGoogleDoc123/edit'},
        'Архив':{checkbox:false},
        '[SYS] Формат файла':{select:{name:'Google Docs'}},
        '[SYS] Раздел виджета':{select:{name:'Docs'}},
        '[SYS] Провайдер':{select:{name:'Google Drive'}},
        '[SYS] Google File ID':{rich_text:[{plain_text:'CreatedGoogleDoc123'}]},
        '[SYS] Google Folder ID':{rich_text:[{plain_text:'TaskFolder12345'}]},
        '[SYS] Sync status':{select:{name:'synced'}},
        '[SYS] Idempotency key':{rich_text:[{plain_text:canonical}]}
      }
    };
    backend.w19FindMaterialByIdempotency_=()=>{idempotencyQueries+=1;return existingPage;};
    backend.w19GetDriveMetadata_=()=>({id:'CreatedGoogleDoc123',appProperties:{materialState:'active'}});
    backend.w19MarkDriveNotionPage_=()=>{markerRepairs+=1;};
    backend.w20RegistryClaimCreateSlot_=()=>{hotClaims+=1;throw new Error('recovery must not claim a hot slot');};
    for (const name of ['w19EnsureTaskFolder_','w19FindDriveByIdempotency_','w19CreateGoogleFile_','w19CreateNotionMaterial_']) {
      backend[name]=()=>{throw new Error(`${name} would create a duplicate`);};
    }

    const result=backend.apiCreateGoogle({taskPageId:taskId,section:'Docs',idempotencyKey:requestId});
    assert.equal(result.ok,true,`${ledgerEntry.status}: ${JSON.stringify(result)}`);
    assert.equal(result.data.duplicate,true,ledgerEntry.status);
    assert.equal(result.data.material.id,pageId,ledgerEntry.status);
    assert.equal(result.data.material.createRequestId,requestId,ledgerEntry.status);
    assert.equal(schemaChecks,1,ledgerEntry.status);
    assert.equal(taskChecks,1,ledgerEntry.status);
    assert.equal(mutationLocks,1,ledgerEntry.status);
    assert.equal(idempotencyQueries,1,ledgerEntry.status);
    assert.equal(markerRepairs,1,ledgerEntry.status);
    assert.equal(hotClaims,0,ledgerEntry.status);
    assert.doesNotMatch(JSON.stringify(result),/create-google-Docs|3c62d62739a180a1aac7ec19ffc9ef8e/);
  }
});

test('scheduled sync rejects browser calls that are neither owner nor the installed trigger', () => {
  const scheduled = backendSource.slice(backendSource.indexOf('function scheduledSync'), backendSource.indexOf('function w19ClaimScheduledSync_'));
  const guard = backendSource.slice(backendSource.indexOf('function w19AssertScheduledInvocation_'), backendSource.indexOf('/* ========================= Authorization/config'));
  assert.match(scheduled, /w19AssertScheduledInvocation_\(cfg, event\)/);
  assert.match(guard, /event && event\.triggerUid/);
  assert.match(guard, /trigger\.getHandlerFunction\(\) === 'scheduledSync'/);
  assert.match(guard, /trigger\.getUniqueId\(\)/);
});

test('background rename trigger uses a five-minute cadence to stay below shared API limits', () => {
  const installer = backendSource.slice(backendSource.indexOf('function adminInstallSyncTrigger'), backendSource.indexOf('function scheduledSync'));
  assert.match(installer, /everyMinutes\(5\)\.create\(\)/);
  assert.doesNotMatch(installer, /everyMinutes\(1\)/);
});

test('five-second Drive metadata poll authenticates without reading or writing Notion', () => {
  const poll = backendSource.slice(backendSource.indexOf('function apiPollDriveMetadata'), backendSource.indexOf('function apiSyncTask'));
  assert.match(poll, /w19AuthorizedConfig_\(input\)/);
  assert.match(poll, /taskId !== cfg\.authorizedTaskPageId/);
  assert.match(poll, /w20DrivePollClaimStatus_/);
  assert.match(poll, /w19GetDriveMetadata_\(googleFileId\)/);
  assert.ok(poll.indexOf('w20DrivePollClaimStatus_') < poll.indexOf('w19GetDriveMetadata_'));
  assert.doesNotMatch(poll, /w19NotionRequest_|w19AssertTaskPage_|w19AssertMaterialForTask_|w19QueryTaskMaterials_/);
});

test('signed Drive poll makes zero Notion calls when metadata is unchanged and one PATCH after a rename', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-8120-bd0a-f969e6846945';
  const fileId = 'NativeGoogleDoc123';
  const cfg = { authorizedTaskPageId: taskId, deniedPageIds: {}, notionToken: 'server-only-signing-secret' };
  const row = {
    pageId, googleFileId:fileId,
    currentName:'Исходное имя',
    currentOpenUrl:`https://docs.google.com/document/d/${fileId}/edit`,
    currentFormat:'Google Docs',currentSection:'Docs',currentMimeType:'application/vnd.google-apps.document',
    currentSize:null,currentDriveMd5:'',currentDownloadName:'Исходное имя',
    currentNormalizedUrl:`https://docs.google.com/document/d/${fileId}/edit`
  };
  row.claim = backend.w20IssueDrivePollClaim_(taskId, pageId, fileId, row, cfg);
  backend.w19AuthorizedConfig_ = () => cfg;
  let driveName = 'Исходное имя';
  backend.w19GetDriveMetadata_ = () => ({
    id: fileId,
    name: driveName,
    mimeType: 'application/vnd.google-apps.document',
    webViewLink: `https://docs.google.com/document/d/${fileId}/edit`,trashed:false
  });
  let patches = 0;
  backend.w19UpdateNotionPage_ = () => { patches += 1; throw new Error('unchanged poll must not PATCH Notion'); };
  const unchanged = backend.apiPollDriveMetadata({taskPageId:taskId,materials:[row]});
  assert.equal(unchanged.ok, true);
  assert.equal(patches, 0);
  assert.equal(unchanged.data.materials[0].name, 'Исходное имя');

  driveName = 'Новое имя';
  let patchedProperties = null;
  backend.w19WithMutationLock_ = (fn) => fn();
  backend.w19UpdateNotionPage_ = (_id, properties) => { patches += 1;patchedProperties=properties;return {}; };
  backend.w19MaterialFromPage_ = () => ({id:pageId,name:driveName,section:'Docs',format:'Google Docs',provider:'Google Drive',openUrl:row.currentOpenUrl,googleFileId:fileId,mimeType:row.currentMimeType,size:null,driveMd5:'',downloadName:driveName,normalizedUrl:row.currentNormalizedUrl,syncStatus:'synced',integrity:'ok'});
  const changed = backend.apiPollDriveMetadata({taskPageId:taskId,materials:[row]});
  assert.equal(changed.ok, true);
  assert.equal(patches, 1);
  assert.ok(patchedProperties.Name);
  assert.ok(patchedProperties['[SYS] Download name']);
  assert.equal(patchedProperties['[SYS] Последняя синхронизация'],undefined);
  assert.equal(changed.data.materials[0].name, 'Новое имя');
});

test('every Notion request reserves a global slot and releases its lock before UrlFetch', () => {
  const backend = loadBackend();
  const events = [];
  const values = new Map();
  backend.Date = { now: () => 1000 };
  backend.LockService = {
    getScriptLock: () => ({
      tryLock: (timeout) => { events.push(`lock:${timeout}`); return true; },
      releaseLock: () => events.push('release')
    })
  };
  backend.CacheService = {
    getScriptCache: () => ({
      get: (key) => { events.push('cache:get'); return values.get(key) ?? null; },
      put: (key, value, ttl) => { events.push(`cache:put:${ttl}`); values.set(key, value); }
    })
  };
  backend.Utilities.sleep = (ms) => events.push(`sleep:${ms}`);
  backend.UrlFetchApp = {
    fetch: () => {
      events.push('fetch');
      return { getResponseCode: () => 200, getContentText: () => '{"ok":true}' };
    }
  };

  const result = backend.w19NotionRequest_('get', '/v1/users/me', null, {
    notionToken: 'secret-not-logged',
    notionVersion: '2026-03-11'
  });

  assert.equal(result.ok, true);
  assert.deepEqual(events, ['lock:5000', 'cache:get', 'cache:put:120', 'release', 'fetch']);
});

test('Notion request slots enforce at least 350 ms between outbound attempts', () => {
  const backend = loadBackend();
  const values = new Map();
  const reservations = [];
  const sleeps = [];
  let now = 1000;
  let releases = 0;
  backend.Date = { now: () => now };
  backend.LockService = {
    getScriptLock: () => ({
      tryLock: () => true,
      releaseLock: () => { releases += 1; }
    })
  };
  backend.CacheService = {
    getScriptCache: () => ({
      get: (key) => values.get(key) ?? null,
      put: (key, value) => {
        values.set(key, value);
        reservations.push(Number(value));
      }
    })
  };
  backend.Utilities.sleep = (ms) => {
    sleeps.push(ms);
    now += ms;
  };

  backend.w19ReserveNotionRequestSlot_();
  now += 10;
  backend.w19ReserveNotionRequestSlot_();

  assert.deepEqual(reservations, [1000, 1350]);
  assert.deepEqual(sleeps, [340]);
  assert.ok(reservations[1] - reservations[0] >= 350);
  assert.equal(releases, 2);
});

test('Notion rate limiter always releases an acquired lock and fails retryably on lock contention', () => {
  const backend = loadBackend();
  let releases = 0;
  backend.LockService = {
    getScriptLock: () => ({
      tryLock: () => true,
      releaseLock: () => { releases += 1; }
    })
  };
  backend.CacheService = {
    getScriptCache: () => ({ get: () => { throw new Error('cache unavailable'); } })
  };
  assert.throws(() => backend.w19ReserveNotionRequestSlot_(), /cache unavailable/);
  assert.equal(releases, 1);

  let requestedTimeout = null;
  backend.LockService = {
    getScriptLock: () => ({
      tryLock: (timeout) => { requestedTimeout = timeout; return false; },
      releaseLock: () => { throw new Error('must not release an unacquired lock'); }
    })
  };
  assert.throws(
    () => backend.w19ReserveNotionRequestSlot_(),
    (error) => error && error.code === 'NOTION_RATE_LIMIT_BUSY' && error.retryable === true
  );
  assert.equal(requestedTimeout, 5000);
});

test('daily Apps Script UrlFetch exhaustion is reported immediately and retry delays are capped', () => {
  const exhausted = loadBackend();
  exhausted.w19ReserveNotionRequestSlot_ = () => {};
  exhausted.Utilities.sleep = () => { throw new Error('daily quota errors must not be retried'); };
  exhausted.UrlFetchApp = {
    fetch: () => { throw new Error('Service invoked too many times for one day: urlfetch.'); }
  };
  assert.throws(
    () => exhausted.w19NotionRequest_('get', '/v1/users/me', null, { notionToken: 'secret', notionVersion: '2026-03-11' }),
    (error) => error && error.code === 'GOOGLE_URLFETCH_QUOTA' && error.retryable === true
  );

  const throttled = loadBackend();
  const sleeps = [];
  let calls = 0;
  throttled.w19ReserveNotionRequestSlot_ = () => {};
  throttled.Utilities.sleep = (ms) => sleeps.push(ms);
  throttled.UrlFetchApp = {
    fetch: () => {
      calls += 1;
      if (calls === 1) return {
        getResponseCode: () => 429,
        getContentText: () => '{"code":"rate_limited"}',
        getHeaders: () => ({ 'Retry-After': '99999' })
      };
      return { getResponseCode: () => 200, getContentText: () => '{"ok":true}' };
    }
  };
  assert.equal(throttled.w19NotionRequest_('get', '/v1/users/me', null, { notionToken: 'secret', notionVersion: '2026-03-11' }).ok, true);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 5000 && sleeps[0] < 5250);
});

test('linked Google files use Drive metadata instead of a caller-supplied label', () => {
  const addLink = backendSource.slice(backendSource.indexOf('function apiAddLink'), backendSource.indexOf('function apiUpload'));
  assert.match(addLink, /w19ResolveGoogleLink_\(googleFileId, normalized\)/);
  assert.match(addLink, /name:\s*linkData\.name/);
  assert.match(addLink, /mimeType:\s*linkData\.mimeType/);
  assert.match(addLink, /sourceUrl:\s*linkData\.sourceUrl/);
  assert.match(addLink, /GOOGLE_LINK_NOT_ACCESSIBLE|w19ResolveGoogleLink_/);
});

test('binary uploads are sent to Notion as a single-part file upload', () => {
  const backend = loadBackend();
  const uploadId = '43833259-72ae-404e-8441-b6577f3159b4';
  const uploadUrl = `https://api.notion.com/v1/file_uploads/${uploadId}/send`;
  const calls = [];
  backend.w19NotionRequest_ = (method, requestPath, body) => {
    calls.push({ kind: 'create', method, requestPath, body });
    return { object: 'file_upload', id: uploadId, status: 'pending', upload_url: uploadUrl };
  };
  backend.UrlFetchApp = {
    fetch: (url, options) => {
      calls.push({ kind: 'send', url, options });
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ object: 'file_upload', id: uploadId, status: 'uploaded' })
      };
    }
  };

  const result = backend.w19CreateAndSendNotionUpload_([1, 2, 3], 'application/pdf', 'brief.pdf', {
    notionToken: 'secret-not-logged',
    notionVersion: '2026-03-11'
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { id: uploadId, name: 'brief.pdf', mimeType: 'application/pdf' });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body)), {
    mode: 'single_part',
    filename: 'brief.pdf',
    content_type: 'application/pdf'
  });
  assert.equal(calls[1].url, uploadUrl);
  assert.ok(calls[1].options.payload.file);
  assert.equal(Object.hasOwn(calls[1].options, 'contentType'), false, 'Apps Script must generate the multipart boundary');
});

test('uncertain Notion send responses are checked before the upload is resent', () => {
  const backend = loadBackend();
  const uploadId = '43833259-72ae-404e-8441-b6577f3159b4';
  let statusChecks = 0;
  backend.w19NotionRequest_ = (method, requestPath) => {
    if (method === 'post' && requestPath === '/v1/file_uploads') {
      return {
        object: 'file_upload',
        id: uploadId,
        status: 'pending',
        upload_url: `https://api.notion.com/v1/file_uploads/${uploadId}/send`
      };
    }
    if (method === 'get' && requestPath === `/v1/file_uploads/${uploadId}`) {
      statusChecks += 1;
      return { object: 'file_upload', id: uploadId, status: 'uploaded' };
    }
    throw new Error(`unexpected request: ${method} ${requestPath}`);
  };
  backend.UrlFetchApp = { fetch: () => { throw new Error('connection reset after send'); } };

  const result = backend.w19CreateAndSendNotionUpload_([1, 2, 3], 'application/pdf', 'brief.pdf', {
    notionToken: 'secret-not-logged',
    notionVersion: '2026-03-11'
  });

  assert.equal(result.id, uploadId);
  assert.equal(statusChecks, 1);
});

test('effective upload limit follows the workspace plan and is cached', () => {
  const backend = loadBackend();
  const cacheValues = new Map();
  let meRequests = 0;
  backend.CacheService = {
    getScriptCache: () => ({
      get: (key) => cacheValues.get(key) ?? null,
      put: (key, value) => cacheValues.set(key, value)
    })
  };
  backend.w19NotionRequest_ = (method, requestPath) => {
    assert.equal(method, 'get');
    assert.equal(requestPath, '/v1/users/me');
    meRequests += 1;
    return { bot: { workspace_limits: { max_file_upload_size_in_bytes: 5 * 1024 * 1024 } } };
  };
  const cfg = {
    maxUploadBytes: 20 * 1024 * 1024,
    dataSourceId: '3822d627-39a1-8018-a2dc-000b95bf5722',
    notionVersion: '2026-03-11'
  };

  assert.equal(backend.w19EffectiveUploadLimit_(cfg), 5 * 1024 * 1024);
  assert.equal(backend.w19EffectiveUploadLimit_(cfg), 5 * 1024 * 1024);
  assert.equal(meRequests, 1);
});

test('download authorization cache stores only short-lived server-derived ownership coordinates', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const dataSourceId = '3822d627-39a1-8018-a2dc-000b95bf5722';
  const values = new Map();
  const writes = [];
  let now = 1_800_000_000_000;
  backend.Date = { now: () => now };
  backend.CacheService = {
    getScriptCache: () => ({
      get: (key) => values.get(key) ?? null,
      putAll: (entries, ttl) => {
        writes.push({ entries, ttl });
        Object.entries(entries).forEach(([key, value]) => values.set(key, value));
      },
      remove: (key) => values.delete(key)
    })
  };
  const page = {
    id: pageId,
    in_trash: false,
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties: {
      Name: { title: [{ plain_text: 'Файл.docx' }] },
      'Тип': { select: { name: 'Знание' } },
      'Внутри': { relation: [{ id: taskId }] },
      'Архив': { checkbox: false },
      'Ссылка': { url: 'https://drive.google.com/file/d/1OwnedBinaryFile123/view' },
      'Вложения': { files: [{
        name: 'Файл.docx',
        type: 'file',
        file: { url: 'https://signed-storage.example/private?secret=must-not-be-cached' }
      }] },
      '[SYS] Формат файла': { select: { name: 'Word' } },
      '[SYS] Провайдер': { select: { name: 'Google Drive' } },
      '[SYS] Google File ID': { rich_text: [{ plain_text: '1OwnedBinaryFile123' }] },
      '[SYS] Google Folder ID': { rich_text: [{ plain_text: '1OwnedTaskFolder123' }] }
    }
  };
  const cfg = { dataSourceId, deniedPageIds: {}, notionToken: 'notion-secret-must-not-be-cached' };

  assert.equal(backend.w20CacheDownloadMaterials_(taskId, [page], cfg), 1);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].ttl > 0 && writes[0].ttl <= 120);
  assert.equal(values.size, 1);
  const [[key, raw]] = [...values.entries()];
  assert.doesNotMatch(key, new RegExp(taskId.replaceAll('-', ''), 'i'));
  assert.doesNotMatch(key, new RegExp(pageId.replaceAll('-', ''), 'i'));
  assert.doesNotMatch(raw, /notion-secret|signed-storage|must-not-be-cached|accessToken|downloadUrl|attachment/i);
  assert.deepEqual(
    JSON.parse(JSON.stringify(backend.w20GetCachedDownloadMaterial_(taskId, pageId, cfg))),
    {
      id: pageId,
      provider: 'Google Drive',
      googleFileId: '1OwnedBinaryFile123',
      folderId: '1OwnedTaskFolder123'
    }
  );
  const validEntry = JSON.parse(raw);
  values.set(key, JSON.stringify({ ...validEntry, googleFileId: '../client-controlled' }));
  assert.equal(backend.w20GetCachedDownloadMaterial_(taskId, pageId, cfg), null);
  values.set(key, JSON.stringify({ ...validEntry, dataSourceId: '3822d62739a18018a2dc000b95bf5723' }));
  assert.equal(backend.w20GetCachedDownloadMaterial_(taskId, pageId, cfg), null);
  values.set(key, raw);
  assert.equal(backend.w20GetCachedDownloadMaterial_('3c62d627-39a1-80a1-aac7-ec19ffc9ef8f', pageId, cfg), null);
  now += writes[0].ttl * 1000 + 1;
  assert.equal(backend.w20GetCachedDownloadMaterial_(taskId, pageId, cfg), null);
});

test('download cache refuses archived, cross-task, cross-source, denied and Google-native records', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const otherTaskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8f';
  const pageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const dataSourceId = '3822d627-39a1-8018-a2dc-000b95bf5722';
  const base = {
    id: pageId,
    in_trash: false,
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties: {
      'Тип': { select: { name: 'Знание' } },
      'Внутри': { relation: [{ id: taskId }] },
      'Архив': { checkbox: false },
      '[SYS] Формат файла': { select: { name: 'Word' } },
      '[SYS] Провайдер': { select: { name: 'Google Drive' } },
      '[SYS] Google File ID': { rich_text: [{ plain_text: '1OwnedBinaryFile123' }] },
      '[SYS] Google Folder ID': { rich_text: [{ plain_text: '1OwnedTaskFolder123' }] }
    }
  };
  const clone = () => structuredClone(base);
  const cfg = { dataSourceId, deniedPageIds: {} };
  assert.ok(backend.w20DownloadCacheEntryFromPage_(taskId, clone(), cfg, Date.now()));

  const archived = clone();
  archived.properties['Архив'].checkbox = true;
  assert.equal(backend.w20DownloadCacheEntryFromPage_(taskId, archived, cfg, Date.now()), null);

  const crossTask = clone();
  crossTask.properties['Внутри'].relation = [{ id: otherTaskId }];
  assert.equal(backend.w20DownloadCacheEntryFromPage_(taskId, crossTask, cfg, Date.now()), null);

  const crossSource = clone();
  crossSource.parent.data_source_id = '3822d627-39a1-8018-a2dc-000b95bf5723';
  assert.equal(backend.w20DownloadCacheEntryFromPage_(taskId, crossSource, cfg, Date.now()), null);

  assert.equal(backend.w20DownloadCacheEntryFromPage_(taskId, clone(), {
    dataSourceId,
    deniedPageIds: { [pageId]: true }
  }, Date.now()), null);

  const native = clone();
  native.properties['[SYS] Формат файла'].select.name = 'Google Docs';
  assert.equal(backend.w20DownloadCacheEntryFromPage_(taskId, native, cfg, Date.now()), null);

  const values = new Map();
  backend.CacheService = {
    getScriptCache: () => ({
      putAll: (entries) => Object.entries(entries).forEach(([key, value]) => values.set(key, value)),
      removeAll: (keys) => keys.forEach((key) => values.delete(key))
    })
  };
  assert.equal(backend.w20CacheDownloadMaterials_(taskId, [clone()], cfg), 1);
  assert.equal(values.size, 1);
  values.set(backend.w20DownloadGrantCacheKey_(taskId,base.id),'server-attested-grant');
  assert.equal(values.size,2);
  assert.equal(backend.w20CacheDownloadMaterials_(taskId, [archived], cfg), 0);
  assert.equal(values.size, 0);
});

test('download cache hit skips the material Notion GET but still runs the full Drive ownership guard', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const cfg = {
    dataSourceId: '3822d627-39a1-8018-a2dc-000b95bf5722',
    maxUploadBytes: 1024,
    deniedPageIds: {}
  };
  const cached = { id: pageId, provider: 'Google Drive', googleFileId: '1OwnedBinaryFile123', folderId: '1OwnedTaskFolder123' };
  let guardCalls = 0;
  let taskAssertions = 0;
  backend.w19AuthorizedConfig_ = () => cfg;
  backend.w19AssertTaskPage_ = () => { taskAssertions += 1; throw new Error('task Notion GET must be skipped on a cache hit'); };
  backend.w20GetCachedDownloadMaterial_ = () => cached;
  backend.w19AssertMaterialForTask_ = () => { throw new Error('material Notion GET must be skipped on a cache hit'); };
  backend.w19AssertOwnedBinary_ = (material, task, receivedCfg) => {
    guardCalls += 1;
    assert.equal(material, cached);
    assert.equal(task.id, taskId);
    assert.equal(receivedCfg, cfg);
    return { id: '1OwnedBinaryFile123', name: 'Файл.docx', mimeType: 'application/octet-stream' };
  };
  backend.w19DriveRetry_ = (fn) => fn();
  backend.DriveApp = { getFileById: () => ({ getBlob: () => ({ getBytes: () => [1, 2, 3] }) }) };
  backend.Utilities.base64Encode = (bytes) => Buffer.from(bytes).toString('base64');

  const result = backend.apiDownload({ taskPageId: taskId, pageId });
  assert.equal(result.ok, true);
  assert.equal(taskAssertions, 0);
  assert.equal(guardCalls, 1);
  assert.equal(result.data.base64, 'AQID');
});

test('download cache miss can recover server-owned provenance from private Drive appProperties without Notion', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const cfg = { maxUploadBytes: 1024, deniedPageIds: {} };
  const recovered = { id: pageId, provider: 'Google Drive', googleFileId: '1OwnedBinaryFile123', folderId: '1OwnedTaskFolder123' };
  let taskAssertions = 0;
  backend.w19AuthorizedConfig_ = () => cfg;
  backend.w20GetCachedDownloadMaterial_ = () => null;
  backend.w20FindOwnedBinaryMaterialByMarkers_ = () => recovered;
  backend.w19AssertTaskPage_ = () => { taskAssertions += 1; throw new Error('Notion must not be needed for marked Drive files'); };
  backend.w19AssertMaterialForTask_ = () => { throw new Error('Notion material assertion must be skipped'); };
  backend.w19AssertOwnedBinary_ = (material) => {
    assert.equal(material, recovered);
    return { id: recovered.googleFileId, name: 'Файл.docx', mimeType: 'application/octet-stream' };
  };
  backend.w19DriveRetry_ = (fn) => fn();
  backend.DriveApp = { getFileById: () => ({ getBlob: () => ({ getBytes: () => [5, 6] }) }) };
  backend.Utilities.base64Encode = (bytes) => Buffer.from(bytes).toString('base64');

  const result = backend.apiDownload({ taskPageId: taskId, pageId });
  assert.equal(result.ok, true);
  assert.equal(taskAssertions, 0);
  assert.equal(result.data.base64, 'BQY=');
});

test('archived Drive markers revoke stale courier links without a Notion lookup', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const compactTask = backend.WidgetV19Core.compactUuid(taskId);
  const compactPage = backend.WidgetV19Core.compactUuid(pageId);
  backend.w19AssertRootFolder_ = () => ({ id: 'RootFolder123' });
  backend.w19DriveRetry_ = (fn) => fn();
  backend.Drive = {
    Files: {
      list: () => ({ files: [{
        id: 'OwnedBinary123',
        name: 'Архив.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: '10',
        trashed: false,
        parents: ['TaskFolder123'],
        appProperties: {
          widgetVersion: 'v20',
          taskPageId: compactTask,
          notionPageId: compactPage,
          materialState: 'archived'
        }
      }] })
    }
  };
  backend.w19GetDriveMetadata_ = () => {
    throw new Error('revoked files must be rejected before folder traversal');
  };

  const recovered = backend.w20FindOwnedBinaryMaterialByMarkers_(taskId, pageId, { deniedPageIds: {} });
  assert.equal(recovered, null);
});

test('archive and restore state is persisted in the private Drive marker', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const compactTask = backend.WidgetV19Core.compactUuid(taskId);
  const compactPage = backend.WidgetV19Core.compactUuid(pageId);
  const material = { id: pageId, widgetOwned: true, googleFileId: 'OwnedBinary123' };
  const writes = [];
  backend.w19GetDriveMetadata_ = () => ({
    id: 'OwnedBinary123',
    appProperties: {
      widgetVersion: 'v20',
      taskPageId: compactTask,
      notionPageId: compactPage,
      widgetIdem: 'kept'
    }
  });
  backend.w19DriveRetry_ = (fn) => fn();
  backend.Drive = {
    Files: {
      update: (resource, fileId) => {
        writes.push({ resource, fileId });
        return { id: fileId, appProperties: resource.appProperties };
      }
    }
  };

  backend.w20SetDriveMaterialState_(material, taskId, 'archived');
  backend.w20SetDriveMaterialState_(material, taskId, 'active');

  assert.deepEqual(writes.map((entry) => entry.resource.appProperties.materialState), ['archived', 'active']);
  assert.ok(writes.every((entry) => entry.resource.appProperties.widgetIdem === 'kept'));
  assert.ok(writes.every((entry) => entry.fileId === 'OwnedBinary123'));
});

test('late idempotency marker repair never reactivates a revoked file', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const compactTask = backend.WidgetV19Core.compactUuid(taskId);
  let written = null;
  backend.w19DriveRetry_ = (fn) => fn();
  backend.Drive = {
    Files: {
      update: (resource) => {
        written = resource.appProperties;
        return { id: 'OwnedBinary123', appProperties: written };
      }
    }
  };
  const drive = {
    id: 'OwnedBinary123',
    appProperties: { widgetVersion: 'v20', taskPageId: compactTask, materialState: 'archived' }
  };

  backend.w19MarkDriveNotionPage_(drive, taskId, 'idem', pageId, 'active');

  assert.equal(written.materialState, 'archived');
  assert.equal(written.notionPageId, backend.WidgetV19Core.compactUuid(pageId));
});

test('download cache miss falls back to the authoritative Notion material assertion', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const cfg = { maxUploadBytes: 1024, deniedPageIds: {} };
  let taskAssertions = 0;
  let materialAssertions = 0;
  const material = { id: pageId, provider: 'Google Drive', googleFileId: '1OwnedBinaryFile123', folderId: '1OwnedTaskFolder123' };
  backend.w19AuthorizedConfig_ = () => cfg;
  backend.w19AssertTaskPage_ = () => { taskAssertions += 1; return { id: taskId, name: 'Задача' }; };
  backend.w20GetCachedDownloadMaterial_ = () => null;
  backend.w20FindOwnedBinaryMaterialByMarkers_ = () => null;
  backend.w19AssertMaterialForTask_ = () => { materialAssertions += 1; return { id: pageId }; };
  backend.w19MaterialFromPage_ = () => material;
  backend.w19AssertOwnedBinary_ = () => ({ id: '1OwnedBinaryFile123', name: 'Файл.docx', mimeType: 'application/octet-stream' });
  backend.w19DriveRetry_ = (fn) => fn();
  backend.DriveApp = { getFileById: () => ({ getBlob: () => ({ getBytes: () => [4] }) }) };
  backend.Utilities.base64Encode = (bytes) => Buffer.from(bytes).toString('base64');

  const result = backend.apiDownload({ taskPageId: taskId, pageId });
  assert.equal(result.ok, true);
  assert.equal(taskAssertions, 1);
  assert.equal(materialAssertions, 1);
});

test('download cache miss fails closed when authoritative Notion ownership rejects the material', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const cfg = { maxUploadBytes: 1024, deniedPageIds: {} };
  let guardCalls = 0;
  backend.w19AuthorizedConfig_ = () => cfg;
  backend.w20GetCachedDownloadMaterial_ = () => null;
  backend.w20FindOwnedBinaryMaterialByMarkers_ = () => null;
  backend.w19AssertTaskPage_ = () => ({ id: taskId, name: 'Задача' });
  backend.w19AssertMaterialForTask_ = () => {
    throw new backend.W19Error_('MATERIAL_TASK_MISMATCH', 'Материал не принадлежит этой задаче.', false);
  };
  backend.w19AssertOwnedBinary_ = () => { guardCalls += 1; throw new Error('Drive guard must not run after Notion rejection'); };

  const result = backend.apiDownload({ taskPageId: taskId, pageId });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MATERIAL_TASK_MISMATCH');
  assert.equal(guardCalls, 0);
});

test('durable fallback registry keeps only safe server-derived card metadata and supports replacement cleanup', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const values = new Map([['NOTION_TOKEN', 'must-remain-unread']]);
  backend.PropertiesService = {
    getScriptProperties: () => ({
      getProperties: () => Object.fromEntries(values),
      setProperty: (key, value) => values.set(key, value),
      setProperties: (entries) => Object.entries(entries).forEach(([key, value]) => values.set(key, value)),
      deleteProperty: (key) => values.delete(key)
    })
  };
  const material = {
    id: pageId,
    name: 'Файл.docx',
    section: 'Docs',
    format: 'Word',
    provider: 'Google Drive',
    openUrl: 'https://drive.google.com/file/d/1OwnedBinaryFile123/view',
    attachmentUrl: 'https://signed.example/secret',
    accessToken: 'must-not-persist',
    googleFileId: '1OwnedBinaryFile123',
    folderId: '1OwnedTaskFolder123',
    widgetOwnedBinary: true,
    mimeType: 'application/octet-stream',
    size: 2,
    position: 1,
    syncStatus: 'synced'
  };
  assert.equal(backend.w20RegistryReplaceTask_(taskId, [material]), 1);
  const registryEntries = [...values.entries()].filter(([key]) => key.startsWith('w20:material-registry:'));
  assert.equal(registryEntries.length, 1);
  assert.doesNotMatch(registryEntries[0][1], /must-not-persist|signed\.example|attachmentUrl|accessToken|NOTION_TOKEN/);
  const restored = backend.w20RegistryReadTask_(taskId, null);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, pageId);
  assert.equal(restored[0].canDownload, true);
  assert.equal(restored[0].downloadUrl, null);
  assert.equal(backend.w20RegistryReplaceTask_(taskId, []), 0);
  assert.equal(backend.w20RegistryReadTask_(taskId, null).length, 0);
  assert.equal(values.get('NOTION_TOKEN'), 'must-remain-unread');
});

test('registry tombstones block stale upserts and snapshots until an explicit restore', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const values = new Map();
  backend.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => values.get(key) ?? null,
      getProperties: () => Object.fromEntries(values),
      setProperty: (key, value) => values.set(key, value),
      setProperties: (entries) => Object.entries(entries).forEach(([key, value]) => values.set(key, value)),
      deleteProperty: (key) => values.delete(key)
    })
  };
  const material = {
    id: pageId,
    name: 'Исходная карточка',
    section: 'Docs',
    format: 'Google Docs',
    provider: 'Google Drive',
    openUrl: 'https://docs.google.com/document/d/OwnedGoogleDoc123/edit',
    googleFileId: 'OwnedGoogleDoc123',
    folderId: 'OwnedTaskFolder123',
    position: 0,
    syncStatus: 'synced'
  };

  assert.equal(backend.w20RegistryUpsert_(taskId, material), true);
  const snapshotStartedAt = Date.now();
  assert.equal(backend.w20RegistryRemove_(taskId, pageId), true);
  const key = backend.w20RegistryKey_(taskId, pageId);
  assert.equal(JSON.parse(values.get(key)).recordType, 'tombstone');
  assert.equal(backend.w20RegistryReadTask_(taskId, null).length, 0);

  assert.equal(backend.w20RegistryUpsert_(taskId, { ...material, name: 'Поздний stale upsert' }), false);
  assert.equal(backend.w20RegistryReplaceTask_(taskId, [{ ...material, name: 'Stale snapshot' }], snapshotStartedAt), 0);
  assert.equal(JSON.parse(values.get(key)).recordType, 'tombstone');
  assert.equal(backend.w20RegistryReadTask_(taskId, null).length, 0);

  assert.equal(backend.w20RegistryRestore_(taskId, { ...material, name: 'Восстановленная карточка' }), true);
  const restored = backend.w20RegistryReadTask_(taskId, null);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].name, 'Восстановленная карточка');
  assert.equal(JSON.parse(values.get(key)).recordType, undefined);

  const addLink = backendSource.slice(backendSource.indexOf('function apiAddLink'), backendSource.indexOf('function apiUpload'));
  const archiveState = backendSource.slice(backendSource.indexOf('function w19SetArchiveState_'), backendSource.indexOf('function w19Audit_'));
  assert.match(addLink, /outcome\.restored\s*\?\s*w20RegistryRestore_/);
  assert.match(archiveState, /w20RegistryRestore_\(task\.id, material\)/);
  assert.match(archiveState, /w20RegistryRestore_\(task\.id, updatedMaterial\)/);
});

test('authoritative bootstrap and sync return the tombstone-aware merged registry', () => {
  for (const apiName of ['apiBootstrap', 'apiSyncTask']) {
    const backend = loadBackend();
    const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
    const stalePageId = '3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
    const concurrentPageId = '3c72d627-39a1-8120-bd0a-f969e6846945';
    const values = new Map();
    backend.PropertiesService = {
      getScriptProperties: () => ({
        getProperty: (key) => values.get(key) ?? null,
        getProperties: () => Object.fromEntries(values),
        setProperty: (key, value) => values.set(key, value),
        setProperties: (entries) => Object.entries(entries).forEach(([key, value]) => values.set(key, value)),
        deleteProperty: (key) => values.delete(key)
      })
    };
    backend.ScriptApp = { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/abcdefghijklmnopqrstuvwxyz0123456789_-AB/exec' }) };
    const base = {
      section: 'Docs',
      format: 'Google Docs',
      provider: 'Google Drive',
      folderId: 'OwnedTaskFolder123',
      position: 0,
      syncStatus: 'synced'
    };
    const stale = {
      ...base,
      id: stalePageId,
      name: 'Уже архивированная карточка',
      openUrl: 'https://docs.google.com/document/d/StaleGoogleDoc123/edit',
      googleFileId: 'StaleGoogleDoc123'
    };
    const concurrent = {
      ...base,
      id: concurrentPageId,
      name: 'Параллельно созданная карточка',
      openUrl: 'https://docs.google.com/document/d/ConcurrentGoogleDoc123/edit',
      googleFileId: 'ConcurrentGoogleDoc123',
      position: 1
    };
    assert.equal(backend.w20RegistryRemove_(taskId, stalePageId), true);
    backend.w19AuthorizedConfig_ = () => ({
      authorizedTaskPageId: taskId,
      deniedPageIds: {},
      rootFolderId: 'OwnedRootFolder123',
      maxUploadBytes: 8 * 1024 * 1024,
      notionToken: 'test-notion-hmac-secret'
    });
    backend.w19AssertSchema_ = () => ({ ok: true });
    backend.w19AssertTaskPage_ = () => ({ id: taskId, name: 'Задача', page: { properties: {} } });
    backend.w20CacheDownloadMaterials_ = () => 0;
    backend.w19MaterialFromPage_ = (page) => page;
    backend.w19QueryTaskMaterials_ = () => {
      assert.equal(backend.w20RegistryUpsert_(taskId, concurrent), true);
      return [stale];
    };

    const response = backend[apiName]({ taskPageId: taskId, forceRefresh: true });
    assert.equal(response.ok, true, `${apiName}: ${JSON.stringify(response)}`);
    assert.deepEqual(Array.from(response.data.materials, (item) => item.id), [concurrentPageId]);
    assert.equal(backend.w20RegistryReadTask_(taskId, null).some((item) => item.id === stalePageId), false);
  }
});

test('material parser prefers the fresh Notion-hosted file URL for downloads', () => {
  const backend = loadBackend();
  const signedUrl = 'https://prod-files-secure.s3.us-west-2.amazonaws.com/file.docx?signature=fresh';
  const material = backend.w19MaterialFromPage_({
    id: '3c72d627-39a1-81e1-971f-c6b30665ce55',
    url: 'https://notion.so/example',
    properties: {
      Name: { title: [{ plain_text: 'Файл.docx' }] },
      'Ссылка': { url: 'https://drive.google.com/file/d/1FsC0H5uqBpE6bXDXN0oaDHtig4xkuhKm/view' },
      'Вложения': { files: [{
        name: 'Файл.docx',
        type: 'file',
        file: { url: signedUrl, expiry_time: '2026-08-25T20:00:00.000Z' }
      }] },
      '[SYS] Формат файла': { select: { name: 'Word' } },
      '[SYS] Провайдер': { select: { name: 'Google Drive' } },
      '[SYS] Google File ID': { rich_text: [{ plain_text: '1FsC0H5uqBpE6bXDXN0oaDHtig4xkuhKm' }] },
      '[SYS] Google Folder ID': { rich_text: [{ plain_text: '1UBwsBgiAzmm9L5t53KlXqS3Axv8KRFXO' }] }
    }
  });

  assert.equal(material.downloadUrl, signedUrl);
  assert.equal(material.canDownload, true);
  assert.equal(material.hostedAttachment, true);
  assert.equal(material.attachmentType, 'file');
  assert.equal(material.attachmentName, 'Файл.docx');
  assert.equal(material.attachmentExpiry, '2026-08-25T20:00:00.000Z');
});

test('hosted URLs are not exposed for unrelated materials', () => {
  const backend = loadBackend();
  const material = backend.w19MaterialFromPage_({
    id: '3c72d627-39a1-81e1-971f-c6b30665ce55',
    properties: {
      Name: { title: [{ plain_text: 'Чужой файл' }] },
      'Вложения': { files: [{ name: 'unrelated.docx', type: 'file', file: { url: 'https://files.example/unrelated.docx' } }] },
      '[SYS] Формат файла': { select: { name: 'Word' } },
      '[SYS] Провайдер': { select: { name: 'External URL' } }
    }
  });
  assert.equal(material.downloadUrl, null);
  assert.equal(material.canDownload, false);
  assert.equal(material.hostedAttachment, false);
});

test('hosted Notion attachments are attached on creation and preserved during Drive sync', () => {
  const upload = backendSource.slice(backendSource.indexOf('function apiUpload'), backendSource.indexOf('function apiUpdateMaterial'));
  const create = backendSource.slice(backendSource.indexOf('function w19CreateNotionMaterial_'), backendSource.indexOf('function w19AppendContextProperties_'));
  const sync = backendSource.slice(backendSource.indexOf('function w19SyncOnePageUnlocked_'), backendSource.indexOf('function w19MarkSyncError_'));
  assert.match(upload, /w19CreateAndSendNotionUpload_\(bytes/);
  assert.match(upload, /type:\s*'file_upload'/);
  assert.match(upload, /file_upload:\s*\{\s*id:\s*notionUpload\.id\s*\}/);
  assert.match(upload, /var outcome = w19WithIdempotency_/);
  assert.doesNotMatch(upload, /w19AssertMaterialForTask_\(outcome\.material\.id/);
  assert.match(upload, /pageForDownloadCache = page/);
  assert.match(upload, /w20CacheDownloadMaterials_\(task\.id, \[pageForDownloadCache\], cfg\)/);
  assert.match(create, /Array\.isArray\(data\.attachments\)/);
  assert.match(sync, /driveData\.sourceUrl\s*&&\s*!material\.widgetOwnedBinary\s*&&\s*!material\.hostedAttachment/);
});

test('next position reads only the highest active position in the requested section', () => {
  const backend = loadBackend();
  backend.w20RegistryReservePosition_=(_taskId,_section,minimumNext)=>minimumNext;
  let request;
  backend.w19NotionRequest_ = (method, requestPath, body, cfg) => {
    request={method,requestPath,body,cfg};
    return {results:[{properties:{'[SYS] Позиция':{number:7}}}]};
  };
  const cfg={dataSourceId:'3822d627-39a1-8018-a2dc-000b95bf5722'};
  assert.equal(backend.w19NextPosition_('3c62d627-39a1-80a1-aac7-ec19ffc9ef8e','Docs',cfg),8);
  assert.equal(request.method,'post');
  assert.equal(request.body.page_size,1);
  assert.deepEqual(JSON.parse(JSON.stringify(request.body.sorts)),[
    {property:'[SYS] Позиция',direction:'descending'},
    {timestamp:'created_time',direction:'descending'}
  ]);
  assert.equal(request.body.filter.and[3].select.equals,'Docs');
  assert.equal(request.body.filter.and[2].checkbox.equals,false);
});

test('hot and queried material paths share one atomic per-section position allocator', () => {
  function setup() {
    const backend=loadBackend();
    const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
    const values={};
    const props={
      getProperty:(key)=>Object.prototype.hasOwnProperty.call(values,key)?values[key]:null,
      getProperties:()=>({...values}),
      setProperty:(key,value)=>{values[key]=String(value);},
      setProperties:(next)=>{Object.assign(values,next);},
      deleteProperty:(key)=>{delete values[key];}
    };
    backend.PropertiesService={getScriptProperties:()=>props};
    backend.LockService={getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})};
    backend.w20RegistryReplaceTask_(taskId,[{
      id:'3c72d627-39a1-8120-bd0a-f969e6846945',name:'Существующий',section:'Docs',format:'Google Docs',provider:'Google Drive',
      openUrl:'https://docs.google.com/document/d/ExistingGoogleDoc123/edit',googleFileId:'ExistingGoogleDoc123',folderId:'TaskFolder12345',widgetOwned:true,position:7,syncStatus:'synced'
    }]);
    backend.w20RegistryWriteTaskMeta_(taskId,{taskName:'Задача',folderId:'TaskFolder12345',rootFolderId:'RootFolder12345',folderVerified:true,folderValidatedAt:new Date().toISOString()});
    return {backend,taskId};
  }

  const hotFirst=setup();
  assert.equal(hotFirst.backend.w20RegistryClaimCreateSlot_(hotFirst.taskId,'Docs','RootFolder12345').position,8);
  assert.equal(hotFirst.backend.w20RegistryReservePosition_(hotFirst.taskId,'Docs',8),9);
  assert.equal(hotFirst.backend.w20RegistryReservePosition_(hotFirst.taskId,'Sheets',0),0);

  const queriedFirst=setup();
  assert.equal(queriedFirst.backend.w20RegistryReservePosition_(queriedFirst.taskId,'Docs',8),8);
  assert.equal(queriedFirst.backend.w20RegistryClaimCreateSlot_(queriedFirst.taskId,'Docs','RootFolder12345').position,9);
  queriedFirst.backend.w19NotionRequest_=()=>({results:[{properties:{'[SYS] Позиция':{number:20}}}]});
  assert.equal(queriedFirst.backend.w19NextPosition_(queriedFirst.taskId,'Docs',{dataSourceId:'3822d627-39a1-8018-a2dc-000b95bf5722'}),21);
});

test('bootstrap metadata sync is a no-op when Drive metadata did not change', () => {
  const sync = backendSource.slice(backendSource.indexOf('function w19SyncOnePageUnlocked_'), backendSource.indexOf('function w19MarkSyncError_'));
  assert.match(sync, /if \(!Object\.keys\(props\)\.length\) return page;/);
  assert.doesNotMatch(sync, /LAST_SYNC|Последняя синхронизация/);
  assert.match(sync, /nameChanged/);
  assert.match(sync, /driveData\.name !== material\.downloadName/);
});

test('write-only SHA and last-sync properties are not required or written', () => {
  assert.doesNotMatch(backendSource, /W19_P\.(?:SHA256|LAST_SYNC)|\[SYS\] (?:SHA-256|Последняя синхронизация)/);
});

test('download API is restricted to widget-owned binary files below the configured limit', () => {
  const download = backendSource.slice(backendSource.indexOf('function apiDownload'), backendSource.indexOf('function apiSyncTask'));
  const guard = backendSource.slice(backendSource.indexOf('function w19AssertOwnedBinary_'), backendSource.indexOf('function w19IsDriveNotFound_'));
  assert.match(download, /w19AssertMaterialForTask_/);
  assert.match(download, /w19AssertOwnedBinary_/);
  assert.match(download, /w20FindOwnedBinaryMaterialByMarkers_/);
  assert.match(download, /DriveApp\.getFileById\(drive\.id\)\.getBlob\(\)/);
  assert.doesNotMatch(download, /UrlFetchApp/);
  assert.match(download, /Utilities\.base64Encode\(bytes\)/);
  assert.match(guard, /folderParents\.indexOf\(root\.id\) === -1/);
  assert.match(guard, /driveProps\.taskPageId !== compactTask/);
  assert.match(guard, /driveParents\.indexOf\(folder\.id\) === -1/);
  assert.match(guard, /DOWNLOAD_NATIVE_GOOGLE_FILE/);
  assert.match(guard, /size > cfg\.maxUploadBytes/);
});

test('prepare download revalidates Notion and Drive before issuing an opaque hosted-download grant', () => {
  const backend = loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e',pageId='3c72d627-39a1-81e1-971f-c6b30665ce55';
  const dataSourceId='3822d627-39a1-8018-a2dc-000b95bf5722';
  const signed='https://prod-files-secure.s3.us-west-2.amazonaws.com/space/file/report.xlsx?X-Amz-Signature=abc';
  const cache=new Map();
  backend.CacheService={getScriptCache:()=>({put:(key,value)=>cache.set(key,value),get:(key)=>cache.get(key)||null,remove:(key)=>cache.delete(key)})};
  backend.UrlFetchApp={fetch:(url,options)=>{
    assert.equal(url,signed);
    assert.equal(options.headers.Range,'bytes=0-0');
    return {getResponseCode:()=>206,getAllHeaders:()=>({'Content-Disposition':"attachment; filename*=UTF-8''report.xlsx"})};
  }};
  const cfg={authorizedTaskPageId:taskId,dataSourceId,notionToken:'test-notion-hmac-secret',deniedPageIds:{}};
  backend.w19AuthorizedConfig_=()=>cfg;
  backend.w19AssertMaterialForTask_=(receivedPage,receivedTask)=>({id:receivedPage,taskId:receivedTask});
  backend.w19MaterialFromPage_=()=>({
    id:pageId,name:'report.xlsx',downloadName:'report.xlsx',attachmentName:'report.xlsx',
    downloadUrl:signed,attachmentUrl:signed,attachmentExpiry:'2099-01-01T00:00:00.000Z',
    hostedAttachment:true,attachmentType:'file',widgetOwnedBinary:true,mimeType:'application/octet-stream',size:123
  });
  let guardCalls=0;
  backend.w19AssertOwnedBinary_=()=>{guardCalls+=1;return {id:'DRIVEFILE123',name:'report.xlsx',mimeType:'application/octet-stream',size:'123'};};
  const result=backend.apiPrepareDownload({taskPageId:taskId,pageId});
  assert.equal(result.ok,true);
  assert.equal(result.data.mode,'grant');
  assert.match(result.data.downloadGrant,/^[a-f0-9]{96}$/);
  assert.equal(result.data.url,undefined,'the priming client must never receive the direct hosted URL');
  assert.equal(backend.w20GetDownloadGrant_(taskId,pageId,result.data.downloadGrant,cfg).url,signed);
  assert.equal(guardCalls,1);
  backend.w19MaterialFromPage_=()=>({
    name:'report.xlsx',downloadName:'report.xlsx',attachmentName:'report.xlsx',
    downloadUrl:'https://evil.example/report.xlsx',attachmentUrl:'https://evil.example/report.xlsx',attachmentExpiry:'2099-01-01T00:00:00.000Z',
    hostedAttachment:true,attachmentType:'file',widgetOwnedBinary:true
  });
  const rejected=backend.apiPrepareDownload({taskPageId:taskId,pageId});
  assert.equal(rejected.ok,true);
  assert.equal(rejected.data.mode,'proxy');
  assert.equal(guardCalls,2);
});

test('prepare download keeps a direct hosted path only when attachment disposition has the exact renamed filename', () => {
  const backend = loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e',pageId='3c72d627-39a1-81e1-971f-c6b30665ce55';
  const dataSourceId='3822d627-39a1-8018-a2dc-000b95bf5722';
  const signed='https://prod-files-secure.s3.us-west-2.amazonaws.com/space/file/report.xlsx?X-Amz-Signature=abc';
  const cache=new Map();
  backend.CacheService={getScriptCache:()=>({put:(key,value)=>cache.set(key,value),get:(key)=>cache.get(key)||null,remove:(key)=>cache.delete(key)})};
  let disposition="attachment; filename*=UTF-8''%D0%9D%D0%BE%D0%B2%D0%BE%D0%B5%20%D0%B8%D0%BC%D1%8F.xlsx";
  backend.UrlFetchApp={fetch:()=>({getResponseCode:()=>206,getAllHeaders:()=>({'content-disposition':disposition})})};
  const cfg={authorizedTaskPageId:taskId,dataSourceId,notionToken:'test-notion-hmac-secret',deniedPageIds:{}};
  backend.w19AuthorizedConfig_=()=>cfg;
  backend.w19AssertMaterialForTask_=()=>({id:pageId});
  backend.w19MaterialFromPage_=()=>({
    id:pageId,name:'Новое имя.xlsx',downloadName:'Новое имя.xlsx',attachmentName:'Старое имя.xlsx',
    downloadUrl:signed,attachmentUrl:signed,attachmentExpiry:'2099-01-01T00:00:00.000Z',
    hostedAttachment:true,attachmentType:'file',widgetOwnedBinary:true,mimeType:'application/octet-stream',size:123
  });
  backend.w19AssertOwnedBinary_=()=>({id:'DRIVEFILE123',name:'Новое имя.xlsx',mimeType:'application/octet-stream',size:'123'});
  const result=backend.apiPrepareDownload({taskPageId:taskId,pageId});
  assert.equal(result.ok,true);
  assert.equal(result.data.mode,'grant');
  const direct=backend.w20GetDownloadGrant_(taskId,pageId,result.data.downloadGrant,cfg);
  assert.equal(direct.name,'Новое имя.xlsx');
  assert.equal(direct.url,signed);
  disposition="inline; filename*=UTF-8''%D0%9D%D0%BE%D0%B2%D0%BE%D0%B5%20%D0%B8%D0%BC%D1%8F.xlsx";
  assert.equal(backend.apiPrepareDownload({taskPageId:taskId,pageId}).data.mode,'proxy');
  disposition="attachment; filename*=UTF-8''%D0%A1%D1%82%D0%B0%D1%80%D0%BE%D0%B5%20%D0%B8%D0%BC%D1%8F.xlsx";
  assert.equal(backend.apiPrepareDownload({taskPageId:taskId,pageId}).data.mode,'proxy');
});

test('download grants are HMAC-bound to task and page, expire in 60 seconds and are revoked with the material cache', () => {
  const backend=loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e',otherTask='3c62d627-39a1-80a1-aac7-ec19ffc9ef8f';
  const pageId='3c72d627-39a1-81e1-971f-c6b30665ce55',otherPage='3c72d627-39a1-81e1-971f-c6b30665ce56';
  const dataSourceId='3822d627-39a1-8018-a2dc-000b95bf5722';
  const cfg={authorizedTaskPageId:taskId,dataSourceId,notionToken:'test-notion-hmac-secret',deniedPageIds:{}};
  const values=new Map(),writes=[];
  let now=1_800_000_000_000;
  const RealDate=Date;
  function TestDate(...args){return new RealDate(...args);}
  TestDate.now=()=>now;TestDate.parse=RealDate.parse;TestDate.prototype=RealDate.prototype;
  backend.Date=TestDate;
  backend.CacheService={getScriptCache:()=>({
    put:(key,value,ttl)=>{values.set(key,value);writes.push({key,ttl});},
    get:(key)=>values.get(key)||null,
    remove:(key)=>values.delete(key),
    removeAll:(keys)=>keys.forEach((key)=>values.delete(key))
  })};
  backend.Utilities.getUuid=()=> '12345678-1234-4abc-8def-1234567890ab';
  const direct={mode:'direct',url:'https://prod-files-secure.s3.us-west-2.amazonaws.com/space/file/report.xlsx?X-Amz-Signature=abc',name:'report.xlsx',mimeType:'application/octet-stream',size:123,expiresAt:'2099-01-01T00:00:00.000Z'};

  const issued=backend.w20IssueDownloadGrant_(taskId,pageId,direct,cfg);
  assert.equal(issued.mode,'grant');
  assert.match(issued.downloadGrant,/^[a-f0-9]{96}$/);
  assert.equal(writes[0].ttl,60);
  assert.equal(Date.parse(issued.expiresAt)-now,60_000);
  const overlapping=backend.w20IssueDownloadGrant_(taskId,pageId,direct,cfg);
  assert.equal(overlapping.downloadGrant,issued.downloadGrant,'overlapping prime must reuse the still-valid grant');
  assert.equal(writes.length,1,'overlapping prime must not overwrite the cache entry');
  assert.equal(backend.w20GetDownloadGrant_(taskId,pageId,issued.downloadGrant,cfg).url,direct.url);
  assert.equal(backend.w20GetDownloadGrant_(otherTask,pageId,issued.downloadGrant,{...cfg,authorizedTaskPageId:otherTask}),null);
  assert.equal(backend.w20GetDownloadGrant_(taskId,otherPage,issued.downloadGrant,cfg),null);
  assert.equal(backend.w20GetDownloadGrant_(taskId,pageId,issued.downloadGrant,{...cfg,deniedPageIds:{[taskId]:true}}),null);
  assert.equal(backend.w20GetDownloadGrant_(taskId,pageId,`f${issued.downloadGrant.slice(1)}`,cfg),null);
  assert.ok(backend.w20GetDownloadGrant_(taskId,pageId,issued.downloadGrant,cfg),'a bad token must not revoke the real grant');

  backend.w20InvalidateDownloadMaterialCache_(taskId,pageId);
  assert.equal(backend.w20GetDownloadGrant_(taskId,pageId,issued.downloadGrant,cfg),null);
  const replacement=backend.w20IssueDownloadGrant_(taskId,pageId,direct,cfg);
  assert.notEqual(replacement.downloadGrant,issued.downloadGrant,'revocation epoch must bind replacement grants');
  now+=60_001;
  assert.equal(backend.w20GetDownloadGrant_(taskId,pageId,replacement.downloadGrant,cfg),null);
});

test('download POST redeems a valid grant from cache without Notion or Drive and invalid grants fall back safely', () => {
  const backend=loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e',pageId='3c72d627-39a1-81e1-971f-c6b30665ce55';
  const cfg={authorizedTaskPageId:taskId,dataSourceId:'3822d627-39a1-8018-a2dc-000b95bf5722',notionToken:'test-notion-hmac-secret',deniedPageIds:{}};
  const accessToken='A'.repeat(48),values=new Map();
  backend.CacheService={getScriptCache:()=>({put:(key,value)=>values.set(key,value),get:(key)=>values.get(key)||null,remove:(key)=>values.delete(key),removeAll:(keys)=>keys.forEach((key)=>values.delete(key))})};
  backend.Utilities.getUuid=()=> '12345678-1234-4abc-8def-1234567890ab';
  const issued=backend.w20IssueDownloadGrant_(taskId,pageId,{mode:'direct',url:'https://prod-files-secure.s3.us-west-2.amazonaws.com/space/file/report.xlsx?X-Amz-Signature=abc',name:'report.xlsx',mimeType:'application/octet-stream',size:123,expiresAt:'2099-01-01T00:00:00.000Z'},cfg);
  let authCalls=0;
  backend.w19AuthorizedConfig_=()=>{authCalls+=1;return cfg;};
  backend.w19AssertMaterialForTask_=()=>{throw new Error('valid POST grant must make zero Notion calls');};
  backend.w19AssertOwnedBinary_=()=>{throw new Error('valid POST grant must make zero Drive calls');};
  const rendered=[];
  const output={setTitle(){return this;},setXFrameOptionsMode(){return this;},addMetaTag(){return this;}};
  backend.HtmlService={XFrameOptionsMode:{ALLOWALL:'ALLOWALL'},createTemplateFromFile(name){assert.equal(name,'Download');const template={evaluate(){rendered.push({runtime:template.runtimeParamsJson,result:template.precomputedResultJson});return output;}};return template;}};
  const event={parameters:{task:[taskId],accessToken:[accessToken],downloadPageId:[pageId],downloadTicket:[issued.downloadGrant]},postData:{type:'application/x-www-form-urlencoded'}};
  assert.equal(backend.doPost(event),output);
  assert.equal(rendered[0].runtime,'{}');
  const precomputed=JSON.parse(rendered[0].result);
  assert.equal(precomputed.mode,'direct');
  assert.equal(precomputed.downloadTicket,issued.downloadGrant);
  assert.equal(authCalls,1);

  backend.doPost({...event,parameters:{...event.parameters,downloadTicket:['f'.repeat(96)]}});
  assert.equal(JSON.parse(rendered[1].result),null);
  assert.deepEqual(JSON.parse(rendered[1].runtime),{task:taskId,accessToken,downloadPageId:pageId,downloadTicket:'f'.repeat(96)});
  assert.equal(authCalls,2);
  backend.doPost({...event,parameters:{...event.parameters,extra:['forbidden']}});
  backend.doPost({...event,parameters:{...event.parameters,task:[taskId,taskId]}});
  assert.equal(authCalls,2,'extra and duplicate POST fields must fail before authorization');
  assert.equal(JSON.parse(rendered[2].result),null);
  assert.equal(JSON.parse(rendered[3].result),null);
});

test('deployment contract supports a capability-authenticated iframe with full Drive metadata access', () => {
  assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/drive'));
  assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/script.scriptapp'));
  assert.ok(!manifest.oauthScopes.includes('https://www.googleapis.com/auth/drive.file'));
  assert.deepEqual(manifest.webapp, { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_DEPLOYING' });
  assert.match(backendSource, /AUTHORIZED_TASK_PAGE_ID/);
  assert.match(backendSource, /WIDGET_ACCESS_TOKEN_SHA256/);
  assert.match(backendSource, /Session\.getActiveUser\(\).*Административный запуск/s);
});

test('Drive idempotency marker is linked back to the resulting Notion page', () => {
  assert.match(backendSource, /appProperties:\s*\{[\s\S]*widgetIdem:[\s\S]*notionPageId:/);
  assert.match(backendSource, /w19MarkDriveNotionPage_\(driveFile, task\.id, idemHash, page\.id, 'active'\)/);
});
