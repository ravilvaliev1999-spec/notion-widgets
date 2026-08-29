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
const creatorSource = fs.readFileSync(path.join(root, 'Create.html'), 'utf8');
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
    decodeURIComponent,
    console: { log() {} },
    WidgetV19Core: core,
    Session: { getActiveUser: () => ({ getEmail: () => activeEmail }) },
    PropertiesService: { getScriptProperties: () => defaultScriptProperties },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }),
      getUserLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} })
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256', MD5: 'MD5' },
      getUuid: () => crypto.randomUUID(),
      newBlob: (value) => ({ getBytes: () => [...Buffer.from(String(value), 'utf8')] }),
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64url'),
      computeDigest: (algorithm, bytes) => [...crypto.createHash(algorithm === 'MD5' ? 'md5' : 'sha256').update(Buffer.from(bytes)).digest()],
      computeHmacSha256Signature: (value, key) => [...crypto.createHmac('sha256', String(key)).update(String(value)).digest()]
    }
  });
  vm.runInContext(backendSource, context, { filename: 'Code.gs' });
  vm.runInContext(registrySource, context, { filename: 'Registry.gs' });
  return context;
}

function installReservationDriveMock(backend) {
  const files=new Map();
  let sequence=0,creates=0,updates=0,lists=0,gets=0;
  const copy=(value)=>value==null?value:JSON.parse(JSON.stringify(value));
  const matching=(file,query)=>{
    if(file.trashed)return false;
    const parent=String(query||'').match(/'([^']+)' in parents/);
    if(parent&&!file.parents.includes(parent[1]))return false;
    for(const match of String(query||'').matchAll(/key='([^']+)' and value='([^']*)'/g)){
      if(String(file.appProperties&&file.appProperties[match[1]]||'')!==match[2])return false;
    }
    return true;
  };
  backend.Drive={Files:{
    list(options){lists+=1;return {files:Array.from(files.values()).filter((file)=>matching(file,options&&options.q)).slice(0,Number(options&&options.pageSize)||100).map(copy)};},
    create(resource){
      creates+=1;sequence+=1;
      const id=`ReservedGoogleFile${String(sequence).padStart(3,'0')}`;
      const file={id,name:resource.name,mimeType:resource.mimeType,modifiedTime:new Date().toISOString(),ownedByMe:true,trashed:false,parents:[...(resource.parents||[])],appProperties:{...(resource.appProperties||{})}};
      file.webViewLink=backend.WidgetV19Core.makeDriveOpenUrl(id,resource.mimeType==='application/vnd.google-apps.document'?'Google Docs':resource.mimeType==='application/vnd.google-apps.spreadsheet'?'Google Sheets':'Google Slides');
      files.set(id,file);return copy(file);
    },
    get(fileId){gets+=1;if(!files.has(String(fileId)))throw new Error('not found');return copy(files.get(String(fileId)));},
    update(resource,fileId,_media,options){
      updates+=1;
      const file=files.get(String(fileId));if(!file)throw new Error('not found');
      if(Object.prototype.hasOwnProperty.call(resource||{},'name'))file.name=resource.name;
      if(Object.prototype.hasOwnProperty.call(resource||{},'trashed'))file.trashed=resource.trashed===true;
      for(const [key,value] of Object.entries(resource&&resource.appProperties||{})){
        if(value===null)delete file.appProperties[key];else file.appProperties[key]=String(value);
      }
      const parents=new Set(file.parents);
      if(options&&options.removeParents)String(options.removeParents).split(',').filter(Boolean).forEach((id)=>parents.delete(id));
      if(options&&options.addParents)String(options.addParents).split(',').filter(Boolean).forEach((id)=>parents.add(id));
      file.parents=[...parents];return copy(file);
    }
  }};
  return {files,get creates(){return creates;},get updates(){return updates;},get lists(){return lists;},get gets(){return gets;}};
}

function installReservationV2Harness() {
  const backend=loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const rootFolderId='RootFolder12345',taskFolderId='TaskFolder12345';
  const cfg={
    authorizedTaskPageId:taskId,deniedPageIds:{},rootFolderId,taskFolderId,
    dataSourceId:'3822d627-39a1-8018-a2dc-000b95bf5722',maxUploadBytes:8388608,
    notionToken:'test-reservation-v2-hmac-secret'
  };
  backend.Utilities.formatDate=()=> '2026-08-28 12:00';
  const drive=installReservationDriveMock(backend);
  const replacement=backend.w20RegistryReplaceTaskResult_(taskId,[]);
  assert.equal(replacement.ok,true);
  const validatedAt=new Date().toISOString();
  backend.w20RegistryWriteTaskMeta_(taskId,{
    taskName:'Задача',folderId:taskFolderId,rootFolderId,folderVerified:true,
    folderValidatedAt:validatedAt,taskValidatedAt:validatedAt,snapshotValidatedAt:validatedAt,
    snapshotActiveCount:replacement.activeCount,
    context:{path:'Основная / Задача',ancestorIds:'ancestor',depth:2,sphereIds:[],directionIds:[],projectIds:[]}
  });
  backend.w19AuthorizedConfig_=()=>cfg;
  backend.w19AssertSchema_=()=>{};
  return {backend,taskId,rootFolderId,taskFolderId,cfg,drive};
}

function installUploadApiHarness({ recovery = false, slot, existingPage = null } = {}) {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const cfg = {
    authorizedTaskPageId: taskId,
    deniedPageIds: {},
    rootFolderId: 'TrustedRootFolder123',
    maxUploadBytes: 8 * 1024 * 1024,
    dataSourceId: '3822d627-39a1-8018-a2dc-000b95bf5722',
    notionVersion: '2026-03-11',
    notionToken: 'test-notion-hmac-secret'
  };
  const trustedMeta = {
    taskName: 'Проверенная задача',
    folderId: 'TrustedTaskFolder123',
    context: { sphereIds: [], directionIds: [], projectIds: [], path: '', ancestorIds: '', depth: 0 }
  };
  const chosenSlot = slot === undefined ? { taskMeta: trustedMeta, position: 7 } : slot;
  const driveFile = {
    id: 'UploadedDriveFile123',
    name: 'brief.pdf',
    mimeType: 'application/pdf',
    size: '3',
    md5Checksum: 'abc123',
    webViewLink: 'https://drive.google.com/file/d/UploadedDriveFile123/view'
  };
  const createdPage = {
    id: '3c72d627-39a1-8120-bd0a-f969e6846945',
    material: {
      id: '3c72d627-39a1-8120-bd0a-f969e6846945',
      name: 'brief.pdf',
      section: 'Docs',
      format: 'PDF',
      provider: 'Google Drive',
      openUrl: driveFile.webViewLink,
      googleFileId: driveFile.id,
      folderId: chosenSlot && chosenSlot.taskMeta ? chosenSlot.taskMeta.folderId : 'FallbackTaskFolder123',
      widgetOwned: true,
      widgetOwnedBinary: true,
      syncStatus: 'synced',
      archived: false,
      position: chosenSlot ? chosenSlot.position : 23
    }
  };
  const calls = {
    schema: 0,
    limit: 0,
    claim: [],
    taskAssert: 0,
    idemLookup: 0,
    folder: 0,
    driveLookup: 0,
    fileLookup: 0,
    createBinary: [],
    notionUpload: [],
    notionCreate: [],
    nextPosition: 0,
    driveMetadata: 0,
    marker: [],
    cache: [],
    registry: [],
    queue: [],
    idempotencyKey: ''
  };

  backend.Utilities.base64Decode = (value) => [...Buffer.from(String(value), 'base64')];
  backend.w19AuthorizedConfig_ = () => cfg;
  backend.w19AssertSchema_ = () => { calls.schema += 1; return { ok: true }; };
  backend.w19EffectiveUploadLimit_ = () => { calls.limit += 1; return 1024; };
  backend.w19WithIdempotency_ = (key, fn) => {
    calls.idempotencyKey = key;
    return fn({ recovery, attemptId: '1185d2e2-4728-4bcd-b22d-67a27a7928c3' });
  };
  backend.w19WithMutationLock_ = (fn) => fn();
  backend.w20RegistryClaimCreateSlot_ = (...args) => { calls.claim.push(args); return chosenSlot; };
  backend.w19AssertTaskPage_ = (value) => {
    calls.taskAssert += 1;
    assert.equal(value, taskId);
    return { id: taskId, name: 'Проверенная задача', page: { properties: {} } };
  };
  backend.w19FindMaterialByIdempotency_ = () => { calls.idemLookup += 1; return existingPage; };
  backend.w19EnsureTaskFolder_ = () => { calls.folder += 1; return { id: 'FallbackTaskFolder123' }; };
  backend.w19FindDriveByIdempotency_ = () => { calls.driveLookup += 1; return null; };
  backend.w19FindMaterialByGoogleFile_ = () => { calls.fileLookup += 1; return null; };
  backend.w19NextPosition_ = () => { calls.nextPosition += 1; return 23; };
  backend.w19CreateBinaryFile_ = (...args) => { calls.createBinary.push(args); return driveFile; };
  backend.w19CreateAndSendNotionUpload_ = (...args) => {
    calls.notionUpload.push(args);
    return { id: '43833259-72ae-404e-8441-b6577f3159b4' };
  };
  backend.w19CreateNotionMaterial_ = (task, data, receivedCfg) => {
    calls.notionCreate.push({ task, data, cfg: receivedCfg });
    createdPage.material.folderId = data.googleFolderId;
    createdPage.material.position = data.position;
    createdPage.material.idempotency = data.idempotency;
    return createdPage;
  };
  backend.w19MaterialFromPage_ = (page) => page.material;
  backend.w19GetDriveMetadata_ = () => { calls.driveMetadata += 1; return driveFile; };
  backend.w19MarkDriveNotionPage_ = (...args) => { calls.marker.push(args); return true; };
  backend.w20CacheDownloadMaterials_ = (...args) => calls.cache.push(args);
  backend.w20RegistryUpsert_ = (...args) => { calls.registry.push(args); return true; };
  backend.w20TryEnqueueAttachmentJob_ = (...args) => { calls.queue.push(args); return { state: 'pending' }; };

  return {
    backend,
    taskId,
    cfg,
    calls,
    driveFile,
    createdPage,
    input: {
      taskPageId: taskId,
      idempotencyKey: 'upload-request-0001',
      name: 'brief.pdf',
      mimeType: 'application/pdf',
      dataBase64: 'AQID',
      section: 'Docs',
      folderId: 'CallerControlledFolder999',
      position: 999
    }
  };
}

function installOuterMutationHarness() {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-8120-bd0a-f969e6846945';
  const binding = 'a'.repeat(64);
  const nextBinding = 'b'.repeat(64);
  const accessToken = 'outer_mutation_capability_0123456789_ABCDEFGH';
  const requestId = '12345678-1234-4abc-8def-1234567890ab';
  const cfg = {
    authorizedTaskPageId: taskId,
    deniedPageIds: {},
    notionToken: 'server-only-signing-secret',
    rootFolderId: 'TrustedRootFolder123'
  };
  const current = {
    id: pageId,
    name: 'Исходное имя',
    section: 'Docs',
    format: 'Google Docs',
    provider: 'Google Drive',
    googleFileId: 'NativeGoogleDoc123',
    widgetOwned: true,
    syncStatus: 'synced',
    position: 4,
    idempotency: 'server-private-original-key',
    openUrl: 'https://docs.google.com/document/d/NativeGoogleDoc123/edit'
  };
  const calls = {
    fresh: 0,
    auth: 0,
    canonical: [],
    idempotency: [],
    locks: 0,
    notionGet: 0,
    notionIncludeArchived: [],
    invalidations: 0,
    cancelled: 0,
    driveState: [],
    driveRename: [],
    notionUpdate: [],
    registryRemove: 0,
    registryUpsert: 0
  };
  backend.w19AuthorizedConfig_ = (input) => {
    calls.auth += 1;
    assert.deepEqual(JSON.parse(JSON.stringify(input)), { taskPageId: taskId, accessToken });
    return cfg;
  };
  backend.w20FreshRegistryMaterialByNavigationBinding_ = (receivedTask, receivedBinding, receivedCfg) => {
    calls.fresh += 1;
    assert.equal(receivedTask, taskId);
    assert.equal(receivedBinding, binding);
    assert.equal(receivedCfg, cfg);
    return current;
  };
  backend.w19CanonicalIdempotency_ = (...args) => {
    calls.canonical.push(args);
    return 'server-private-canonical-key';
  };
  backend.w19WithIdempotency_ = (key, operation) => {
    calls.idempotency.push(key);
    return operation({ recovery: false });
  };
  backend.w19WithMutationLock_ = (operation) => {
    calls.locks += 1;
    return operation();
  };
  backend.w19AssertMaterialForTask_ = (receivedPage, receivedTask, receivedCfg, includeArchived) => {
    calls.notionGet += 1;
    assert.equal(receivedPage, pageId);
    assert.equal(receivedTask, taskId);
    assert.equal(receivedCfg, cfg);
    assert.equal(typeof includeArchived, 'boolean');
    calls.notionIncludeArchived.push(includeArchived);
    return { id: pageId, in_trash: false };
  };
  backend.w19MaterialFromPage_ = () => ({ ...current });
  backend.w20NavigationBinding_ = (material) => material.navigationBinding || binding;
  backend.w20InvalidateDownloadMaterialCache_ = () => { calls.invalidations += 1; };
  backend.w20CancelAttachmentJob_ = () => { calls.cancelled += 1; return true; };
  backend.w20SetDriveMaterialState_ = (_material, receivedTask, state) => {
    calls.driveState.push({ task: receivedTask, state });
  };
  backend.w19DriveRetry_ = (operation) => operation();
  backend.Drive = { Files: {
    update(resource, fileId) {
      calls.driveRename.push({ resource, fileId });
      return { id: fileId, name: resource.name };
    },
    delete() { throw new Error('outer mutation must never delete a Drive file'); },
    remove() { throw new Error('outer mutation must never remove a Drive file'); }
  } };
  backend.w19UpdateNotionPage_ = (receivedPage, properties) => {
    calls.notionUpdate.push({ pageId: receivedPage, properties });
    return { id: pageId, updated: true };
  };
  backend.w20RegistryRemove_ = () => { calls.registryRemove += 1; return true; };
  backend.w20RegistryUpsert_ = () => { calls.registryUpsert += 1; return true; };
  backend.w19NextPosition_ = () => 9;
  backend.w20MaterialForClient_ = (material) => ({
    name: material.name,
    section: material.section,
    format: material.format,
    position: material.position,
    navigationBinding: nextBinding,
    id: pageId,
    googleFileId: current.googleFileId,
    accessToken,
    idempotency: current.idempotency,
    openUrl: current.openUrl
  });
  return {
    backend,
    taskId,
    pageId,
    binding,
    nextBinding,
    accessToken,
    requestId,
    cfg,
    current,
    calls,
    fields(payload) {
      return { valid: true, taskPageId: taskId, accessToken, requestId, payload };
    }
  };
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
  const fastCapability = loadBackend('');
  fastCapability.Session.getActiveUser=()=>{throw new Error('Session must not run for a valid capability');};
  assert.equal(fastCapability.w19AssertViewer_(cfg, { taskPageId: task, accessToken: token }), 'capability');
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

test('runtime config reads Script Properties from one snapshot', () => {
  const source=backendSource.slice(backendSource.indexOf('function w19Config_'),backendSource.indexOf('function w19AssertViewer_'));
  assert.match(source,/var values = props\.getProperties\(\)/);
  assert.doesNotMatch(source,/props\.getProperty\(/);
  for(const key of ['ALLOWED_EMAIL','NOTION_TOKEN','NOTION_DATA_SOURCE_ID','AUTHORIZED_TASK_PAGE_ID','WIDGET_ACCESS_TOKEN_SHA256','MAX_UPLOAD_BYTES','ROOT_DRIVE_FOLDER_ID','NOTION_VERSION','DENIED_NOTION_PAGE_IDS','DENIED_NOTION_DATA_SOURCE_IDS']){
    assert.match(source,new RegExp(`values\\.${key}`));
  }
});

test('confirmed owner identity remains an independent authorization path', () => {
  const owner = loadBackend('owner@example.com');
  assert.equal(owner.w19AssertViewer_({ allowedEmail: 'owner@example.com' }, {}), 'owner');
});

test('every public data API authenticates the same input payload', () => {
  for (const name of [
    'apiBootstrap', 'apiCreateGoogle', 'apiGetCreateStatus', 'apiWarmCreateContext', 'apiAddLink', 'apiUpload', 'apiUpdateMaterial',
    'apiReorder', 'apiDeletePhysical', 'apiPrepareDownload', 'apiDownload', 'apiFinalizeUploadAttachment',
    'apiPollDriveMetadata', 'apiSyncTask', 'w19SetArchiveState_'
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
  assert.match(doGet, /createTemplateFromFile\('Index'\)/);
  assert.match(doGet, /initialBootstrapJson = 'null'/);
  assert.match(doGet, /runtimeParamsJson = JSON\.stringify\(\{/);
  for (const field of ['task', 'accessToken', 'clientId', 'embedNonce', 'release']) {
    assert.match(doGet, new RegExp(`${field}:`));
  }
  assert.match(doGet, /var initialProperties = PropertiesService\.getScriptProperties\(\)\.getProperties\(\)/);
  assert.match(doGet, /w19AuthorizedConfigFromValues_\(initialInput, initialProperties\)/);
  assert.match(doGet, /w20BootstrapFromRegistry_\(initialInput, initialCfg, null, \{/);
  assert.match(doGet, /propertyValues: initialProperties/);
  assert.match(doGet, /issueDrivePollClaims: false/);
  assert.match(doGet, /seedDownloadCache: false/);
  assert.match(doGet, /includeServiceUrl: true/);
  assert.match(doGet, /indexTemplate\.initialBootstrapJson = JSON\.stringify\(initialBootstrap\)/);
  assert.doesNotMatch(doGet, /initialBootstrapJson\s*=\s*JSON\.stringify\([^\n]*accessToken/);
  assert.match(doGet, /XFrameOptionsMode\.ALLOWALL/);
  assert.match(doGet, /function doPost\(event\)/);
  assert.match(doGet, /w20CreatePostFields_\(event\)/);
  assert.match(doGet, /template\.runtimeParamsJson = '\{\}'/);
  assert.match(doGet, /template\.precomputedResultJson = JSON\.stringify\(result\)/);
});

test('Index GET injects exactly the already-received runtime coordinates so startup skips the five-second location wait', () => {
  const backend=loadBackend();
  const task='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e',accessToken='a'.repeat(64);
  const clientId='12345678-1234-4abc-8def-1234567890ab',embedNonce='0123456789abcdef0123456789abcdef';
  const rendered=[];
  const output={setTitle(){return this;},setXFrameOptionsMode(){return this;},addMetaTag(){return this;}};
  backend.HtmlService={
    XFrameOptionsMode:{ALLOWALL:'ALLOWALL'},
    createTemplateFromFile(name){
      assert.equal(name,'Index');
      const template={evaluate(){rendered.push({runtime:template.runtimeParamsJson,bootstrap:template.initialBootstrapJson});return output;}};
      return template;
    }
  };
  assert.equal(backend.doGet({parameter:{task,accessToken,clientId,embedNonce,release:'v54'}}),output);
  assert.deepEqual(JSON.parse(rendered[0].runtime),{task,accessToken,clientId,embedNonce,release:'v54'});
  assert.equal(rendered[0].bootstrap,'null');
});

test('create GET rendezvous renders exactly four runtime values without executing creation', () => {
  const backend=loadBackend();
  const task='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e',requestId='12345678-1234-4abc-8def-1234567890ab',accessToken='a'.repeat(64);
  const rendered=[];
  const output={setTitle(){return this;},setXFrameOptionsMode(){return this;},addMetaTag(){return this;}};
  backend.HtmlService={
    XFrameOptionsMode:{ALLOWALL:'ALLOWALL'},
    createTemplateFromFile(name){
      assert.equal(name,'Create');
      const template={evaluate(){rendered.push({runtime:template.runtimeParamsJson,result:template.precomputedResultJson});return output;}};
      return template;
    },
    createHtmlOutputFromFile(){throw new Error('create GET must not render Index');}
  };
  backend.apiCreateGoogle=()=>{throw new Error('doGet must not execute creation');};
  assert.equal(backend.doGet({parameter:{task,accessToken,createSection:'Docs',createRequestId:requestId}}),output);
  const runtime=JSON.parse(rendered[0].runtime);
  assert.deepEqual(Object.keys(runtime).sort(),['accessToken','createRequestId','createSection','task']);
  assert.deepEqual(runtime,{task,accessToken,createSection:'Docs',createRequestId:requestId});
  assert.equal(rendered[0].result,'null');
  assert.match(creatorSource,/apiGetCreateStatus\(input\)/);
  assert.doesNotMatch(creatorSource,/\.apiCreateGoogle\(/);
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

test('outer mutation POST parser accepts only four single form fields and an exact bounded payload schema', () => {
  const backend = loadBackend();
  const task = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const requestId = '12345678-1234-4abc-8def-1234567890ab';
  const accessToken = 'outer_mutation_capability_0123456789_ABCDEFGH';
  const binding = 'a'.repeat(64);
  const makeEvent = (payload, overrides = {}) => ({
    parameters: {
      task: [task],
      accessToken: [accessToken],
      mutationRequestId: [requestId],
      mutationPayload: [JSON.stringify(payload)]
    },
    postData: { type: 'application/x-www-form-urlencoded; charset=UTF-8' },
    ...overrides
  });

  const hide = backend.w20MutationPostFields_(makeEvent({ kind: 'hide', binding }));
  assert.deepEqual(JSON.parse(JSON.stringify(hide)), {
    valid: true,
    taskPageId: task,
    accessToken,
    requestId,
    payload: { kind: 'hide', binding }
  });
  const edit = backend.w20MutationPostFields_(makeEvent({ kind: 'edit', binding, name: '  Новое   имя  ', section: 'Sheets' }));
  assert.equal(edit.valid, true);
  assert.deepEqual(JSON.parse(JSON.stringify(edit.payload)), { kind: 'edit', binding, name: 'Новое имя', section: 'Sheets' });

  const malformed = [
    makeEvent({ kind: 'hide', binding }, { parameters: { task: [task], accessToken: [accessToken], mutationRequestId: [requestId] } }),
    makeEvent({ kind: 'hide', binding }, { postData: undefined }),
    makeEvent({ kind: 'hide', binding }, { parameters: { ...makeEvent({ kind: 'hide', binding }).parameters, extra: ['forbidden'] } }),
    makeEvent({ kind: 'hide', binding }, { parameters: { ...makeEvent({ kind: 'hide', binding }).parameters, task: [task, task] } }),
    makeEvent({ kind: 'hide', binding }, { postData: { type: 'application/json' } }),
    makeEvent({ kind: 'hide', binding }, { queryString: 'task=must-not-be-in-url' }),
    makeEvent({ kind: 'hide', binding, pageId: 'attacker-controlled' }),
    makeEvent({ kind: 'edit', binding, name: 'Новое имя', section: 'Docs', idempotencyKey: 'leak' }),
    makeEvent({ kind: 'edit', binding, name: '', section: 'Docs' }),
    makeEvent({ kind: 'edit', binding, name: 'x'.repeat(181), section: 'Docs' }),
    makeEvent({ kind: 'edit', binding, name: 'Новое имя', section: 'Unknown' }),
    makeEvent({ kind: 'unknown', binding }),
    makeEvent({ kind: 'hide', binding: 'a'.repeat(63) }),
    makeEvent({ kind: 'hide', binding }, { parameters: { ...makeEvent({ kind: 'hide', binding }).parameters, mutationRequestId: ['12345678-1234-1abc-8def-1234567890ab'] } }),
    makeEvent({ kind: 'hide', binding }, { parameters: { ...makeEvent({ kind: 'hide', binding }).parameters, accessToken: ['short'] } }),
    makeEvent({ kind: 'hide', binding }, { parameters: { ...makeEvent({ kind: 'hide', binding }).parameters, mutationPayload: ['{not-json'] } }),
    makeEvent({ kind: 'hide', binding }, { parameters: { ...makeEvent({ kind: 'hide', binding }).parameters, mutationPayload: ['x'.repeat(1001)] } })
  ];
  malformed.forEach((event, index) => assert.equal(backend.w20MutationPostFields_(event).valid, false, `malformed case ${index}`));
});

test('courier router selects exactly one route and rejects mixed create, download and mutation fields', () => {
  const backend = loadBackend();
  const event = (keys) => ({ parameters: Object.fromEntries(keys.map((key) => [key, ['value']])) });
  assert.equal(backend.w20CourierPostKind_(event(['createRequestId'])), 'create');
  assert.equal(backend.w20CourierPostKind_(event(['createSection'])), 'create');
  assert.equal(backend.w20CourierPostKind_(event(['downloadTicket'])), 'download');
  assert.equal(backend.w20CourierPostKind_(event(['downloadPageId'])), 'download');
  assert.equal(backend.w20CourierPostKind_(event(['mutationRequestId'])), 'mutation');
  assert.equal(backend.w20CourierPostKind_(event(['mutationPayload'])), 'mutation');
  assert.equal(backend.w20CourierPostKind_(event(['createRequestId', 'downloadTicket'])), '');
  assert.equal(backend.w20CourierPostKind_(event(['createSection', 'mutationPayload'])), '');
  assert.equal(backend.w20CourierPostKind_(event(['downloadPageId', 'mutationRequestId'])), '');
  assert.equal(backend.w20CourierPostKind_(event(['createRequestId', 'downloadTicket', 'mutationRequestId'])), '');
  assert.equal(backend.w20CourierPostKind_({ parameters: {} }), '');
});

test('outer hide rechecks the registry under the mutation lock, archives only metadata and never deletes Drive', () => {
  const fixture = installOuterMutationHarness();
  const { backend, taskId, pageId, binding, requestId, current, calls } = fixture;
  const response = backend.w20ApplyOuterMutation_(fixture.fields({ kind: 'hide', binding }));
  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    data: { kind: 'hide', binding, material: null }
  });
  assert.equal(calls.fresh, 2, 'the signed registry binding is checked before and inside the lock');
  assert.equal(calls.locks, 1);
  assert.equal(calls.notionGet, 1, 'one exact authoritative Notion page check is retained');
  assert.deepEqual(calls.notionIncludeArchived, [true]);
  assert.equal(calls.invalidations, 1);
  assert.equal(calls.cancelled, 1);
  assert.deepEqual(calls.driveState, [{ task: taskId, state: 'archived' }]);
  assert.equal(calls.notionUpdate.length, 1);
  assert.equal(calls.notionUpdate[0].pageId, pageId);
  assert.equal(calls.notionUpdate[0].properties['Архив'].checkbox, true);
  assert.equal(calls.notionUpdate[0].properties['[SYS] Sync status'].select.name, 'archived');
  assert.equal(calls.registryRemove, 1);
  assert.deepEqual(calls.canonical, [[taskId, `outer-hide-${binding}`, requestId]]);
  assert.deepEqual(calls.idempotency, ['server-private-canonical-key']);
  assert.equal(current.googleFileId, 'NativeGoogleDoc123', 'the underlying Drive file remains intact');
});

test('an identical successful outer mutation retry returns the ledger result before resolving the consumed binding', () => {
  const fixture = installOuterMutationHarness();
  const originalFresh = fixture.backend.w20FreshRegistryMaterialByNavigationBinding_;
  const completed = new Map();
  let bindingStillLive = true;
  fixture.backend.w20FreshRegistryMaterialByNavigationBinding_ = (...args) => bindingStillLive ? originalFresh(...args) : null;
  fixture.backend.w19WithIdempotency_ = (key, operation) => {
    fixture.calls.idempotency.push(key);
    if (completed.has(key)) return completed.get(key);
    const result = operation({ recovery: false });
    completed.set(key, result);
    return result;
  };
  const fields = fixture.fields({ kind: 'hide', binding: fixture.binding });
  const first = fixture.backend.w20ApplyOuterMutation_(fields);
  bindingStillLive = false;
  const retry = fixture.backend.w20ApplyOuterMutation_(fields);
  assert.deepEqual(JSON.parse(JSON.stringify(retry)), JSON.parse(JSON.stringify(first)));
  assert.equal(retry.ok, true);
  assert.equal(fixture.calls.fresh, 2, 'the replay never tries to resolve the binding after hide consumed it');
  assert.equal(fixture.calls.notionUpdate.length, 1, 'the replay cannot repeat the Notion mutation');
  assert.equal(fixture.calls.registryRemove, 1, 'the replay cannot write a second tombstone');
});

test('outer mutation fails closed when the registry proof is stale initially or changes before the locked recheck', () => {
  const initial = installOuterMutationHarness();
  initial.backend.w20FreshRegistryMaterialByNavigationBinding_ = () => null;
  const initialResponse = initial.backend.w20ApplyOuterMutation_(initial.fields({ kind: 'hide', binding: initial.binding }));
  assert.equal(initialResponse.ok, false);
  assert.equal(initialResponse.error.code, 'MUTATION_REFRESH_REQUIRED');
  assert.equal(initialResponse.error.retryable, true);
  assert.equal(initial.calls.notionGet, 0);
  assert.equal(initial.calls.notionUpdate.length, 0);

  const recheck = installOuterMutationHarness();
  let reads = 0;
  recheck.backend.w20FreshRegistryMaterialByNavigationBinding_ = () => (++reads === 1 ? recheck.current : null);
  const recheckResponse = recheck.backend.w20ApplyOuterMutation_(recheck.fields({ kind: 'edit', binding: recheck.binding, name: 'Новое имя', section: 'Docs' }));
  assert.equal(recheckResponse.ok, false);
  assert.equal(recheckResponse.error.code, 'MUTATION_REFRESH_REQUIRED');
  assert.equal(recheckResponse.error.retryable, true);
  assert.equal(reads, 2);
  assert.equal(recheck.calls.notionGet, 0, 'a failed locked recheck stops before Notion');
  assert.equal(recheck.calls.invalidations, 0);
  assert.equal(recheck.calls.notionUpdate.length, 0);
});

test('outer hide reports an error if the registry tombstone cannot be committed', () => {
  const fixture = installOuterMutationHarness();
  fixture.backend.w20RegistryRemove_ = () => { fixture.calls.registryRemove += 1; return false; };
  const response = fixture.backend.w20ApplyOuterMutation_(fixture.fields({ kind: 'hide', binding: fixture.binding }));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'BUSY');
  assert.equal(response.error.retryable, true);
  assert.equal(fixture.calls.registryRemove, 1);
  assert.deepEqual(fixture.calls.driveState, [{ task: fixture.taskId, state: 'archived' }]);
  assert.equal(fixture.calls.notionUpdate.length, 1);
});

test('outer edit reports an error if the updated registry card cannot be committed', () => {
  const fixture = installOuterMutationHarness();
  fixture.backend.w20RegistryUpsert_ = () => { fixture.calls.registryUpsert += 1; return false; };
  const response = fixture.backend.w20ApplyOuterMutation_(fixture.fields({
    kind: 'edit',
    binding: fixture.binding,
    name: 'Другое имя',
    section: 'Docs'
  }));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'BUSY');
  assert.equal(response.error.retryable, true);
  assert.equal(fixture.calls.registryUpsert, 1);
  assert.equal(fixture.calls.driveRename.length, 1);
  assert.equal(fixture.calls.notionUpdate.length, 1);
});

test('outer edit returns an exact safe presentation without page, Drive, token or idempotency identifiers', () => {
  const fixture = installOuterMutationHarness();
  const { backend, taskId, pageId, binding, nextBinding, requestId, accessToken, current, calls } = fixture;
  const updatedMaterial = {
    ...current,
    name: 'Новое имя',
    section: 'Sheets',
    format: 'Google Sheets',
    position: 9,
    navigationBinding: nextBinding
  };
  backend.w19MaterialFromPage_ = (page) => page && page.updated ? updatedMaterial : ({ ...current });
  let audit = null;
  backend.w19Audit_ = (_type, details) => { audit = details; };
  const response = backend.w20ApplyOuterMutation_(fixture.fields({ kind: 'edit', binding, name: 'Новое имя', section: 'Sheets' }));
  assert.equal(response.ok, true, JSON.stringify({ response, audit }));
  assert.equal(calls.fresh, 2);
  assert.deepEqual(calls.notionIncludeArchived, [false]);
  assert.equal(calls.driveRename.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.driveRename[0])), { resource: { name: 'Новое имя' }, fileId: current.googleFileId });
  assert.equal(calls.notionUpdate.length, 1);
  assert.equal(calls.notionUpdate[0].pageId, pageId);
  assert.equal(calls.notionUpdate[0].properties.Name.title[0].text.content, 'Новое имя');
  assert.equal(calls.notionUpdate[0].properties['[SYS] Раздел виджета'].select.name, 'Sheets');
  assert.equal(calls.notionUpdate[0].properties['[SYS] Позиция'].number, 9);
  assert.equal(calls.registryUpsert, 1);
  const safe = backend.w20SafeMutationPostResult_(fixture.fields({ kind: 'edit', binding, name: 'Новое имя', section: 'Sheets' }), response);
  assert.deepEqual(JSON.parse(JSON.stringify(safe)), {
    requestId,
    status: 'success',
    kind: 'edit',
    binding,
    material: { name: 'Новое имя', section: 'Sheets', format: 'Google Sheets', position: 9, navigationBinding: nextBinding }
  });
  assert.deepEqual(Object.keys(safe.material).sort(), ['format', 'name', 'navigationBinding', 'position', 'section']);
  const serialized = JSON.stringify(safe);
  assert.doesNotMatch(serialized, new RegExp(pageId));
  assert.doesNotMatch(serialized, new RegExp(current.googleFileId));
  assert.doesNotMatch(serialized, new RegExp(accessToken));
  assert.doesNotMatch(serialized, /idempotency|server-private/i);
  assert.deepEqual(calls.canonical, [[taskId, `outer-edit-${binding}`, requestId]]);
});

test('mutation POST renders the dedicated template once with only the safe precomputed result', () => {
  const backend = loadBackend();
  const task = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const requestId = '12345678-1234-4abc-8def-1234567890ab';
  const accessToken = 'outer_mutation_capability_0123456789_ABCDEFGH';
  const binding = 'a'.repeat(64);
  const nextBinding = 'b'.repeat(64);
  const rendered = [];
  const output = { setTitle() { return this; }, setXFrameOptionsMode() { return this; }, addMetaTag() { return this; } };
  backend.HtmlService = {
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
    createTemplateFromFile(name) {
      assert.equal(name, 'Mutation');
      const template = { evaluate() { rendered.push(template.precomputedResultJson); return output; } };
      return template;
    }
  };
  let mutationCalls = 0;
  backend.w20ApplyOuterMutation_ = (fields) => {
    mutationCalls += 1;
    assert.equal(fields.valid, true);
    return { ok: true, data: { kind: 'edit', binding, material: { name: 'Новое имя', section: 'Docs', format: 'Google Docs', position: 7, navigationBinding: nextBinding, id: 'must-be-removed' } } };
  };
  const event = {
    parameters: { task: [task], accessToken: [accessToken], mutationRequestId: [requestId], mutationPayload: [JSON.stringify({ kind: 'edit', binding, name: 'Новое имя', section: 'Docs' })] },
    postData: { type: 'application/x-www-form-urlencoded' }
  };
  assert.equal(backend.doPost(event), output);
  assert.equal(mutationCalls, 1);
  const safe = JSON.parse(rendered[0]);
  assert.equal(safe.status, 'error', 'a material with any extra server field must fail closed');
  assert.deepEqual(Object.keys(safe).sort(), ['message', 'requestId', 'retryable', 'status']);
  assert.doesNotMatch(rendered[0], /must-be-removed|accessToken|capability|idempotency/i);

  backend.w20ApplyOuterMutation_ = () => ({ ok: true, data: { kind: 'hide', binding, material: null } });
  assert.equal(backend.doPost(event), output);
  const hidden = JSON.parse(rendered[1]);
  assert.deepEqual(hidden, { requestId, status: 'success', kind: 'hide', binding, material: null });
  assert.doesNotMatch(rendered[1], new RegExp(accessToken));

  backend.doPost({ ...event, parameters: { ...event.parameters, extra: ['forbidden'] } });
  assert.equal(mutationCalls, 1, 'invalid mutation POST must fail before executing the backend mutation');
  const invalid = JSON.parse(rendered[2]);
  assert.equal(invalid.status, 'error');
  assert.equal(invalid.retryable, false);
  assert.doesNotMatch(rendered[2], new RegExp(accessToken));
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
  const replacement=backend.w20RegistryReplaceTaskResult_(taskId,[{
    id:pageId,name:'Быстрая карточка',section:'Docs',format:'Google Docs',provider:'Google Drive',
    openUrl:'https://docs.google.com/document/d/NativeGoogleDoc123/edit',googleFileId:'NativeGoogleDoc123',folderId:'TaskFolder12345',widgetOwned:true,position:0,syncStatus:'synced'
  }]);
  assert.equal(replacement.ok,true);
  const validatedAt=new Date().toISOString();
  backend.w20RegistryWriteTaskMeta_(taskId,{
    taskName:'Задача',folderId:'TaskFolder12345',rootFolderId:'RootFolder12345',folderVerified:true,
    folderValidatedAt:validatedAt,taskValidatedAt:validatedAt,snapshotValidatedAt:validatedAt,
    snapshotActiveCount:replacement.activeCount
  });
  backend.w19AuthorizedConfig_ = () => ({authorizedTaskPageId:taskId,deniedPageIds:{},rootFolderId:'RootFolder12345',maxUploadBytes:8388608,notionToken:'server-only'});
  for (const name of ['w19AssertSchema_','w19AssertTaskPage_','w19QueryTaskMaterials_','w19EnsureTaskFolder_']) backend[name]=()=>{throw new Error(`${name} must not run`);};
  const result=backend.apiBootstrap({taskPageId:taskId});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.data.cached,true);
  assert.equal(result.data.authoritative,false);
  assert.equal(result.data.actionReady,true);
  assert.equal(result.data.fullySynced,false);
  assert.equal(typeof result.data.trustedUntil,'string');
  assert.equal(result.data.materials.length,1);
  assert.equal(result.data.materials[0].name,'Быстрая карточка');
  assert.equal(result.data.materials[0].openUrl,'https://docs.google.com/document/d/NativeGoogleDoc123/edit');
  assert.equal(result.data.materials[0].googleFileId,'NativeGoogleDoc123');
  assert.match(result.data.materials[0].navigationBinding,/^[a-f0-9]{64}$/);
  const navigationBinding=result.data.materials[0].navigationBinding;
  assert.equal(result.data.folderUrl,'https://drive.google.com/drive/folders/TaskFolder12345');

  const propertySnapshot=props.getProperties();
  backend.PropertiesService={getScriptProperties:()=>({getProperties:()=>{throw new Error('SSR must reuse its one property snapshot');}})};
  backend.w20IssueDrivePollClaim_=()=>{throw new Error('SSR must not issue per-card HMAC claims');};
  backend.w20CacheDownloadRegistryMaterials_=()=>{throw new Error('SSR must not write download cache entries');};
  backend.ScriptApp={getService:()=>{throw new Error('SSR must not resolve the deployment URL');}};
  const ssr=backend.w20BootstrapFromRegistry_({taskPageId:taskId},backend.w19AuthorizedConfig_(),null,{
    propertyValues:propertySnapshot,issueDrivePollClaims:false,seedDownloadCache:false,includeServiceUrl:false
  });
  assert.equal(ssr.cached,true);
  assert.equal(ssr.authoritative,false);
  assert.equal(ssr.actionReady,true);
  assert.equal(ssr.serviceUrl,null);
  assert.equal(ssr.materials.length,1);
  assert.equal(ssr.materials[0].drivePollClaim,undefined);
  assert.equal(ssr.materials[0].navigationBinding,navigationBinding,'SSR keeps the exact opaque navigation identity without issuing a Drive poll claim');
  assert.ok(Array.isArray(ssr.preparedCreates));
});

test('cached action proof keeps trigger headroom, then expires and fails closed on a registry count mismatch', () => {
  const backend=loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId='3c72d627-39a1-8120-bd0a-f969e6846945';
  const values={};
  const props={
    getProperties:()=>({...values}),
    getProperty:(key)=>Object.prototype.hasOwnProperty.call(values,key)?values[key]:null,
    setProperty:(key,value)=>{values[key]=String(value);},
    setProperties:(next)=>{Object.assign(values,next);},
    deleteProperty:(key)=>{delete values[key];}
  };
  backend.PropertiesService={getScriptProperties:()=>props};
  backend.ScriptApp={getService:()=>({getUrl:()=> 'https://script.google.com/macros/s/abcdefghijklmnopqrstuvwxyz0123456789_-AB/exec'})};
  const replacement=backend.w20RegistryReplaceTaskResult_(taskId,[{
    id:pageId,name:'Документ',section:'Docs',format:'Google Docs',provider:'Google Drive',
    openUrl:'https://docs.google.com/document/d/NativeGoogleDoc123/edit',googleFileId:'NativeGoogleDoc123',
    folderId:'TaskFolder12345',position:0,syncStatus:'synced'
  }]);
  assert.equal(replacement.ok,true);
  const folderValidatedAt=new Date().toISOString();
  const staleAt=new Date(Date.now()-(20*60*1000+1000)).toISOString();
  backend.w20RegistryWriteTaskMeta_(taskId,{
    taskName:'Задача',folderId:'TaskFolder12345',rootFolderId:'RootFolder12345',folderVerified:true,
    folderValidatedAt,taskValidatedAt:staleAt,snapshotValidatedAt:staleAt,snapshotActiveCount:replacement.activeCount
  });
  const cfg={authorizedTaskPageId:taskId,deniedPageIds:{},rootFolderId:'RootFolder12345',maxUploadBytes:8388608,notionToken:'server-only'};
  const stale=backend.w20BootstrapFromRegistry_({taskPageId:taskId},cfg,null);
  assert.equal(stale.actionReady,false);
  assert.equal(stale.trustedUntil,null);
  assert.equal(stale.folderUrl,'https://drive.google.com/drive/folders/TaskFolder12345');
  assert.equal(stale.materials[0].openUrl,'https://docs.google.com/document/d/NativeGoogleDoc123/edit');
  assert.equal(backend.w20RegistryClaimCreateSlot_(taskId,'Docs','RootFolder12345'),null);

  const freshAt=new Date().toISOString();
  backend.w20RegistryWriteTaskMeta_(taskId,{
    taskValidatedAt:freshAt,snapshotValidatedAt:freshAt,snapshotActiveCount:replacement.activeCount
  });
  assert.equal(backend.w20BootstrapFromRegistry_({taskPageId:taskId},cfg,null).actionReady,true);
  assert.equal(backend.w20RegistryUpsert_(taskId,{
    id:'3c72d627-39a1-81e5-a840-ecb1c98cc5c5',name:'Параллельно созданный',section:'Docs',format:'Google Docs',provider:'Google Drive',
    openUrl:'https://docs.google.com/document/d/SecondGoogleDoc123/edit',googleFileId:'SecondGoogleDoc123',
    folderId:'TaskFolder12345',position:1,syncStatus:'synced'
  }),true);
  assert.equal(backend.w20BootstrapFromRegistry_({taskPageId:taskId},cfg,null).actionReady,true);
  assert.equal(backend.w20RegistryClaimCreateSlot_(taskId,'Docs','DifferentRootFolder123'),null);
  const secondKey=backend.w20RegistryKey_(taskId,'3c72d627-39a1-81e5-a840-ecb1c98cc5c5');
  const wrongFolder=JSON.parse(values[secondKey]);
  wrongFolder.folderId='AnotherTaskFolder123';
  values[secondKey]=JSON.stringify(wrongFolder);
  assert.equal(backend.w20BootstrapFromRegistry_({taskPageId:taskId},cfg,null).actionReady,false);
  wrongFolder.folderId='TaskFolder12345';
  values[secondKey]=JSON.stringify(wrongFolder);
  assert.equal(backend.w20BootstrapFromRegistry_({taskPageId:taskId},cfg,null).actionReady,true);
  const metaKey=backend.w20RegistryMetaKey_(taskId);
  const inconsistent=JSON.parse(values[metaKey]);
  inconsistent.snapshotActiveCount+=1;
  values[metaKey]=JSON.stringify(inconsistent);
  assert.equal(backend.w20BootstrapFromRegistry_({taskPageId:taskId},cfg,null).actionReady,false);
  assert.equal(backend.w20RegistryClaimCreateSlot_(taskId,'Docs','RootFolder12345'),null);
});

test('interactive bootstrap and list refresh defer per-file Drive metadata sync', () => {
  const bootstrap = backendSource.slice(backendSource.indexOf('function apiBootstrap'), backendSource.indexOf('function apiCreateGoogle'));
  const sync = backendSource.slice(backendSource.indexOf('function apiSyncTask'), backendSource.indexOf('/* ========================= Admin-only setup'));
  assert.doesNotMatch(bootstrap,/w19SyncPageList_/);
  assert.doesNotMatch(sync,/w19SyncPageList_/);
  assert.match(bootstrap,/input && input\.forceRefresh === true/);
  const taskCheckAt=bootstrap.indexOf('var task = w19AssertTaskPage_'),taskValidatedAt=bootstrap.indexOf('var taskValidatedAt = new Date().toISOString()');
  const materialsAt=bootstrap.indexOf('var pages = w19QueryTaskMaterials_'),snapshotValidatedAt=bootstrap.indexOf('var snapshotValidatedAt = new Date().toISOString()');
  assert.ok(taskCheckAt>=0&&taskCheckAt<taskValidatedAt&&taskValidatedAt<materialsAt&&materialsAt<snapshotValidatedAt,'task authority must be timestamped before the potentially paginated material query');
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

test('saved navigation is bound to an opaque server-derived page, file and revision identity', () => {
  const backend=loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e',cfg={notionToken:'server-only-navigation-secret'};
  backend.w20IssueDrivePollClaim_=()=> 'claim';
  const base={
    id:'3c72d627-39a1-4120-8d0a-f969e6846945',provider:'Google Drive',googleFileId:'NativeGoogleDoc123',
    name:'Одинаковое имя',format:'Google Docs',section:'Docs',position:1,archived:false,syncStatus:'synced',
    openUrl:'https://docs.google.com/document/d/NativeGoogleDoc123/edit',updatedAt:'2026-08-28T10:00:00.000Z',
    navigationBinding:'f'.repeat(64)
  };
  const first=backend.w20MaterialForClient_(base,taskId,cfg),same=backend.w20MaterialForClient_({...base},taskId,cfg);
  assert.match(first.navigationBinding,/^[a-f0-9]{64}$/);
  assert.equal(first.navigationBinding,same.navigationBinding,'the exact server identity/revision is stable');
  assert.notEqual(first.navigationBinding,'f'.repeat(64),'a caller-supplied binding is discarded');
  assert.notEqual(first.navigationBinding,backend.w20MaterialForClient_({...base,id:'4c72d627-39a1-4120-8d0a-f969e6846945'},taskId,cfg).navigationBinding,'replacing the Notion page changes the binding');
  assert.notEqual(first.navigationBinding,backend.w20MaterialForClient_({...base,googleFileId:'ReplacementGoogle123',openUrl:'https://docs.google.com/document/d/ReplacementGoogle123/edit'},taskId,cfg).navigationBinding,'replacing the Drive file changes the binding');
  assert.notEqual(first.navigationBinding,backend.w20MaterialForClient_({...base,updatedAt:'2026-08-28T10:00:01.000Z'},taskId,cfg).navigationBinding,'a new server revision changes the binding');
  assert.doesNotMatch(JSON.stringify(first),/server-only-navigation-secret|create-google-Docs/);
});

test('archive hides one card while preserving its Notion knowledge and Google Drive file', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-4120-8d0a-f969e6846945';
  const fileId = 'NativeGoogleDoc12345';
  const folderId = 'OwnedTaskFolder12345';
  const compactTask = backend.WidgetV19Core.compactUuid(taskId);
  const compactPage = backend.WidgetV19Core.compactUuid(pageId);
  const copy = (value) => JSON.parse(JSON.stringify(value));
  let notionPage = {
    id: pageId,
    in_trash: false,
    url: `https://www.notion.so/${compactPage}`,
    last_edited_time: '2026-08-27T00:00:00.000Z',
    properties: {
      'Name': { title: [{ type: 'text', text: { content: 'Документ для знаний' }, plain_text: 'Документ для знаний' }] },
      'Тип': { select: { name: 'Знание' } },
      'Внутри': { relation: [{ id: taskId }] },
      'Ссылка': { url: `https://docs.google.com/document/d/${fileId}/edit` },
      'Вложения': { files: [] },
      'Формат знания': { select: { name: 'Файл' } },
      'Архив': { checkbox: false },
      '[SYS] Формат файла': { select: { name: 'Google Docs' } },
      '[SYS] Раздел виджета': { select: { name: 'Docs' } },
      '[SYS] Google File ID': { rich_text: [{ type: 'text', text: { content: fileId }, plain_text: fileId }] },
      '[SYS] Google Folder ID': { rich_text: [{ type: 'text', text: { content: folderId }, plain_text: folderId }] },
      '[SYS] Позиция': { number: 3 },
      '[SYS] Sync status': { select: { name: 'synced' } },
      '[SYS] Idempotency key': { rich_text: [] }
    }
  };
  const driveFiles = new Map([[fileId, {
    id: fileId,
    name: 'Документ для знаний',
    appProperties: {
      widgetVersion: 'v20',
      taskPageId: compactTask,
      notionPageId: compactPage,
      materialState: 'active'
    }
  }]]);
  let notionPatch = null;
  let driveDeleteCalls = 0;
  let registryRemoval = null;

  backend.w19AuthorizedConfig_ = () => ({});
  backend.w19AssertTaskPage_ = () => ({ id: taskId });
  backend.w19AssertMaterialForTask_ = (actualPageId, actualTaskId, _cfg, allowArchived) => {
    assert.equal(actualPageId, pageId);
    assert.equal(actualTaskId, taskId);
    assert.equal(allowArchived, true);
    return copy(notionPage);
  };
  backend.w19WithIdempotency_ = (_key, operation) => operation({});
  backend.w19WithMutationLock_ = (operation) => operation();
  backend.w20InvalidateDownloadMaterialCache_ = () => true;
  backend.w19UpdateNotionPage_ = (actualPageId, properties) => {
    assert.equal(actualPageId, pageId);
    notionPatch = copy(properties);
    notionPage.properties = { ...notionPage.properties, ...copy(properties) };
    notionPage.last_edited_time = '2026-08-27T00:00:01.000Z';
    return copy(notionPage);
  };
  backend.w20RegistryRemove_ = (actualTaskId, actualPageId) => {
    registryRemoval = { taskId: actualTaskId, pageId: actualPageId };
    return true;
  };
  backend.Drive = { Files: {
    get(actualFileId) {
      const file = driveFiles.get(String(actualFileId));
      if (!file) throw new Error('not found');
      return copy(file);
    },
    update(resource, actualFileId) {
      const file = driveFiles.get(String(actualFileId));
      if (!file) throw new Error('not found');
      assert.deepEqual(Object.keys(resource), ['appProperties']);
      file.appProperties = copy(resource.appProperties);
      return copy(file);
    },
    delete() {
      driveDeleteCalls += 1;
      throw new Error('archive must never delete the Drive file');
    }
  } };

  const result = backend.apiArchive({
    taskPageId: taskId,
    accessToken: 'capability_token_not_logged_or_returned',
    pageId,
    idempotencyKey: 'hide-material-once-001'
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.archived, true);
  assert.equal(result.data.material.id, pageId);
  assert.equal(result.data.material.archived, true);
  assert.equal(result.data.material.syncStatus, 'archived');
  assert.deepEqual(notionPatch, {
    'Архив': { checkbox: true },
    '[SYS] Sync status': { select: { name: 'archived' } }
  });
  assert.equal(notionPage.in_trash, false);
  assert.equal(notionPage.properties.Name.title[0].plain_text, 'Документ для знаний');
  assert.equal(driveDeleteCalls, 0);
  assert.equal(driveFiles.has(fileId), true);
  assert.equal(driveFiles.get(fileId).name, 'Документ для знаний');
  assert.equal(driveFiles.get(fileId).appProperties.materialState, 'archived');
  assert.deepEqual(registryRemoval, { taskId, pageId });
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
  backend.Utilities.getUuid = () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const requestId = '11111111-1111-4111-8111-111111111111';
  const canonical = backend.w19CanonicalIdempotency_(taskId, 'create-google-Docs', requestId);
  let documentsCreated = 0;
  const create = () => backend.w19WithIdempotency_(canonical, () => ({ documentId: `doc-${documentsCreated += 1}` }));
  assert.equal(create().documentId, 'doc-1');
  assert.equal(create().documentId, 'doc-1');
  assert.equal(documentsCreated, 1);
});

test('a failed Notion finalize preserves the CAS-bound drive_ready document', () => {
  const backend=loadBackend(),values={};
  const props={getProperty:(key)=>values[key]||null,setProperty:(key,value)=>{values[key]=String(value);}};
  const lock={tryLock:()=>true,waitLock(){},releaseLock(){}};
  backend.PropertiesService={getScriptProperties:()=>props};
  backend.LockService={getScriptLock:()=>lock};
  backend.Utilities.getUuid=()=> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const canonical=backend.w19CanonicalIdempotency_('3c62d627-39a1-80a1-aac7-ec19ffc9ef8e','create-google-Docs','11111111-1111-4111-8111-111111111111');
  assert.throws(()=>backend.w19WithIdempotency_(canonical,(state)=>{
    assert.equal(backend.w20WriteCreateDriveReady_(canonical,state.attemptId,{id:'FailedFinalizeDoc123',webViewLink:'https://docs.google.com/document/d/FailedFinalizeDoc123/edit'},'Docs'),true);
    throw new backend.W19Error_('NOTION_UNAVAILABLE','notion failed',true);
  }),(error)=>error&&error.code==='NOTION_UNAVAILABLE');
  const failed=JSON.parse(values[backend.w19IdempotencyLedgerKey_(canonical)]);
  assert.equal(failed.status,'failed');
  assert.equal(failed.retryable,true);
  assert.equal(failed.driveReady.googleFileId,'FailedFinalizeDoc123');
  assert.ok(Number(failed.driveReadyAt)>0);
  assert.equal(backend.w20CreateDriveReadyUrl_(failed),'https://docs.google.com/document/d/FailedFinalizeDoc123/edit');
});

test('create-status stays local and distinguishes retryable failed bindings', () => {
  const backend=loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const requestId='22222222-2222-4222-8222-222222222222';
  const cfg={authorizedTaskPageId:taskId,deniedPageIds:{}};
  const ledger={status:'failed',at:Date.now(),retryable:false,driveReadyAt:Date.now(),driveReady:{
    openUrl:'https://docs.google.com/document/d/FailedStatusDoc123/edit',googleFileId:'FailedStatusDoc123',section:'Docs',format:'Google Docs',provider:'Google Drive',archived:false
  }};
  backend.w19AuthorizedConfig_=()=>cfg;
  backend.w20AssertAuthorizedTaskId_=(value)=>{assert.equal(value,taskId);return taskId;};
  backend.w20RegistryFindCreateRequest_=()=>null;
  let liveNotionLookups=0;
  backend.w19FindMaterialByIdempotency_=()=>{liveNotionLookups+=1;throw new Error('status must stay local');};
  backend.w19ReadIdempotencyStatus_=()=>ledger;

  const terminal=backend.apiGetCreateStatus({taskPageId:taskId,section:'Docs',createRequestId:requestId});
  assert.deepEqual(JSON.parse(JSON.stringify(terminal)),{ok:true,data:{status:'failed',retryable:false}});
  assert.equal(liveNotionLookups,0);

  ledger.retryable=true;
  const recovering=backend.apiGetCreateStatus({taskPageId:taskId,section:'Docs',createRequestId:requestId});
  assert.deepEqual(JSON.parse(JSON.stringify(recovering)),{ok:true,data:{status:'drive_ready',openUrl:'https://docs.google.com/document/d/FailedStatusDoc123/edit',retryable:true}});
  assert.equal(liveNotionLookups,0);
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
  backend.Utilities.getUuid = () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  backend.Utilities.formatDate = () => '2026-08-26 21:00';
  const replacement=backend.w20RegistryReplaceTaskResult_(taskId,[{
    id:existingPageId,name:'Существующий документ',section:'Docs',format:'Google Docs',provider:'Google Drive',
    openUrl:'https://docs.google.com/document/d/ExistingGoogleDoc123/edit',googleFileId:'ExistingGoogleDoc123',
    folderId:'TaskFolder12345',widgetOwned:true,position:7,syncStatus:'synced'
  }]);
  assert.equal(replacement.ok,true);
  const validatedAt=new Date().toISOString();
  backend.w20RegistryWriteTaskMeta_(taskId,{
    taskName:'Задача',folderId:'TaskFolder12345',rootFolderId:'RootFolder12345',folderVerified:true,
    folderValidatedAt:validatedAt,taskValidatedAt:validatedAt,snapshotValidatedAt:validatedAt,
    snapshotActiveCount:replacement.activeCount,
    context:{path:'Основная / Задача',ancestorIds:'ancestor',depth:2,sphereIds:[],directionIds:[],projectIds:[]}
  });
  const cfg={authorizedTaskPageId:taskId,deniedPageIds:{},dataSourceId:'3822d627-39a1-8018-a2dc-000b95bf5722',notionToken:'server-only',rootFolderId:'RootFolder12345'};
  backend.w19AuthorizedConfig_=()=>cfg;
  backend.w20FindPreparedReservationFiles_=()=>[];
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
    const canonical=backend.w19CanonicalIdempotency_(taskId,'create-google-Docs',requestId);
    const duringCreate=JSON.parse(props.getProperty(backend.w19IdempotencyLedgerKey_(canonical)));
    assert.equal(duringCreate.status,'pending');
    assert.equal(duringCreate.driveReady.openUrl,'https://docs.google.com/document/d/CreatedGoogleDoc123/edit');
    assert.equal(duringCreate.driveReady.googleFileId,'CreatedGoogleDoc123');
    assert.ok(Number(duringCreate.driveReadyAt)>0);
    assert.doesNotMatch(JSON.stringify(duringCreate),/create-google-Docs|3c62d62739a180a1aac7ec19ffc9ef8e/);
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

  const readyRequestId='33333333-3333-4333-8333-333333333333';
  const readyCanonical=backend.w19CanonicalIdempotency_(taskId,'create-google-Docs',readyRequestId);
  const readyAttemptId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  props.setProperty(backend.w19IdempotencyLedgerKey_(readyCanonical),JSON.stringify({
    status:'pending',at:Date.now(),attemptId:readyAttemptId,driveReadyAt:Date.now(),
    driveReady:{openUrl:'https://docs.google.com/document/d/DriveReadyDocument123/edit',googleFileId:'DriveReadyDocument123',section:'Docs',format:'Google Docs',provider:'Google Drive',archived:false}
  }));
  const ledgerBeforeStaleWrite=props.getProperty(backend.w19IdempotencyLedgerKey_(readyCanonical));
  assert.equal(backend.w20WriteCreateDriveReady_(readyCanonical,'cccccccc-cccc-4ccc-8ccc-cccccccccccc',{
    id:'StaleGoogleDocument123',webViewLink:'https://docs.google.com/document/d/StaleGoogleDocument123/edit'
  },'Docs'),false);
  assert.equal(props.getProperty(backend.w19IdempotencyLedgerKey_(readyCanonical)),ledgerBeforeStaleWrite);
  assert.equal(backend.w20WriteCreateDriveReady_(readyCanonical,readyAttemptId,{
    id:'DriveReadyDocument123',webViewLink:'https://docs.google.com/document/d/DriveReadyDocument123/edit'
  },'Docs'),true);
  const ready=backend.apiGetCreateStatus({taskPageId:taskId,section:'Docs',createRequestId:readyRequestId});
  assert.deepEqual(JSON.parse(JSON.stringify(ready.data)),{status:'drive_ready',openUrl:'https://docs.google.com/document/d/DriveReadyDocument123/edit',retryable:true});
  assert.doesNotMatch(JSON.stringify(ready),/create-google-Docs|33333333-3333-4333-8333-333333333333|DriveReadyDocument123"\s*,\s*"section/);
  props.setProperty(backend.w19IdempotencyLedgerKey_(readyCanonical),JSON.stringify({
    status:'failed',at:Date.now(),attemptId:readyAttemptId,retryable:true,driveReadyAt:Date.now(),
    driveReady:{openUrl:'https://docs.google.com/document/d/DriveReadyDocument123/edit',googleFileId:'DriveReadyDocument123',section:'Docs',format:'Google Docs',provider:'Google Drive',archived:false}
  }));
  const failedReady=backend.apiGetCreateStatus({taskPageId:taskId,section:'Docs',createRequestId:readyRequestId});
  assert.deepEqual(JSON.parse(JSON.stringify(failedReady.data)),{status:'drive_ready',openUrl:'https://docs.google.com/document/d/DriveReadyDocument123/edit',retryable:true});
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
  const replacement=backend.w20RegistryReplaceTaskResult_(taskId,[]);
  assert.equal(replacement.ok,true);
  const validatedAt=new Date().toISOString();
  backend.w20RegistryWriteTaskMeta_(taskId,{
    taskName:'Задача',folderId:'UntrustedFolder123',rootFolderId:'RootFolder12345',folderVerified:false,
    taskValidatedAt:validatedAt,snapshotValidatedAt:validatedAt,snapshotActiveCount:replacement.activeCount,
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
  backend.w20WarmCreatePool_=()=>[];

  const warmed=backend.apiWarmCreateContext({taskPageId:taskId});
  assert.equal(warmed.ok,true,JSON.stringify(warmed));
  assert.equal(warmed.data.ready,true);
  assert.equal(warmed.data.cached,false);
  assert.equal(warmed.data.folderUrl,'https://drive.google.com/drive/folders/VerifiedFolder123');
  assert.match(warmed.data.trustedUntil,/^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(JSON.parse(JSON.stringify(warmed.data.preparedCreates)),[]);
  assert.equal(folderChecks,1);
  const meta=backend.w20RegistryReadFreshTaskMeta_(taskId);
  assert.equal(meta.folderId,'VerifiedFolder123');
  assert.equal(meta.folderVerified,true);
  assert.equal(meta.taskValidatedAt,validatedAt);
  assert.equal(meta.snapshotValidatedAt,validatedAt);

  const cached=backend.apiWarmCreateContext({taskPageId:taskId});
  assert.equal(cached.ok,true,JSON.stringify(cached));
  assert.equal(cached.data.ready,true);
  assert.equal(cached.data.cached,true);
  assert.equal(cached.data.folderUrl,'https://drive.google.com/drive/folders/VerifiedFolder123');
  assert.match(cached.data.trustedUntil,/^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(JSON.parse(JSON.stringify(cached.data.preparedCreates)),[]);
  assert.equal(folderChecks,1);
});

test('live bootstrap refreshes stale folder proof in the same response and later proof-only warm stays cached', () => {
  const backend=loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId='3c72d627-39a1-8120-bd0a-f969e6846945';
  const cfg={authorizedTaskPageId:taskId,deniedPageIds:{},rootFolderId:'RootFolder12345',maxUploadBytes:8388608};
  const calls={schema:0,task:0,materials:0,folder:0,pool:0};
  const material={
    id:pageId,name:'Готовая карточка',section:'Docs',format:'Google Docs',provider:'Google Drive',
    openUrl:'https://docs.google.com/document/d/NativeGoogleDoc123/edit',googleFileId:'NativeGoogleDoc123',
    folderId:'WarmFolder12345',widgetOwned:true,position:0,syncStatus:'synced',archived:false
  };
  backend.w19AuthorizedConfig_=()=>cfg;
  backend.w19AssertSchema_=()=>{calls.schema+=1;};
  backend.w19AssertTaskPage_=(value)=>{calls.task+=1;assert.equal(value,taskId);return {id:taskId,name:'Задача',page:{properties:{}}};};
  backend.w19QueryTaskMaterials_=(value)=>{calls.materials+=1;assert.equal(value,taskId);return [material];};
  backend.w19MaterialFromPage_=(value)=>value;
  backend.w20MaterialForClient_=(value)=>({...value});
  backend.w20CacheDownloadMaterials_=()=>{};
  backend.w20TaskContextSnapshot_=()=>({path:'Основная / Задача',ancestorIds:'ancestor',depth:2});
  backend.w19EnsureTaskFolder_=(task)=>{calls.folder+=1;assert.equal(task.id,taskId);assert.equal(task.name,'Задача');return {id:'WarmFolder12345'};};
  backend.w20WarmCreatePool_=()=>{calls.pool+=1;throw new Error('proof-only warm must not pre-create Drive files');};
  backend.ScriptApp={getService:()=>({getUrl:()=> 'https://script.google.com/macros/s/abcdefghijklmnopqrstuvwxyz0123456789_-AB/exec'})};

  const boot=backend.apiBootstrap({taskPageId:taskId,forceRefresh:true});
  assert.equal(boot.ok,true,JSON.stringify(boot));
  assert.equal(boot.data.cached,false);
  assert.equal(boot.data.authoritative,true);
  assert.equal(boot.data.actionReady,true);
  assert.equal(boot.data.folderUrl,'https://drive.google.com/drive/folders/WarmFolder12345');
  assert.equal(boot.data.materials.length,1);
  assert.equal(boot.data.materials[0].name,'Готовая карточка');
  assert.deepEqual(calls,{schema:1,task:1,materials:1,folder:1,pool:0},'one force refresh must return a complete action proof without a second client RPC');

  backend.w19AssertSchema_=()=>{throw new Error('proof-only warm must not inspect Notion schema');};
  backend.w19AssertTaskPage_=()=>{throw new Error('proof-only warm must not fetch the Notion task');};
  backend.w19QueryTaskMaterials_=()=>{throw new Error('proof-only warm must not query Notion materials');};
  const warmed=backend.apiWarmCreateContext({taskPageId:taskId,proofOnly:true});
  assert.equal(warmed.ok,true,JSON.stringify(warmed));
  assert.equal(warmed.data.ready,true);
  assert.equal(warmed.data.cached,true);
  assert.equal(warmed.data.folderUrl,'https://drive.google.com/drive/folders/WarmFolder12345');
  assert.match(warmed.data.trustedUntil,/^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(JSON.parse(JSON.stringify(warmed.data.preparedCreates)),[]);
  assert.equal(calls.folder,1,'the proof-only follow-up reuses the folder proof established by bootstrap');
  assert.equal(calls.pool,0);
});

test('authoritative bootstrap derives cards, proof and prepared descriptors from one post-replace property snapshot', () => {
  const backend=loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId='3c72d627-39a1-8120-bd0a-f969e6846945';
  const rootFolderId='RootFolder12345',taskFolderId='TaskFolder12345';
  const reservationId='1185d2e2-4728-4bcd-b22d-67a27a7928c3';
  const values={};
  let replacementReturned=false,postReplaceFullReads=0,postReplaceSingleReads=0;
  const props={
    getProperties:()=>{
      if(replacementReturned)postReplaceFullReads+=1;
      return {...values};
    },
    getProperty:(key)=>{
      if(replacementReturned)postReplaceSingleReads+=1;
      return Object.prototype.hasOwnProperty.call(values,key)?values[key]:null;
    },
    setProperty:(key,value)=>{values[key]=String(value);},
    setProperties:(next)=>{Object.assign(values,next);},
    deleteProperty:(key)=>{delete values[key];}
  };
  backend.PropertiesService={getScriptProperties:()=>props};
  const validatedAt=new Date().toISOString();
  assert.equal(backend.w20RegistryWriteTaskMeta_(taskId,{
    taskName:'Задача',folderId:taskFolderId,rootFolderId,folderVerified:true,folderValidatedAt:validatedAt
  }),true);
  values[backend.w20CreateReservationKey_(taskId,'Docs')]=JSON.stringify({
    schema:1,status:'prepared',taskId:taskId.replaceAll('-',''),section:'Docs',reservationId,
    at:Date.now(),fileId:'PreparedGoogleDoc123',preparedName:'Новый Google документ'
  });

  const replaceTaskResult=backend.w20RegistryReplaceTaskResult_;
  backend.w20RegistryReplaceTaskResult_=(...args)=>{
    const result=replaceTaskResult(...args);
    replacementReturned=true;
    return result;
  };
  backend.w19AuthorizedConfig_=()=>({
    authorizedTaskPageId:taskId,deniedPageIds:{},rootFolderId,maxUploadBytes:8388608,
    notionToken:'test-notion-hmac-secret'
  });
  backend.w19AssertSchema_=()=>{};
  backend.w19AssertTaskPage_=()=>({id:taskId,name:'Задача',page:{properties:{}}});
  backend.w19QueryTaskMaterials_=()=>[{
    id:pageId,name:'Документ',section:'Docs',format:'Google Docs',provider:'Google Drive',
    openUrl:'https://docs.google.com/document/d/ConfirmedGoogleDoc123/edit',googleFileId:'ConfirmedGoogleDoc123',
    folderId:taskFolderId,widgetOwned:true,position:0,syncStatus:'synced',archived:false
  }];
  backend.w19MaterialFromPage_=(page)=>page;
  backend.w20CacheDownloadMaterials_=()=>{};
  backend.w20TaskContextSnapshot_=()=>({path:'Основная / Задача',ancestorIds:'ancestor',depth:2});
  backend.ScriptApp={getService:()=>({getUrl:()=> 'https://script.google.com/macros/s/abcdefghijklmnopqrstuvwxyz0123456789_-AB/exec'})};

  const response=backend.apiBootstrap({taskPageId:taskId,forceRefresh:true});
  assert.equal(response.ok,true,JSON.stringify(response));
  assert.equal(response.data.authoritative,true);
  assert.equal(response.data.actionReady,true);
  assert.match(response.data.trustedUntil,/^\d{4}-\d{2}-\d{2}T/);
  assert.equal(response.data.materials.length,1);
  assert.match(response.data.materials[0].drivePollClaim,/^\d{10}\.[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(JSON.stringify(response.data.preparedCreates)),[{
    section:'Docs',reservationId,openUrl:'https://docs.google.com/document/d/PreparedGoogleDoc123/edit'
  }]);
  assert.equal(postReplaceFullReads,1,'meta confirmation, client cards and prepared descriptors must share one full property snapshot');
  assert.equal(postReplaceSingleReads,0,'the authoritative path must not reread task meta after its full snapshot');

  const materialKey=backend.w20RegistryKey_(taskId,pageId);
  values[materialKey]=JSON.stringify(backend.w20RegistryTombstone_(taskId,pageId));
  postReplaceFullReads=0;postReplaceSingleReads=0;
  const mismatch=backend.w20RegistryWriteTaskMetaResult_(taskId,{
    taskValidatedAt:new Date().toISOString(),snapshotValidatedAt:new Date().toISOString(),snapshotActiveCount:1
  });
  assert.equal(mismatch.ok,true);
  assert.equal(mismatch.registry.activeCount,0);
  assert.equal(mismatch.registry.tombstoneCount,1);
  assert.equal(mismatch.meta.authoritative,false,'a tombstone/count race must invalidate the action proof');
  assert.equal(backend.w20RegistryActionProof_(mismatch.meta,mismatch.registry,rootFolderId).ready,false);
  assert.equal(postReplaceFullReads,1);
  assert.equal(postReplaceSingleReads,0);
});

test('create pool prepares one exact owned file per Google section and reuses it on the second warm', () => {
  const backend=loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const rootFolderId='RootFolder12345',taskFolderId='TaskFolder12345';
  backend.Utilities.formatDate=()=> '2026-08-27 12:00';
  const drive=installReservationDriveMock(backend);
  const replacement=backend.w20RegistryReplaceTaskResult_(taskId,[]);
  assert.equal(replacement.ok,true);
  const validatedAt=new Date().toISOString();
  backend.w20RegistryWriteTaskMeta_(taskId,{
    taskName:'Задача',folderId:taskFolderId,rootFolderId,folderVerified:true,
    folderValidatedAt:validatedAt,taskValidatedAt:validatedAt,snapshotValidatedAt:validatedAt,
    snapshotActiveCount:replacement.activeCount,context:{path:'Основная / Задача',ancestorIds:'ancestor',depth:2}
  });
  backend.w19AuthorizedConfig_=()=>({authorizedTaskPageId:taskId,deniedPageIds:{},rootFolderId});
  backend.w19NotionRequest_=()=>{throw new Error('pool warm must not call Notion');};

  const first=backend.apiWarmCreateContext({taskPageId:taskId});
  assert.equal(first.ok,true,JSON.stringify(first));
  assert.equal(first.data.ready,true);
  assert.equal(first.data.cached,true);
  assert.equal(first.data.preparedCreates.length,3);
  assert.equal(drive.creates,3);
  assert.deepEqual([...first.data.preparedCreates].map((item)=>item.section),['Docs','Sheets','Slides']);
  for(const descriptor of first.data.preparedCreates){
    assert.deepEqual(Object.keys(descriptor).sort(),['openUrl','reservationId','section']);
    assert.match(descriptor.reservationId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const url=new URL(descriptor.openUrl);
    const servicePath=descriptor.section==='Docs'?'document':descriptor.section==='Sheets'?'spreadsheets':'presentation';
    assert.equal(url.origin,'https://docs.google.com');
    assert.match(url.pathname,new RegExp(`^/${servicePath}/d/[A-Za-z0-9_-]{10,}/edit$`));
    assert.equal(url.search,'');assert.equal(url.hash,'');
  }
  for(const file of drive.files.values()){
    assert.equal(file.ownedByMe,true);
    assert.deepEqual(file.parents,[rootFolderId]);
    assert.deepEqual(Object.keys(file.appProperties).sort(),[
      'createReservationId','createReservationSection','createReservationState','materialState','taskPageId','widgetVersion'
    ]);
    assert.equal(file.appProperties.taskPageId,taskId.replaceAll('-',''));
    assert.equal(file.appProperties.createReservationState,'prepared');
    assert.equal(file.appProperties.materialState,'reserved');
  }

  const second=backend.apiWarmCreateContext({taskPageId:taskId});
  assert.equal(second.ok,true,JSON.stringify(second));
  assert.deepEqual(JSON.parse(JSON.stringify(second.data.preparedCreates)),JSON.parse(JSON.stringify(first.data.preparedCreates)));
  assert.equal(drive.creates,3,'second warm must reuse the exact files');
  assert.equal(drive.gets,0,'a complete property snapshot must not trigger Drive metadata reads');
});

test('sectional create warm validates one Google section, stays off Notion and preserves the batch fallback', () => {
  const backend=loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const rootFolderId='RootFolder12345',taskFolderId='TaskFolder12345';
  backend.Utilities.formatDate=()=> '2026-08-27 12:00';
  const drive=installReservationDriveMock(backend);
  const replacement=backend.w20RegistryReplaceTaskResult_(taskId,[]);
  assert.equal(replacement.ok,true);
  const validatedAt=new Date().toISOString();
  backend.w20RegistryWriteTaskMeta_(taskId,{
    taskName:'Задача',folderId:taskFolderId,rootFolderId,folderVerified:true,
    folderValidatedAt:validatedAt,taskValidatedAt:validatedAt,snapshotValidatedAt:validatedAt,
    snapshotActiveCount:replacement.activeCount,context:{path:'Основная / Задача',ancestorIds:'ancestor',depth:2}
  });
  backend.w19AuthorizedConfig_=()=>({authorizedTaskPageId:taskId,deniedPageIds:{},rootFolderId});
  let notionCalls=0;
  backend.w19NotionRequest_=()=>{notionCalls+=1;throw new Error('sectional warm must not call Notion');};
  backend.w19AssertSchema_=()=>{notionCalls+=1;throw new Error('sectional warm must not inspect schema');};
  backend.w19AssertTaskPage_=()=>{notionCalls+=1;throw new Error('sectional warm must not fetch the task');};

  const docs=backend.apiWarmCreateContext({taskPageId:taskId,section:'Docs'});
  assert.equal(docs.ok,true,JSON.stringify(docs));
  assert.equal(docs.data.ready,true);
  assert.deepEqual([...docs.data.preparedCreates].map((item)=>item.section),['Docs']);
  assert.equal(drive.creates,1,'a sectional request must create only its requested reservation');
  assert.equal(notionCalls,0);

  const driveSection=backend.apiWarmCreateContext({taskPageId:taskId,section:'Drive'});
  assert.equal(driveSection.ok,false);
  assert.equal(driveSection.error.code,'INVALID_CREATE_TYPE');
  const mixed=backend.apiWarmCreateContext({taskPageId:taskId,section:'Docs',proofOnly:true});
  assert.equal(mixed.ok,false);
  assert.equal(mixed.error.code,'INVALID_WARM_REQUEST');
  assert.equal(drive.creates,1,'invalid section requests must not touch Drive');

  const batch=backend.apiWarmCreateContext({taskPageId:taskId});
  assert.equal(batch.ok,true,JSON.stringify(batch));
  assert.deepEqual([...batch.data.preparedCreates].map((item)=>item.section),['Docs','Sheets','Slides']);
  assert.equal(drive.creates,3,'the legacy batch request remains a complete fallback');
  assert.equal(notionCalls,0);
});

test('authoritative bootstrap reuses stored prepared descriptors without another Drive call', () => {
  const backend=loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const rootFolderId='RootFolder12345',taskFolderId='TaskFolder12345';
  backend.Utilities.formatDate=()=> '2026-08-27 12:00';
  const drive=installReservationDriveMock(backend);
  const replacement=backend.w20RegistryReplaceTaskResult_(taskId,[]);
  const validatedAt=new Date().toISOString();
  backend.w20RegistryWriteTaskMeta_(taskId,{
    taskName:'Задача',folderId:taskFolderId,rootFolderId,folderVerified:true,
    folderValidatedAt:validatedAt,taskValidatedAt:validatedAt,snapshotValidatedAt:validatedAt,
    snapshotActiveCount:replacement.activeCount,context:{path:'Основная / Задача',ancestorIds:'ancestor',depth:2}
  });
  const cfg={authorizedTaskPageId:taskId,deniedPageIds:{},rootFolderId,maxUploadBytes:8388608};
  backend.w19AuthorizedConfig_=()=>cfg;
  const warmed=backend.apiWarmCreateContext({taskPageId:taskId});
  assert.equal(warmed.ok,true,JSON.stringify(warmed));assert.equal(warmed.data.preparedCreates.length,3);
  const before={creates:drive.creates,lists:drive.lists,gets:drive.gets};
  let notionCalls=0;
  backend.w19AssertSchema_=()=>{};
  backend.w19AssertTaskPage_=()=>({id:taskId,name:'Задача',page:{properties:{}}});
  backend.w19QueryTaskMaterials_=()=>{notionCalls+=1;return [];};
  backend.w20CacheDownloadMaterials_=()=>{};
  backend.w20TaskContextSnapshot_=()=>({path:'Основная / Задача',ancestorIds:'ancestor',depth:2});
  backend.w19EnsureTaskFolder_=()=>{throw new Error('fresh folder proof must avoid Drive');};
  backend.ScriptApp={getService:()=>({getUrl:()=> 'https://script.google.com/macros/s/abcdefghijklmnopqrstuvwxyz0123456789_-AB/exec'})};
  const boot=backend.apiBootstrap({taskPageId:taskId,forceRefresh:true});
  assert.equal(boot.ok,true,JSON.stringify(boot));
  assert.equal(boot.data.authoritative,true);assert.equal(boot.data.actionReady,true);
  assert.equal(notionCalls,1,'authoritative bootstrap keeps its normal single materials query');
  assert.deepEqual(JSON.parse(JSON.stringify(boot.data.preparedCreates)),JSON.parse(JSON.stringify(warmed.data.preparedCreates)));
  assert.deepEqual({creates:drive.creates,lists:drive.lists,gets:drive.gets},before,'prepared descriptor reuse is local-only');
});

test('two tabs consume the same prepared Docs head once, preserve an early rename and refill only after completion', () => {
  const backend=loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId='3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const rootFolderId='RootFolder12345',taskFolderId='TaskFolder12345';
  backend.Utilities.formatDate=()=> '2026-08-27 12:00';
  const drive=installReservationDriveMock(backend);
  const replacement=backend.w20RegistryReplaceTaskResult_(taskId,[]);
  assert.equal(replacement.ok,true);
  const validatedAt=new Date().toISOString();
  backend.w20RegistryWriteTaskMeta_(taskId,{
    taskName:'Задача',folderId:taskFolderId,rootFolderId,folderVerified:true,
    folderValidatedAt:validatedAt,taskValidatedAt:validatedAt,snapshotValidatedAt:validatedAt,
    snapshotActiveCount:replacement.activeCount,
    context:{path:'Основная / Задача',ancestorIds:'ancestor',depth:2,sphereIds:[],directionIds:[],projectIds:[]}
  });
  const cfg={authorizedTaskPageId:taskId,deniedPageIds:{},rootFolderId,dataSourceId:'3822d627-39a1-8018-a2dc-000b95bf5722'};
  backend.w19AuthorizedConfig_=()=>cfg;
  backend.w19AssertSchema_=()=>{};
  const tabOne=backend.apiWarmCreateContext({taskPageId:taskId});
  const tabTwo=backend.apiWarmCreateContext({taskPageId:taskId});
  assert.equal(tabOne.ok,true,JSON.stringify(tabOne));assert.equal(tabTwo.ok,true,JSON.stringify(tabTwo));
  const firstDocs=[...tabOne.data.preparedCreates].find((item)=>item.section==='Docs');
  const secondDocs=[...tabTwo.data.preparedCreates].find((item)=>item.section==='Docs');
  assert.deepEqual(JSON.parse(JSON.stringify(secondDocs)),JSON.parse(JSON.stringify(firstDocs)));
  assert.equal(drive.creates,3);
  const reservedFile=[...drive.files.values()].find((file)=>file.appProperties.createReservationId===firstDocs.reservationId);
  assert.ok(reservedFile);
  const originalPreparedName=reservedFile.name;
  reservedFile.name='Имя, введённое сразу в Google Docs';
  reservedFile.modifiedTime='2026-08-27T09:00:01.000Z';

  let notionCreates=0;
  backend.w20CreateGoogleNotionPage_=(_task,driveFile,folderId,section,_name,position,idem)=>{
    notionCreates+=1;
    assert.equal(driveFile.id,reservedFile.id);
    assert.equal(driveFile.name,'Имя, введённое сразу в Google Docs');
    assert.equal(folderId,taskFolderId);assert.equal(section,'Docs');
    return {id:pageId,material:{
      id:pageId,name:driveFile.name,section,format:'Google Docs',provider:'Google Drive',
      openUrl:driveFile.webViewLink,googleFileId:driveFile.id,folderId,widgetOwned:true,
      mimeType:driveFile.mimeType,size:null,driveMd5:'',downloadName:driveFile.name,
      normalizedUrl:'',knowledgeFormat:'Файл',integrity:'ok',position,syncStatus:'synced',
      archived:false,idempotency:idem,updatedAt:new Date().toISOString()
    }};
  };
  backend.w19MaterialFromPage_=(page)=>page.material;

  const input={taskPageId:taskId,section:'Docs',name:'Название по умолчанию',idempotencyKey:firstDocs.reservationId,reservationId:firstDocs.reservationId};
  const first=backend.apiCreateGoogle(input);
  assert.equal(first.ok,true,JSON.stringify(first));
  assert.equal(first.data.duplicate,false);
  assert.equal(first.data.material.id,pageId);
  assert.equal(first.data.material.googleFileId,reservedFile.id);
  assert.equal(first.data.material.name,'Имя, введённое сразу в Google Docs');
  assert.equal(first.data.material.createRequestId,firstDocs.reservationId);
  assert.equal(notionCreates,1);
  assert.equal(drive.creates,3,'click must not call Drive CREATE');
  assert.notEqual(originalPreparedName,reservedFile.name);
  assert.deepEqual(reservedFile.parents,[taskFolderId]);
  assert.deepEqual(Object.keys(reservedFile.appProperties).sort(),['materialState','notionPageId','taskPageId','widgetIdem','widgetVersion']);
  assert.equal(reservedFile.appProperties.notionPageId,pageId.replaceAll('-',''));
  assert.equal(reservedFile.appProperties.createReservationId,undefined);

  const second=backend.apiCreateGoogle(input);
  assert.equal(second.ok,true,JSON.stringify(second));
  assert.equal(second.data.duplicate,true);
  assert.equal(second.data.material.id,pageId);
  assert.equal(second.data.material.googleFileId,reservedFile.id);
  assert.equal(notionCreates,1,'second tab must not create another Notion page');
  assert.equal(drive.creates,3,'second tab must not create another Drive file');

  const refilled=backend.apiWarmCreateContext({taskPageId:taskId});
  assert.equal(refilled.ok,true,JSON.stringify(refilled));
  assert.equal(drive.creates,4,'only the consumed Docs slot is replenished');
  const nextDocs=[...refilled.data.preparedCreates].find((item)=>item.section==='Docs');
  assert.ok(nextDocs);assert.notEqual(nextDocs.reservationId,firstDocs.reservationId);
  assert.equal([...refilled.data.preparedCreates].length,3);

  const staleShell=backend.apiCreateGoogle(input);
  assert.equal(staleShell.ok,true,JSON.stringify(staleShell));
  assert.equal(staleShell.data.material.googleFileId,reservedFile.id);
  assert.equal(notionCreates,1);
  assert.equal(drive.creates,4,'an old shell must never claim the new head');
  const wrong=backend.apiCreateGoogle({...input,reservationId:nextDocs.reservationId});
  assert.equal(wrong.ok,false);
  assert.equal(wrong.error.code,'RESERVATION_REQUEST_MISMATCH');
  assert.equal(notionCreates,1);assert.equal(drive.creates,4);
});

test('reservation file guards are exact, owned and phase-aware without rejecting early user edits', () => {
  const backend=loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e',task=taskId.replaceAll('-','');
  const reservationId='11111111-1111-4111-8111-111111111111';
  const rootFolderId='RootFolder12345',taskFolderId='TaskFolder12345',fileId='ReservedGoogleFile123';
  const prepared={
    id:fileId,name:'Пользователь уже переименовал',modifiedTime:'2026-08-27T09:01:02.000Z',
    mimeType:'application/vnd.google-apps.document',ownedByMe:true,trashed:false,parents:[rootFolderId],
    appProperties:{widgetVersion:'v20',taskPageId:task,createReservationSection:'Docs',createReservationId:reservationId,createReservationState:'prepared',materialState:'reserved'}
  };
  assert.ok(backend.w20PreparedCreateFile_(prepared,taskId,'Docs',reservationId,rootFolderId));
  assert.equal(backend.w20PreparedCreateFile_({...prepared,ownedByMe:false},taskId,'Docs',reservationId,rootFolderId),null);
  assert.equal(backend.w20PreparedCreateFile_({...prepared,parents:[rootFolderId,'OtherParent123']},taskId,'Docs',reservationId,rootFolderId),null);
  assert.equal(backend.w20PreparedCreateFile_({...prepared,appProperties:{...prepared.appProperties,unexpected:'x'}},taskId,'Docs',reservationId,rootFolderId),null);

  const canonical=backend.w19CanonicalIdempotency_(taskId,'create-google-Docs',reservationId);
  const claim={taskId:task,section:'Docs',reservationId,fileId,folderId:taskFolderId,canonicalHash:backend.w19Hash_(canonical)};
  const activeProps={widgetVersion:'v20',taskPageId:task,widgetIdem:claim.canonicalHash.slice(0,40),materialState:'active'};
  const claimed={...prepared,parents:[taskFolderId],appProperties:activeProps};
  assert.ok(backend.w20ClaimedCreateFile_(claimed,claim));
  const pageId='3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const marked={...claimed,appProperties:{...activeProps,notionPageId:pageId.replaceAll('-','')}};
  assert.equal(backend.w20ClaimedCreateFile_(marked,claim),null,'pre-finalize phase rejects any Notion marker');
  assert.ok(backend.w20ClaimedCreateFile_(marked,claim,pageId),'recovery accepts the exact page marker');
  assert.equal(backend.w20ClaimedCreateFile_(marked,claim,'3c82d627-39a1-81e5-a840-ecb1c98cc5c5'),null);
  assert.equal(backend.w20ClaimedCreateFile_({...marked,appProperties:{...marked.appProperties,unexpected:'x'}},claim,pageId),null);
});

test('fresh prepared Drive metadata is reused only after an observed rename and an uncontended one-second claim handoff', () => {
  const backend = loadBackend();
  const drive = { id: 'ReservedGoogleFile123', name: 'Имя пользователя' };
  let now = 10_000;
  backend.Date = { now: () => now };
  assert.equal(backend.w20RecentlyVerifiedPreparedDrive_(drive, 9_000, 'Подготовленное имя'), drive);
  assert.equal(backend.w20RecentlyVerifiedPreparedDrive_({...drive,name:'Подготовленное имя'}, 9_000, 'Подготовленное имя'), null,
    'an unchanged placeholder must be re-read immediately before the conditional rename');
  now = 10_001;
  assert.equal(backend.w20RecentlyVerifiedPreparedDrive_(drive, 9_000, 'Подготовленное имя'), null);
  now = 8_999;
  assert.equal(backend.w20RecentlyVerifiedPreparedDrive_(drive, 9_000, 'Подготовленное имя'), null);
});

test('post-CAS reservation failures preserve the reverse claim and can never fall back to another file', () => {
  const backend=loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const rootFolderId='RootFolder12345',taskFolderId='TaskFolder12345';
  backend.Utilities.formatDate=()=> '2026-08-27 12:00';
  const drive=installReservationDriveMock(backend);
  const replacement=backend.w20RegistryReplaceTaskResult_(taskId,[]);
  const validatedAt=new Date().toISOString();
  backend.w20RegistryWriteTaskMeta_(taskId,{
    taskName:'Задача',folderId:taskFolderId,rootFolderId,folderVerified:true,
    folderValidatedAt:validatedAt,taskValidatedAt:validatedAt,snapshotValidatedAt:validatedAt,
    snapshotActiveCount:replacement.activeCount,context:{path:'Основная / Задача',ancestorIds:'ancestor',depth:2}
  });
  backend.w19AuthorizedConfig_=()=>({authorizedTaskPageId:taskId,deniedPageIds:{},rootFolderId});
  backend.w19AssertSchema_=()=>{};
  backend.w19FindMaterialByIdempotency_=()=>null;
  const warmed=backend.apiWarmCreateContext({taskPageId:taskId});
  const docs=[...warmed.data.preparedCreates].find((item)=>item.section==='Docs');
  assert.ok(docs);
  let exactTransitions=0;
  backend.w20TransitionClaimedReservationFile_=()=>{
    exactTransitions+=1;
    throw new backend.W19Error_('EXACT_RECOVERY_ONLY','exact retry sentinel',true);
  };
  const input={taskPageId:taskId,section:'Docs',idempotencyKey:docs.reservationId,reservationId:docs.reservationId};
  const failed=backend.apiCreateGoogle(input);
  assert.equal(failed.ok,false);assert.equal(failed.error.code,'EXACT_RECOVERY_ONLY');
  assert.equal(exactTransitions,1);assert.equal(drive.creates,3);
  const canonical=backend.w19CanonicalIdempotency_(taskId,'create-google-Docs',docs.reservationId);
  const ledgerKey=backend.w19IdempotencyLedgerKey_(canonical);
  const props=backend.PropertiesService.getScriptProperties();
  const firstLedger=JSON.parse(props.getProperty(ledgerKey));
  assert.equal(firstLedger.status,'failed');
  assert.match(firstLedger.reservationRef,/^w20:create-claim:[a-f0-9]{48}$/);
  const durable=JSON.parse(props.getProperty(firstLedger.reservationRef));
  assert.equal(durable.status,'claimed');assert.equal(durable.reservationId,docs.reservationId);
  assert.equal(durable.createRequestId,docs.reservationId);
  assert.equal(durable.fileId,[...drive.files.values()].find((file)=>file.appProperties.createReservationId===docs.reservationId).id);

  let legacyCalls=0;
  for(const name of ['w20CreateGoogleHot_','w20CreateGoogleRecovery_','w19CreateGoogleFile_'])backend[name]=()=>{legacyCalls+=1;throw new Error('legacy fallback forbidden');};
  const retryWithoutClientReservation=backend.apiCreateGoogle({taskPageId:taskId,section:'Docs',idempotencyKey:docs.reservationId});
  assert.equal(retryWithoutClientReservation.ok,false);
  assert.equal(retryWithoutClientReservation.error.code,'EXACT_RECOVERY_ONLY');
  assert.equal(exactTransitions,2,'retry must continue the same exact reservation path');
  assert.equal(legacyCalls,0);assert.equal(drive.creates,3);
  const retryLedger=JSON.parse(props.getProperty(ledgerKey));
  assert.equal(retryLedger.status,'failed');assert.equal(retryLedger.reservationRef,firstLedger.reservationRef);

  const wrongReservation='22222222-2222-4222-8222-222222222222';
  const wrong=backend.apiCreateGoogle({...input,reservationId:wrongReservation});
  assert.equal(wrong.ok,false);assert.equal(wrong.error.code,'RESERVATION_REQUEST_MISMATCH');
  assert.equal(exactTransitions,2);assert.equal(legacyCalls,0);assert.equal(drive.creates,3);
  const rewarmed=backend.apiWarmCreateContext({taskPageId:taskId});
  assert.equal(rewarmed.ok,true);
  assert.equal([...rewarmed.data.preparedCreates].some((item)=>item.section==='Docs'),false,'claimed heads are never requeued');
  assert.equal(drive.creates,3);
});

test('reservation v2 prepares one signed 30-day head per client and section with a bounded client set', () => {
  const {backend,taskId,cfg,drive}=installReservationV2Harness();
  const clients=Array.from({length:backend.W20_CREATE_RESERVATION_V2_MAX_CLIENTS+1},(_,index)=>{
    const ordinal=String(index+1);
    return `${ordinal.padStart(8,'0')}-1111-4111-8111-${ordinal.padStart(12,'0')}`;
  });
  const startedAt=Date.now();
  const first=backend.apiWarmCreateContext({taskPageId:taskId,clientId:clients[0]});
  assert.equal(first.ok,true,JSON.stringify(first));
  assert.equal(first.data.preparedCreates.length,3);
  assert.equal(drive.creates,3);
  const clientHash=backend.w20CreateClientHash_(taskId,clients[0]);
  assert.match(clientHash,/^[a-f0-9]{32}$/);
  for(const descriptor of first.data.preparedCreates){
    assert.deepEqual(Object.keys(descriptor).sort(),[
      'generation','navigateUntil','openUrl','preparedName','reservationId','reservationProof','section'
    ]);
    assert.equal(descriptor.generation,1);
    assert.ok(descriptor.preparedName.length>0&&descriptor.preparedName.length<=180);
    assert.match(descriptor.reservationProof,/^[a-f0-9]{64}$/);
    const navigateAt=Date.parse(descriptor.navigateUntil);
    assert.equal(new Date(navigateAt).toISOString(),descriptor.navigateUntil);
    assert.ok(navigateAt>=startedAt+backend.W20_CREATE_RESERVATION_V2_TTL_MS-1000);
    assert.ok(navigateAt<=Date.now()+backend.W20_CREATE_RESERVATION_V2_TTL_MS+1000);
    assert.equal(descriptor.reservationProof,backend.w20CreateReservationV2Proof_(
      taskId,clientHash,descriptor.section,descriptor.reservationId,descriptor.openUrl,descriptor.preparedName,
      descriptor.generation,descriptor.navigateUntil,cfg
    ));
    const slot=backend.w20ReadCreateReservationV2_(backend.PropertiesService.getScriptProperties(),
      backend.w20CreateReservationV2Key_(taskId,clientHash,descriptor.section));
    assert.equal(slot.status,'prepared');assert.equal(slot.generation,1);assert.equal(slot.reservationId,descriptor.reservationId);
    assert.equal(slot.preparedName,descriptor.preparedName);
  }
  for(const file of drive.files.values()){
    assert.deepEqual(Object.keys(file.appProperties).sort(),[
      'createReservationClient','createReservationGeneration','createReservationId','createReservationNavigateUntil',
      'createReservationSection','createReservationState','materialState','taskPageId','widgetVersion'
    ]);
    assert.equal(file.appProperties.createReservationClient,clientHash);
    assert.equal(file.appProperties.createReservationGeneration,'1');
    assert.equal(file.appProperties.materialState,'reserved');
  }
  const repeated=backend.apiWarmCreateContext({taskPageId:taskId,clientId:clients[0]});
  assert.equal(repeated.ok,true,JSON.stringify(repeated));
  assert.deepEqual(JSON.parse(JSON.stringify(repeated.data.preparedCreates)),JSON.parse(JSON.stringify(first.data.preparedCreates)));
  assert.equal(drive.creates,3,'same client reuses exactly one head per section');
  for(const clientId of clients.slice(1,3)){
    const warmed=backend.apiWarmCreateContext({taskPageId:taskId,clientId});
    assert.equal(warmed.ok,true,JSON.stringify(warmed));assert.equal(warmed.data.preparedCreates.length,3);
  }
  const fourth=backend.apiWarmCreateContext({taskPageId:taskId,clientId:clients[3]});
  assert.equal(fourth.ok,true,JSON.stringify(fourth));
  assert.equal(fourth.data.preparedCreates.length,3,'a fourth stable browser keeps the native prepared path');
  assert.equal(drive.creates,12,'the fourth profile receives exact native heads instead of a slow fallback');
  for(const clientId of clients.slice(4,backend.W20_CREATE_RESERVATION_V2_MAX_CLIENTS)){
    const warmed=backend.apiWarmCreateContext({taskPageId:taskId,clientId});
    assert.equal(warmed.ok,true,JSON.stringify(warmed));assert.equal(warmed.data.preparedCreates.length,3);
  }
  assert.equal(drive.creates,backend.W20_CREATE_RESERVATION_V2_MAX_CLIENTS*3);
  const capped=backend.apiWarmCreateContext({taskPageId:taskId,clientId:clients.at(-1)});
  assert.equal(capped.ok,false);assert.equal(capped.error.code,'CREATE_CLIENT_LIMIT');
  assert.equal(drive.creates,backend.W20_CREATE_RESERVATION_V2_MAX_CLIENTS*3,'client cap must not evict or create another head');
});

test('three sectional reservation v2 warms run full cleanup only while provisioning their shared client', () => {
  const {backend,taskId,drive}=installReservationV2Harness();
  const clientId='11111111-1111-4111-8111-111111111111';
  const originalCleanup=backend.w20CleanupExpiredCreateReservationsV2_;
  let cleanupCalls=0;
  backend.w20CleanupExpiredCreateReservationsV2_=(...args)=>{
    cleanupCalls+=1;
    return originalCleanup(...args);
  };
  for(const section of ['Docs','Sheets','Slides']){
    const warmed=backend.apiWarmCreateContext({taskPageId:taskId,clientId,section});
    assert.equal(warmed.ok,true,JSON.stringify(warmed));
    assert.equal(warmed.data.preparedCreates.length,1);
    assert.equal(warmed.data.preparedCreates[0].section,section);
  }
  assert.equal(cleanupCalls,1,'the first locked client provision owns cleanup; active-client sectional warms skip it');
  assert.equal(drive.creates,3);
  for(const section of ['Docs','Sheets','Slides']){
    const repeated=backend.apiWarmCreateContext({taskPageId:taskId,clientId,section});
    assert.equal(repeated.ok,true,JSON.stringify(repeated));
  }
  assert.equal(cleanupCalls,1,'reusing an active client must never rescan every expired reservation');
  assert.equal(drive.creates,3);
});

test('reservation v2 claims the exact file once, preserves idempotency and refills with the next generation', () => {
  const {backend,taskId,taskFolderId,drive}=installReservationV2Harness();
  const clientId='11111111-1111-4111-8111-111111111111';
  const pageId='3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const warmed=backend.apiWarmCreateContext({taskPageId:taskId,clientId,section:'Docs'});
  assert.equal(warmed.ok,true,JSON.stringify(warmed));
  const descriptor=warmed.data.preparedCreates[0];
  const reservedFile=[...drive.files.values()].find((file)=>file.appProperties.createReservationId===descriptor.reservationId);
  assert.ok(reservedFile);reservedFile.name='Имя из Google Docs';
  let notionCreates=0;
  backend.w20CreateGoogleNotionPage_=(_task,driveFile,folderId,section,_name,position,idem)=>{
    notionCreates+=1;
    assert.equal(driveFile.id,reservedFile.id);assert.equal(folderId,taskFolderId);assert.equal(section,'Docs');
    return {id:pageId,material:{
      id:pageId,name:driveFile.name,section,format:'Google Docs',provider:'Google Drive',openUrl:driveFile.webViewLink,
      googleFileId:driveFile.id,folderId,widgetOwned:true,mimeType:driveFile.mimeType,size:null,driveMd5:'',
      downloadName:driveFile.name,normalizedUrl:'',knowledgeFormat:'Файл',integrity:'ok',position,
      syncStatus:'synced',archived:false,idempotency:idem,updatedAt:new Date().toISOString()
    }};
  };
  backend.w19MaterialFromPage_=(page)=>page.material;
  const input={taskPageId:taskId,clientId,idempotencyKey:descriptor.reservationId,...descriptor};
  const first=backend.apiCreateGoogle(input);
  assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.data.duplicate,false);
  assert.equal(first.data.material.googleFileId,reservedFile.id);assert.equal(first.data.material.name,'Имя из Google Docs');
  assert.equal(notionCreates,1);assert.equal(drive.creates,1,'click uses the prepared file and never Drive CREATE');
  assert.equal(drive.gets,1,'the exact metadata verified by the atomic claim is reused by the transition');
  assert.deepEqual(reservedFile.parents,[taskFolderId]);
  assert.deepEqual(Object.keys(reservedFile.appProperties).sort(),['materialState','notionPageId','taskPageId','widgetIdem','widgetVersion']);
  const clientHash=backend.w20CreateClientHash_(taskId,clientId);
  assert.equal(backend.PropertiesService.getScriptProperties().getProperty(backend.w20CreateReservationV2Key_(taskId,clientHash,'Docs')),null,
    'prepared head is consumed atomically');
  const canonical=backend.w19CanonicalIdempotency_(taskId,'create-google-Docs',descriptor.reservationId);
  const claim=backend.w20ReadClaimedReservation_(backend.w19Hash_(canonical));
  assert.equal(claim.schema,2);assert.equal(claim.status,'done');assert.equal(claim.fileId,reservedFile.id);
  assert.equal(claim.generation,1);assert.equal(claim.preparedName,descriptor.preparedName);
  const second=backend.apiCreateGoogle(input);
  assert.equal(second.ok,true,JSON.stringify(second));assert.equal(second.data.duplicate,true);
  assert.equal(second.data.material.googleFileId,reservedFile.id);assert.equal(notionCreates,1);assert.equal(drive.creates,1);
  const refilled=backend.apiWarmCreateContext({taskPageId:taskId,clientId,section:'Docs'});
  assert.equal(refilled.ok,true,JSON.stringify(refilled));assert.equal(refilled.data.preparedCreates.length,1);
  assert.equal(refilled.data.preparedCreates[0].generation,2);
  assert.notEqual(refilled.data.preparedCreates[0].reservationId,descriptor.reservationId);
  assert.equal(drive.creates,2);
});

test('reservation v2 rejects malformed, expired and stale tuples without any legacy create fallback', () => {
  const {backend,taskId,cfg}=installReservationV2Harness();
  const clientId='11111111-1111-4111-8111-111111111111';
  const warmed=backend.apiWarmCreateContext({taskPageId:taskId,clientId,section:'Docs'});
  const descriptor=warmed.data.preparedCreates[0];
  let legacyCalls=0;
  for(const name of ['w20CreateGoogleHot_','w20CreateGoogleRecovery_','w19CreateGoogleFile_'])backend[name]=()=>{legacyCalls+=1;throw new Error('legacy fallback forbidden');};
  const base={taskPageId:taskId,clientId,idempotencyKey:descriptor.reservationId,...descriptor};
  const badProof=backend.apiCreateGoogle({...base,reservationProof:'0'.repeat(64)});
  assert.equal(badProof.ok,false);assert.equal(badProof.error.code,'RESERVATION_V2_PROOF_INVALID');
  const uppercaseProof=backend.apiCreateGoogle({...base,reservationProof:descriptor.reservationProof.toUpperCase()});
  assert.equal(uppercaseProof.ok,false);assert.equal(uppercaseProof.error.code,'RESERVATION_V2_INVALID');
  const stringGeneration=backend.apiCreateGoogle({...base,generation:String(descriptor.generation)});
  assert.equal(stringGeneration.ok,false);assert.equal(stringGeneration.error.code,'RESERVATION_V2_INVALID');
  const paddedName=backend.apiCreateGoogle({...base,preparedName:` ${descriptor.preparedName} `});
  assert.equal(paddedName.ok,false);assert.equal(paddedName.error.code,'RESERVATION_V2_INVALID');
  const missingName={...base};delete missingName.preparedName;
  const incomplete=backend.apiCreateGoogle(missingName);
  assert.equal(incomplete.ok,false);assert.equal(incomplete.error.code,'RESERVATION_V2_INVALID');
  const missingTuple=backend.apiCreateGoogle({taskPageId:taskId,clientId,section:'Docs',idempotencyKey:descriptor.reservationId,reservationId:descriptor.reservationId});
  assert.equal(missingTuple.ok,false);assert.equal(missingTuple.error.code,'RESERVATION_V2_INVALID');
  const clientHash=backend.w20CreateClientHash_(taskId,clientId);
  const stale={...descriptor,generation:descriptor.generation+1};
  stale.reservationProof=backend.w20CreateReservationV2Proof_(taskId,clientHash,stale.section,stale.reservationId,
    stale.openUrl,stale.preparedName,stale.generation,stale.navigateUntil,cfg);
  const staleResult=backend.apiCreateGoogle({taskPageId:taskId,clientId,idempotencyKey:stale.reservationId,...stale});
  assert.equal(staleResult.ok,false);assert.equal(staleResult.error.code,'RESERVATION_STALE');
  const expired={...descriptor,navigateUntil:new Date(Date.now()-1000).toISOString()};
  expired.reservationProof=backend.w20CreateReservationV2Proof_(taskId,clientHash,expired.section,expired.reservationId,
    expired.openUrl,expired.preparedName,expired.generation,expired.navigateUntil,cfg);
  const expiredResult=backend.apiCreateGoogle({taskPageId:taskId,clientId,idempotencyKey:expired.reservationId,...expired});
  assert.equal(expiredResult.ok,false);assert.equal(expiredResult.error.code,'RESERVATION_EXPIRED');
  const badClient=backend.apiCreateGoogle({...base,clientId:'11111111-1111-1111-1111-111111111111'});
  assert.equal(badClient.ok,false);assert.equal(badClient.error.code,'CREATE_CLIENT_INVALID');
  const paddedClient=backend.apiCreateGoogle({...base,clientId:` ${clientId} `});
  assert.equal(paddedClient.ok,false);assert.equal(paddedClient.error.code,'CREATE_CLIENT_INVALID');
  assert.equal(legacyCalls,0,'terminal v2 failures never create a replacement file');
});

test('reservation v2 cleanup trashes only exact expired blanks and terminally detaches quarantined mismatches', () => {
  const {backend,taskId,rootFolderId,cfg,drive}=installReservationV2Harness();
  const clientId='11111111-1111-4111-8111-111111111111';
  const warmed=backend.apiWarmCreateContext({taskPageId:taskId,clientId});
  assert.equal(warmed.ok,true,JSON.stringify(warmed));
  const clientHash=backend.w20CreateClientHash_(taskId,clientId);
  const props=backend.PropertiesService.getScriptProperties();
  const expire=(section)=>{
    const key=backend.w20CreateReservationV2Key_(taskId,clientHash,section);
    const slot=JSON.parse(props.getProperty(key));
    slot.navigateUntil=Date.now()-1000;
    slot.reservationProof=backend.w20CreateReservationV2Proof_(taskId,clientHash,slot.section,slot.reservationId,
      backend.w20CreateReservationOpenUrl_(slot.fileId,slot.section),slot.preparedName,slot.generation,
      new Date(slot.navigateUntil).toISOString(),cfg);
    props.setProperty(key,JSON.stringify(slot));
    const file=drive.files.get(slot.fileId);
    file.appProperties.createReservationNavigateUntil=String(slot.navigateUntil);
    return {key,slot,file};
  };
  const exact=expire('Sheets');
  const quarantined=expire('Docs');
  quarantined.file.appProperties.unexpected='user-change';
  const edited=expire('Slides');
  edited.file.modifiedTime=new Date(Date.parse(edited.file.modifiedTime)+1000).toISOString();
  const userFile={
    id:'UserOwnedActiveFile123',name:'Пользовательский файл',mimeType:'application/vnd.google-apps.document',
    ownedByMe:true,trashed:false,parents:[rootFolderId],appProperties:{widgetVersion:'v20',taskPageId:taskId.replaceAll('-',''),materialState:'active'}
  };
  drive.files.set(userFile.id,userFile);
  const removed=backend.w20CleanupExpiredCreateReservationsV2_(taskId,cfg,backend.W20_CREATE_RESERVATION_V2_CLEANUP_LIMIT);
  assert.equal(removed,1);
  assert.equal(exact.file.trashed,true);assert.equal(props.getProperty(exact.key),null);
  assert.equal(quarantined.file.trashed,false);assert.equal(props.getProperty(quarantined.key),null);
  assert.equal(edited.file.trashed,false);assert.equal(props.getProperty(edited.key),null);
  assert.equal(userFile.trashed,false,'active or unrelated user files are never cleanup candidates');
  const nextDocs=backend.apiWarmCreateContext({taskPageId:taskId,clientId,section:'Docs'});
  const nextSlides=backend.apiWarmCreateContext({taskPageId:taskId,clientId,section:'Slides'});
  assert.equal(nextDocs.ok,true,JSON.stringify(nextDocs));assert.equal(nextSlides.ok,true,JSON.stringify(nextSlides));
  assert.equal(nextDocs.data.preparedCreates[0].generation,2);
  assert.equal(nextSlides.data.preparedCreates[0].generation,2);
  assert.notEqual(nextDocs.data.preparedCreates[0].reservationId,quarantined.slot.reservationId);
  assert.notEqual(nextSlides.data.preparedCreates[0].reservationId,edited.slot.reservationId);
  assert.equal(quarantined.file.trashed,false,'quarantined user content is preserved after the replacement head is prepared');
  assert.equal(edited.file.trashed,false,'an edited reservation is never deleted while its slot is rotated');
});

test('reservation v2 cleanup lease serializes a cleaning head and permits stale-lease quarantine recovery', () => {
  const {backend,taskId,cfg,drive}=installReservationV2Harness();
  const clientId='11111111-1111-4111-8111-111111111111';
  const warmed=backend.apiWarmCreateContext({taskPageId:taskId,clientId,section:'Docs'});
  assert.equal(warmed.ok,true,JSON.stringify(warmed));
  const descriptor=warmed.data.preparedCreates[0];
  const clientHash=backend.w20CreateClientHash_(taskId,clientId);
  const key=backend.w20CreateReservationV2Key_(taskId,clientHash,'Docs');
  const props=backend.PropertiesService.getScriptProperties();
  const cleaning=JSON.parse(props.getProperty(key));
  cleaning.navigateUntil=Date.now()-1000;
  cleaning.status='cleaning';
  cleaning.cleanupAttemptId=crypto.randomUUID();
  cleaning.at=Date.now();
  delete cleaning.reservationProof;
  props.setProperty(key,JSON.stringify(cleaning));
  const file=drive.files.get(cleaning.fileId);
  file.appProperties.createReservationNavigateUntil=String(cleaning.navigateUntil);
  file.appProperties.unexpected='preserve-user-change';
  const getsBefore=drive.gets;
  assert.equal(backend.w20CleanupExpiredCreateReservationsV2_(taskId,cfg,1),0);
  assert.equal(drive.gets,getsBefore,'a live cleanup lease prevents a second worker from touching Drive');
  assert.equal(JSON.parse(props.getProperty(key)).cleanupAttemptId,cleaning.cleanupAttemptId);

  cleaning.at=Date.now()-backend.W20_CREATE_RESERVATION_V2_CLEANUP_LEASE_MS-1;
  props.setProperty(key,JSON.stringify(cleaning));
  assert.equal(backend.w20CleanupExpiredCreateReservationsV2_(taskId,cfg,1),0);
  assert.equal(props.getProperty(key),null,'a stale cleanup lease is taken over and terminally detached');
  assert.equal(file.trashed,false,'lease recovery never deletes a mismatched file');
  const replacement=backend.apiWarmCreateContext({taskPageId:taskId,clientId,section:'Docs'});
  assert.equal(replacement.ok,true,JSON.stringify(replacement));
  assert.equal(replacement.data.preparedCreates[0].generation,descriptor.generation+1);
  assert.notEqual(replacement.data.preparedCreates[0].reservationId,descriptor.reservationId);
});

test('reservation v2 cleanup prunes expired client records even when every head was already claimed', () => {
  const {backend,taskId,cfg}=installReservationV2Harness();
  const clientId='11111111-1111-4111-8111-111111111111';
  const warmed=backend.apiWarmCreateContext({taskPageId:taskId,clientId,section:'Docs'});
  assert.equal(warmed.ok,true,JSON.stringify(warmed));
  const clientHash=backend.w20CreateClientHash_(taskId,clientId);
  const props=backend.PropertiesService.getScriptProperties();
  const clientKey=backend.w20CreateClientV2Key_(taskId,clientHash);
  const slotKey=backend.w20CreateReservationV2Key_(taskId,clientHash,'Docs');
  const record=JSON.parse(props.getProperty(clientKey));
  record.expiresAt=Date.now()-1;
  props.setProperty(clientKey,JSON.stringify(record));
  props.deleteProperty(slotKey);
  assert.equal(backend.w20CleanupExpiredCreateReservationsV2_(taskId,cfg,1),0);
  assert.equal(props.getProperty(clientKey),null,'expired no-head clients cannot accumulate without bound');
});

test('reservationRef survives failed, stale and completed idempotency ledger rewrites', () => {
  const backend=loadBackend();
  const props=backend.PropertiesService.getScriptProperties();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e',requestId='11111111-1111-4111-8111-111111111111';
  const canonical=backend.w19CanonicalIdempotency_(taskId,'create-google-Docs',requestId);
  const ledgerKey=backend.w19IdempotencyLedgerKey_(canonical);
  const reservationRef='w20:create-claim:'+'a'.repeat(48);
  assert.throws(()=>backend.w19WithIdempotency_(canonical,()=>{
    const pending=JSON.parse(props.getProperty(ledgerKey));pending.reservationRef=reservationRef;props.setProperty(ledgerKey,JSON.stringify(pending));
    throw new backend.W19Error_('NOTION_UNAVAILABLE','failed',true);
  }),(error)=>error&&error.code==='NOTION_UNAVAILABLE');
  const failed=JSON.parse(props.getProperty(ledgerKey));
  assert.equal(failed.status,'failed');assert.equal(failed.reservationRef,reservationRef);
  const completed=backend.w19WithIdempotency_(canonical,(state)=>{
    assert.equal(state.recovery,true);
    const pending=JSON.parse(props.getProperty(ledgerKey));
    assert.equal(pending.status,'pending');assert.equal(pending.reservationRef,reservationRef);
    return {completed:true};
  });
  assert.equal(completed.completed,true);
  const done=JSON.parse(props.getProperty(ledgerKey));
  assert.equal(done.status,'done');assert.equal(done.reservationRef,reservationRef);

  const staleCanonical=backend.w19CanonicalIdempotency_(taskId,'create-google-Sheets','22222222-2222-4222-8222-222222222222');
  const staleKey=backend.w19IdempotencyLedgerKey_(staleCanonical);
  props.setProperty(staleKey,JSON.stringify({status:'pending',at:Date.now()-backend.W19_IDEMPOTENCY_PENDING_TTL_MS-1,attemptId:crypto.randomUUID(),reservationRef}));
  backend.w19WithIdempotency_(staleCanonical,()=>{
    const pending=JSON.parse(props.getProperty(staleKey));assert.equal(pending.reservationRef,reservationRef);return {recovered:true};
  });
  assert.equal(JSON.parse(props.getProperty(staleKey)).reservationRef,reservationRef);
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
    backend.w20FindPreparedReservationFiles_=()=>[];
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
  assert.match(guard, /trigger\.getHandlerFunction\(\) === expectedHandler/);
  assert.match(guard, /\['scheduledSync', 'scheduledFinalizeUploads'\]/);
  assert.match(guard, /trigger\.getUniqueId\(\)/);
});

test('scheduled sync cleans v2 reservations without warming the unreachable legacy pool', () => {
  const scheduled = backendSource.slice(backendSource.indexOf('function scheduledSync'), backendSource.indexOf('function w19ClaimScheduledSync_'));
  assert.match(scheduled, /w20CleanupExpiredCreateReservationsV2_\(cfg\.authorizedTaskPageId, cfg, W20_CREATE_RESERVATION_V2_CLEANUP_LIMIT\)/);
  assert.doesNotMatch(scheduled, /w20WarmCreatePool_/);
  assert.doesNotMatch(scheduled, /create_reservation_background_deferred/);
});

function runScheduledProofCycle({cursor=null,hasMore=false,paginated=false,errorPage='' }={}) {
  const backend=loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const rootFolderId='ScheduledRootFolder123',folderId='ScheduledTaskFolder123';
  const cfg={authorizedTaskPageId:taskId,dataSourceId:'3822d627-39a1-8018-a2dc-000b95bf5722',rootFolderId,
    notionToken:'scheduled-proof-test-secret',deniedPageIds:{}};
  const pageIds=['3c72d627-39a1-8120-bd0a-f969e6846945','3c82d627-39a1-8120-bd0a-f969e6846946'];
  const pages=pageIds.map((id,index)=>({id,material:{id,name:`Material ${index+1}`,section:'Docs',format:'Google Docs',provider:'Google Drive',
    openUrl:`https://docs.google.com/document/d/ScheduledGoogleDoc${index+1}/edit`,googleFileId:`ScheduledGoogleDoc${index+1}`,
    folderId,widgetOwned:true,widgetOwnedBinary:false,position:index,syncStatus:'synced',archived:false,updatedAt:new Date().toISOString()}}));
  const calls={task:[],folders:0,replacements:[],meta:[],proof:0,upserts:[],finishes:[]};
  backend.w19Config_=()=>cfg;
  backend.w19AssertScheduledInvocation_=()=>{};
  backend.w19ClaimScheduledSync_=()=>({token:'scheduled-lease-token',cursor});
  backend.w19FinishScheduledSync_=(...args)=>calls.finishes.push(args);
  backend.w19AssertSchema_=()=>({ok:true});
  backend.w19NotionRequest_=(_method,_path,body)=>{
    if(paginated){
      const continuation=body&&body.start_cursor==='next-page';
      return {results:continuation?pages.slice(1):pages.slice(0,1),has_more:!continuation,next_cursor:continuation?null:'next-page'};
    }
    return {results:pages,has_more:hasMore,next_cursor:hasMore?'next-page':null};
  };
  backend.w19SyncOnePage_=(page)=>{if(page.id===errorPage)throw new Error('sync failed');return page;};
  backend.w19MarkSyncError_=()=>{};
  backend.w19MaterialFromPage_=(page)=>page.material;
  backend.w20PreserveRegistryRuntimeMetadata_=(_task,materials)=>materials;
  backend.w19AssertTaskPage_=(value)=>{calls.task.push(value);return {id:taskId,name:'Scheduled task',page:{properties:{}}};};
  backend.w19WithMutationLock_=(fn)=>fn();
  backend.w19EnsureTaskFolder_=()=>{calls.folders+=1;return {id:folderId,mimeType:'application/vnd.google-apps.folder',trashed:false,
    appProperties:{widgetVersion:'v20',taskPageId:taskId.replace(/-/g,'')}};};
  const replaceTaskResult=backend.w20RegistryReplaceTaskResult_;
  backend.w20RegistryReplaceTaskResult_=(receivedTask,materials,preserveAfter)=>{
    calls.replacements.push({taskId:receivedTask,materials,preserveAfter});
    return replaceTaskResult(receivedTask,materials,preserveAfter);
  };
  const writeTaskMetaResult=backend.w20RegistryWriteTaskMetaResult_;
  backend.w20RegistryWriteTaskMetaResult_=(receivedTask,meta)=>{
    calls.meta.push({taskId:receivedTask,meta});
    return writeTaskMetaResult(receivedTask,meta);
  };
  const actionProof=backend.w20RegistryActionProof_;
  backend.w20RegistryActionProof_=(...args)=>{calls.proof+=1;return actionProof(...args);};
  const registryUpsert=backend.w20RegistryUpsert_;
  backend.w20RegistryUpsert_=(...args)=>{calls.upserts.push(args);return registryUpsert(...args);};
  backend.w19PruneLedger_=()=>{};
  backend.w20CleanupExpiredCreateReservationsV2_=()=>{};
  const result=backend.scheduledSync({triggerUid:'scheduled-trigger'});
  return {backend,result,calls,taskId,rootFolderId,folderId,pages};
}

test('scheduled sync refreshes action proof only from a coherent complete single-page cycle', () => {
  const {backend,result,calls,taskId,rootFolderId,folderId,pages}=runScheduledProofCycle();
  assert.equal(result.ok,true);
  assert.equal(result.proofRefreshed,true);
  assert.deepEqual(calls.task,[taskId]);
  assert.equal(calls.folders,1);
  assert.equal(calls.replacements.length,1);
  assert.equal(calls.replacements[0].taskId,taskId);
  assert.equal(calls.replacements[0].materials.length,pages.length);
  assert.ok(Number.isFinite(calls.replacements[0].preserveAfter)&&calls.replacements[0].preserveAfter>0);
  assert.equal(calls.meta.length,1);
  const meta=calls.meta[0].meta;
  assert.equal(calls.meta[0].taskId,taskId);
  assert.equal(meta.taskName,'Scheduled task');
  assert.equal(meta.folderId,folderId);
  assert.equal(meta.rootFolderId,rootFolderId);
  assert.equal(meta.folderVerified,true);
  assert.equal(meta.snapshotActiveCount,pages.length);
  assert.equal(meta.taskValidatedAt,meta.snapshotValidatedAt);
  assert.equal(meta.taskValidatedAt,meta.folderValidatedAt);
  assert.ok(Number.isFinite(Date.parse(meta.taskValidatedAt)));
  assert.equal(calls.proof,1);
  assert.equal(calls.upserts.length,0);
  assert.deepEqual(calls.finishes,[['scheduled-lease-token',true,null]]);
  const storedMeta=backend.w20RegistryReadTaskMeta_(taskId);
  const storedRegistry=backend.w20RegistryReadTaskResult_(taskId,null);
  assert.equal(storedMeta.snapshotActiveCount,pages.length);
  assert.equal(storedRegistry.integrityOk,true);
  assert.equal(storedRegistry.activeCount,pages.length);
  assert.equal(backend.w20RegistryActionProof_(storedMeta,storedRegistry,rootFolderId).ready,true);
});

test('scheduled sync completes pagination in one lease and refreshes one coherent proof', () => {
  const {result,calls,pages}=runScheduledProofCycle({paginated:true});
  assert.equal(result.proofRefreshed,true);
  assert.equal(result.checked,pages.length);
  assert.equal(calls.replacements.length,1);
  assert.equal(calls.replacements[0].materials.length,pages.length);
  assert.equal(calls.meta.length,1);
  assert.equal(calls.proof,1);
  assert.equal(calls.upserts.length,0);
  assert.deepEqual(calls.finishes,[['scheduled-lease-token',true,null]]);
});

test('scheduled sync partial, error and cursor cycles never confirm action proof', () => {
  const cases=[
    {name:'has more',options:{hasMore:true},expectedUpserts:2},
    {name:'continuation cursor',options:{cursor:'prior-page'},expectedUpserts:2},
    {name:'page error',options:{errorPage:'3c82d627-39a1-8120-bd0a-f969e6846946'},expectedUpserts:1}
  ];
  cases.forEach(({name,options,expectedUpserts})=>{
    const {result,calls}=runScheduledProofCycle(options);
    assert.equal(result.proofRefreshed,false,name);
    assert.equal(calls.task.length,0,name);
    assert.equal(calls.folders,0,name);
    assert.equal(calls.replacements.length,0,name);
    assert.equal(calls.meta.length,0,name);
    assert.equal(calls.proof,0,name);
    assert.equal(calls.upserts.length,expectedUpserts,name);
  });
});

test('bootstrap, task sync and scheduled proof refresh never call the legacy sequential page sync', () => {
  const bootstrap = backendSource.slice(backendSource.indexOf('function apiBootstrap'), backendSource.indexOf('function apiCreateGoogle'));
  const sync = backendSource.slice(backendSource.indexOf('function apiSyncTask'), backendSource.indexOf('/* ========================= Admin-only setup'));
  const scheduled = backendSource.slice(backendSource.indexOf('function scheduledSync'), backendSource.indexOf('function w19ClaimScheduledSync_'));
  for (const source of [bootstrap,sync,scheduled]) assert.doesNotMatch(source,/w19SyncPageList_/);
});

test('background triggers keep rename at five minutes and finalize a bounded queue every minute', () => {
  const installer = backendSource.slice(backendSource.indexOf('function adminInstallSyncTrigger'), backendSource.indexOf('function scheduledSync'));
  assert.match(installer, /newTrigger\('scheduledSync'\)\.timeBased\(\)\.everyMinutes\(5\)\.create\(\)/);
  assert.match(installer, /newTrigger\('scheduledFinalizeUploads'\)\.timeBased\(\)\.everyMinutes\(1\)\.create\(\)/);
  assert.match(installer, /w20DrainAttachmentJobs_\(cfg, W20_ATTACHMENT_JOB_DRAIN_LIMIT\)/);
});

test('empty attachment queue returns before schema or Notion work', () => {
  const backend=loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const calls={prune:0,due:0,schema:0,drain:0};
  backend.w19Config_=()=>({authorizedTaskPageId:taskId});
  backend.w19AssertScheduledInvocation_=()=>{};
  backend.w20PruneAttachmentJobs_=()=>{calls.prune+=1;};
  backend.w20DueAttachmentJobs_=(receivedTask,limit)=>{calls.due+=1;assert.equal(receivedTask,taskId);assert.equal(limit,1);return [];};
  backend.w19AssertSchema_=()=>{calls.schema+=1;};
  backend.w20DrainAttachmentJobs_=()=>{calls.drain+=1;return {checked:0,attached:0,errors:0};};
  const result=backend.scheduledFinalizeUploads({triggerUid:'scheduled-trigger'});
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{ok:true,checked:0,attached:0,errors:0});
  assert.deepEqual(calls,{prune:1,due:1,schema:0,drain:0});
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
  assert.equal(patchedProperties['[SYS] Download name'], undefined);
  assert.equal(patchedProperties['[SYS] MIME type'], undefined);
  assert.equal(patchedProperties['[SYS] Размер байт'], undefined);
  assert.equal(patchedProperties['[SYS] Drive MD5'], undefined);
  assert.equal(patchedProperties['[SYS] Последняя синхронизация'],undefined);
  assert.equal(changed.data.materials[0].name, 'Новое имя');
  assert.equal(changed.data.materials[0].mimeType, 'application/vnd.google-apps.document');
  assert.equal(changed.data.materials[0].downloadName, 'Новое имя');
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
  let lockHeld = false;
  backend.Date = { now: () => now };
  backend.LockService = {
    getScriptLock: () => ({
      tryLock: () => { lockHeld = true; return true; },
      releaseLock: () => { lockHeld = false; releases += 1; }
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
    assert.equal(lockHeld,false,'Notion pacing must not block create-ledger and registry checkpoints');
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

test('registry-seeded download coordinates never outlive the action proof', () => {
  const backend=loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId='3c72d627-39a1-81e5-a840-ecb1c98cc5c5';
  const dataSourceId='3822d627-39a1-8018-a2dc-000b95bf5722';
  const now=1_800_000_000_000;
  const proofExpiry=now+5_100;
  const writes=[];
  backend.Date={now:()=>now,parse:globalThis.Date.parse};
  backend.CacheService={getScriptCache:()=>({
    putAll:(entries,ttl)=>writes.push({entries,ttl}),
    put:(key,value,ttl)=>writes.push({entries:{[key]:value},ttl})
  })};
  const cfg={dataSourceId,deniedPageIds:{}};
  const material={
    id:pageId,provider:'Google Drive',googleFileId:'1OwnedBinaryFile123',folderId:'1OwnedTaskFolder123',
    widgetOwnedBinary:true,archived:false,syncStatus:'synced'
  };
  assert.equal(backend.w20CacheDownloadRegistryMaterials_(taskId,[material],cfg,new Date(proofExpiry).toISOString()),1);
  assert.equal(writes.length,1);
  assert.ok(writes[0].ttl>0&&writes[0].ttl<=5);
  const cached=JSON.parse(Object.values(writes[0].entries)[0]);
  assert.equal(cached.expiresAt,proofExpiry);
  assert.doesNotMatch(JSON.stringify(cached),/accessToken|notionToken|downloadUrl|attachmentUrl|sourceUrl/i);
  assert.equal(backend.w20CacheDownloadRegistryMaterials_(taskId,[material],cfg,new Date(now-1).toISOString()),0);
  assert.equal(writes.length,1);
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

test('structured registry reads and replacements distinguish a valid empty snapshot from storage failure', () => {
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
  const emptyRead=backend.w20RegistryReadTaskResult_(taskId,null);
  assert.equal(emptyRead.ok,true);
  assert.equal(emptyRead.integrityOk,true);
  assert.equal(emptyRead.activeCount,0);
  const emptyReplace=backend.w20RegistryReplaceTaskResult_(taskId,[]);
  assert.equal(emptyReplace.ok,true);
  assert.equal(emptyReplace.activeCount,0);

  backend.PropertiesService={getScriptProperties:()=>({getProperties:()=>{throw new Error('storage unavailable');}})};
  const failedRead=backend.w20RegistryReadTaskResult_(taskId,null);
  assert.equal(failedRead.ok,false);
  assert.equal(failedRead.error,'STORAGE_ERROR');
  const failedReplace=backend.w20RegistryReplaceTaskResult_(taskId,[]);
  assert.equal(failedReplace.ok,false);
  assert.equal(failedReplace.error,'STORAGE_ERROR');
});

test('registry tombstone grace protects recent removals from snapshots and scheduled upserts, then expires', () => {
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
  assert.equal(backend.w20RegistryRemove_(taskId, pageId), true);
  const key = backend.w20RegistryKey_(taskId, pageId);
  assert.equal(JSON.parse(values.get(key)).recordType, 'tombstone');
  assert.equal(backend.w20RegistryReadTask_(taskId, null).length, 0);

  assert.equal(backend.W20_REGISTRY_TOMBSTONE_GRACE_MS, 15 * 60 * 1000);
  const recentTombstone = JSON.parse(values.get(key));
  recentTombstone.removedAt = new Date(Date.now() - 5000).toISOString();
  recentTombstone.registryStoredAt = recentTombstone.removedAt;
  values.set(key, JSON.stringify(recentTombstone));
  const snapshotStartedAt = Date.now();
  assert.ok(Date.parse(recentTombstone.removedAt) < snapshotStartedAt);
  assert.equal(backend.w20RegistryReplaceTask_(taskId, [{ ...material, name: 'Snapshot still contains removed card' }], snapshotStartedAt), 0);
  assert.equal(JSON.parse(values.get(key)).recordType, 'tombstone');
  assert.equal(backend.w20RegistryReadTask_(taskId, null).length, 0);
  assert.equal(backend.w20RegistryUpsert_(taskId, { ...material, name: 'Запоздалый scheduled upsert' }), false);
  assert.equal(JSON.parse(values.get(key)).recordType, 'tombstone');

  const oldTombstone = JSON.parse(values.get(key));
  oldTombstone.removedAt = new Date(Date.now() - (15 * 60 * 1000 + 5000)).toISOString();
  oldTombstone.registryStoredAt = oldTombstone.removedAt;
  values.set(key, JSON.stringify(oldTombstone));
  const freshSnapshotStartedAt = Date.now();
  assert.equal(backend.w20RegistryReplaceTask_(taskId, [{ ...material, name: 'Свежая authoritative карточка' }], freshSnapshotStartedAt), 1);
  const restored = backend.w20RegistryReadTask_(taskId, null);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].name, 'Свежая authoritative карточка');
  assert.equal(JSON.parse(values.get(key)).recordType, undefined);

  assert.equal(backend.w20RegistryRemove_(taskId, pageId), true);
  assert.equal(backend.w20RegistryRestore_(taskId, { ...material, name: 'Восстановленная явно карточка' }), true);
  assert.equal(backend.w20RegistryReadTask_(taskId, null)[0].name, 'Восстановленная явно карточка');

  const addLink = backendSource.slice(backendSource.indexOf('function apiAddLink'), backendSource.indexOf('function apiUpload'));
  const archiveState = backendSource.slice(backendSource.indexOf('function w19SetArchiveState_'), backendSource.indexOf('function w19Audit_'));
  assert.match(addLink, /outcome\.restored\s*\?\s*w20RegistryRestore_/);
  assert.match(archiveState, /w20RegistryRestore_\(task\.id, material\)/);
  assert.match(archiveState, /w20RegistryRestore_\(task\.id, updatedMaterial\)/);
});

test('authoritative bootstrap and sync retain recent tombstones while merging concurrent registry updates', () => {
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
    const staleKey = backend.w20RegistryKey_(taskId, stalePageId);
    const oldTombstone = JSON.parse(values.get(staleKey));
    oldTombstone.removedAt = new Date(Date.now() - 5000).toISOString();
    oldTombstone.registryStoredAt = oldTombstone.removedAt;
    values.set(staleKey, JSON.stringify(oldTombstone));
    backend.w19AuthorizedConfig_ = () => ({
      authorizedTaskPageId: taskId,
      deniedPageIds: {},
      rootFolderId: 'OwnedRootFolder123',
      maxUploadBytes: 8 * 1024 * 1024,
      notionToken: 'test-notion-hmac-secret'
    });
    backend.w19AssertSchema_ = () => ({ ok: true });
    backend.w19AssertTaskPage_ = () => ({ id: taskId, name: 'Задача', page: { properties: {} } });
    backend.w19EnsureTaskFolder_ = () => ({ id: 'OwnedTaskFolder123' });
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
    assert.equal(JSON.parse(values.get(staleKey)).recordType, 'tombstone');
    assert.equal(backend.w20RegistryUpsert_(taskId, { ...stale, name: 'Запоздалый scheduled upsert' }), false);
  }
});

test('authoritative bootstrap and sync fail action proof closed when task meta is not durably confirmed', () => {
  for (const apiName of ['apiBootstrap', 'apiSyncTask']) {
    for (const metaWriteMode of ['failed', 'unconfirmed']) {
      const backend = loadBackend();
      const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
      const pageId = '3c72d627-39a1-8120-bd0a-f969e6846945';
      const values = new Map();
      backend.PropertiesService = {
        getScriptProperties: () => ({
          getProperty: (key) => values.get(key) ?? null,
          getProperties: () => Object.fromEntries(values),
          setProperty: (key, value) => values.set(key, String(value)),
          setProperties: (entries) => Object.entries(entries).forEach(([key, value]) => values.set(key, String(value))),
          deleteProperty: (key) => values.delete(key)
        })
      };
      backend.ScriptApp = { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/abcdefghijklmnopqrstuvwxyz0123456789_-AB/exec' }) };
      backend.w19AuthorizedConfig_ = () => ({
        authorizedTaskPageId: taskId,
        deniedPageIds: {},
        rootFolderId: 'OwnedRootFolder123',
        maxUploadBytes: 8 * 1024 * 1024,
        notionToken: 'test-notion-hmac-secret'
      });
      backend.w19AssertSchema_ = () => ({ ok: true });
      backend.w19AssertTaskPage_ = () => ({ id: taskId, name: 'Задача', page: { properties: {} } });
      backend.w19EnsureTaskFolder_ = () => ({ id: 'OwnedTaskFolder123' });
      backend.w20CacheDownloadMaterials_ = () => 0;
      backend.w19MaterialFromPage_ = (page) => page;
      backend.w19QueryTaskMaterials_ = () => [{
        id: pageId,
        name: 'Документ',
        section: 'Docs',
        format: 'Google Docs',
        provider: 'Google Drive',
        openUrl: 'https://docs.google.com/document/d/ConfirmedGoogleDoc123/edit',
        googleFileId: 'ConfirmedGoogleDoc123',
        folderId: 'OwnedTaskFolder123',
        position: 0,
        syncStatus: 'synced'
      }];

      let writes = 0;
      if (apiName === 'apiBootstrap') {
        const writeTaskMetaResult = backend.w20RegistryWriteTaskMetaResult_;
        backend.w20RegistryWriteTaskMetaResult_ = (...args) => {
          writes += 1;
          if (metaWriteMode === 'failed') {
            return { ok: false, meta: null, registry: null, propertyValues: null, error: 'LOCK_BUSY' };
          }
          const result = writeTaskMetaResult(...args);
          return { ...result, meta: null };
        };
      } else {
        backend.w20RegistryWriteTaskMeta_ = () => {
          writes += 1;
          return metaWriteMode === 'unconfirmed';
        };
        if (metaWriteMode === 'unconfirmed') backend.w20RegistryReadTaskMeta_ = () => null;
      }

      const response = backend[apiName]({ taskPageId: taskId, forceRefresh: true });
      assert.equal(response.ok, true, `${apiName}/${metaWriteMode}: ${JSON.stringify(response)}`);
      assert.equal(writes, 1, `${apiName}/${metaWriteMode}: meta write must be attempted exactly once`);
      assert.equal(response.data.authoritative, true, `${apiName}/${metaWriteMode}: live response remains authoritative`);
      assert.equal(response.data.fullySynced, true, `${apiName}/${metaWriteMode}: live response remains fully synced`);
      assert.equal(response.data.actionReady, false, `${apiName}/${metaWriteMode}: hot action proof must fail closed`);
      assert.equal(response.data.trustedUntil, null, `${apiName}/${metaWriteMode}: failed proof must not expose a trust deadline`);
    }
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
      '[SYS] Формат файла': { select: { name: 'Word' } }
    }
  });
  assert.equal(material.downloadUrl, null);
  assert.equal(material.canDownload, false);
  assert.equal(material.hostedAttachment, false);
});

test('fresh binary upload uses only the authoritative registry task, folder and atomic position', () => {
  const harness = installUploadApiHarness();
  const response = harness.backend.apiUpload(harness.input);

  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(harness.calls.schema, 1);
  assert.equal(harness.calls.limit, 0, 'workspace plan discovery is deferred to the attachment finalizer');
  assert.deepEqual(JSON.parse(JSON.stringify(harness.calls.claim)), [[harness.taskId, 'Docs', harness.cfg.rootFolderId]]);
  assert.equal(harness.calls.taskAssert, 0, 'hot upload must not GET the task');
  assert.equal(harness.calls.idemLookup, 0, 'fresh hot upload must not query duplicate knowledge');
  assert.equal(harness.calls.folder, 0, 'hot upload must not ensure the task folder');
  assert.equal(harness.calls.driveLookup, 0, 'fresh hot upload must not query duplicate Drive files');
  assert.equal(harness.calls.fileLookup, 0, 'fresh hot upload must not query by Drive file id');
  assert.equal(harness.calls.nextPosition, 0, 'hot upload must use the atomic registry position');
  assert.equal(harness.calls.createBinary.length, 1);
  assert.equal(harness.calls.createBinary[0][0].id, harness.taskId);
  assert.equal(harness.calls.createBinary[0][0].name, 'Проверенная задача');
  assert.equal(harness.calls.createBinary[0][1], 'TrustedTaskFolder123');
  assert.deepEqual(Array.from(harness.calls.createBinary[0][4]), [1, 2, 3]);
  assert.equal(harness.calls.notionUpload.length, 0);
  assert.equal(harness.calls.notionCreate.length, 1);
  assert.equal(harness.calls.notionCreate[0].data.googleFolderId, 'TrustedTaskFolder123');
  assert.equal(harness.calls.notionCreate[0].data.position, 7);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.calls.notionCreate[0].data.attachments)), []);
  assert.equal(harness.calls.queue.length, 1);
  assert.equal(harness.calls.idempotencyKey, '3c62d62739a180a1aac7ec19ffc9ef8e|upload|upload-request-0001');
  assert.equal(harness.calls.notionCreate[0].data.idempotency, harness.calls.idempotencyKey);
  assert.equal(Object.hasOwn(response.data.material, 'idempotency'), false, 'full internal key must not reach the client');
  assert.equal(response.data.material.folderId, 'TrustedTaskFolder123');
  assert.equal(response.data.material.position, 7);
  assert.equal(harness.calls.marker.length, 1);
  assert.equal(harness.calls.cache.length, 1);
  assert.equal(harness.calls.registry.length, 1);
});

test('upload recovery always runs the durable duplicate lookup and returns the same Drive and Notion object', () => {
  const pageId = '3c72d627-39a1-8120-bd0a-f969e6846945';
  const existingPage = {
    id: pageId,
    material: {
      id: pageId,
      name: 'brief.pdf',
      section: 'Docs',
      format: 'PDF',
      provider: 'Google Drive',
      openUrl: 'https://drive.google.com/file/d/UploadedDriveFile123/view',
      googleFileId: 'UploadedDriveFile123',
      folderId: 'FallbackTaskFolder123',
      widgetOwned: true,
      widgetOwnedBinary: true,
      syncStatus: 'synced',
      archived: false,
      position: 4,
      idempotency: '3c62d62739a180a1aac7ec19ffc9ef8e|upload|upload-request-0001'
    }
  };
  const harness = installUploadApiHarness({ recovery: true, existingPage });
  const response = harness.backend.apiUpload(harness.input);

  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.data.duplicate, true);
  assert.equal(response.data.material.id, pageId);
  assert.equal(response.data.material.googleFileId, 'UploadedDriveFile123');
  assert.equal(harness.calls.claim.length, 0, 'recovery must never claim a fresh registry slot');
  assert.equal(harness.calls.taskAssert, 1);
  assert.equal(harness.calls.idemLookup, 1);
  assert.equal(harness.calls.driveMetadata, 1);
  assert.equal(harness.calls.marker.length, 1);
  assert.equal(harness.calls.folder, 0);
  assert.equal(harness.calls.driveLookup, 0);
  assert.equal(harness.calls.fileLookup, 0);
  assert.equal(harness.calls.nextPosition, 0);
  assert.equal(harness.calls.createBinary.length, 0);
  assert.equal(harness.calls.notionUpload.length, 0);
  assert.equal(harness.calls.notionCreate.length, 0);
  assert.equal(harness.calls.cache.length, 1);
});

test('stale upload action proof falls back to live task, folder and position checks without fresh-attempt duplicate queries', () => {
  const harness = installUploadApiHarness({ slot: null });
  const response = harness.backend.apiUpload(harness.input);

  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(harness.calls.claim.length, 1);
  assert.equal(harness.calls.taskAssert, 1);
  assert.equal(harness.calls.idemLookup, 0);
  assert.equal(harness.calls.folder, 1);
  assert.equal(harness.calls.driveLookup, 0);
  assert.equal(harness.calls.fileLookup, 0);
  assert.equal(harness.calls.createBinary.length, 1);
  assert.equal(harness.calls.createBinary[0][1], 'FallbackTaskFolder123');
  assert.equal(harness.calls.nextPosition, 1);
  assert.equal(harness.calls.notionCreate[0].data.googleFolderId, 'FallbackTaskFolder123');
  assert.equal(harness.calls.notionCreate[0].data.position, 23);
});

test('malformed fresh upload slot fails closed without falling through to caller or live task context', () => {
  const harness = installUploadApiHarness({ slot: { taskMeta: { folderId: 'bad' }, position: 7 } });
  const response = harness.backend.apiUpload(harness.input);

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'UPLOAD_CONTEXT_STALE');
  assert.equal(harness.calls.claim.length, 1);
  assert.equal(harness.calls.taskAssert, 0);
  assert.equal(harness.calls.idemLookup, 0);
  assert.equal(harness.calls.folder, 0);
  assert.equal(harness.calls.nextPosition, 0);
  assert.equal(harness.calls.createBinary.length, 0);
  assert.equal(harness.calls.notionUpload.length, 0);
  assert.equal(harness.calls.notionCreate.length, 0);
});

test('binary upload returns after an empty-attachment knowledge and queues the hosted copy', () => {
  const upload = backendSource.slice(backendSource.indexOf('function apiUpload'), backendSource.indexOf('function w20AttachmentJobKey_'));
  const create = backendSource.slice(backendSource.indexOf('function w19CreateNotionMaterial_'), backendSource.indexOf('function w19AppendContextProperties_'));
  const sync = backendSource.slice(backendSource.indexOf('function w19SyncOnePageUnlocked_'), backendSource.indexOf('function w19MarkSyncError_'));
  assert.doesNotMatch(upload, /w19CreateAndSendNotionUpload_\(bytes/);
  assert.match(upload, /attachments:\s*\[\]/);
  assert.match(upload, /w20TryEnqueueAttachmentJob_\(taskId, outcome\.material, runtimeDriveMetadata\)/);
  assert.match(upload, /var outcome = w19WithIdempotency_/);
  assert.doesNotMatch(upload, /w19AssertMaterialForTask_\(outcome\.material\.id/);
  assert.match(upload, /pageForDownloadCache = page/);
  assert.match(upload, /w20CacheDownloadMaterials_\(taskId, \[pageForDownloadCache\], cfg\)/);
  assert.match(create, /Array\.isArray\(data\.attachments\)/);
  assert.match(sync, /driveData\.sourceUrl\s*&&\s*!material\.widgetOwnedBinary\s*&&\s*!material\.hostedAttachment/);
});

function installAttachmentFinalizerHarness() {
  const backend=loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId='3c72d627-39a1-8120-bd0a-f969e6846945';
  const fileId='UploadedDriveFile123',folderId='TrustedTaskFolder123';
  const cfg={authorizedTaskPageId:taskId,deniedPageIds:{},rootFolderId:'TrustedRootFolder123',maxUploadBytes:8*1024*1024,
    dataSourceId:'3822d627-39a1-8018-a2dc-000b95bf5722',notionVersion:'2026-03-11',notionToken:'private-test-token'};
  const material={id:pageId,name:'brief.pdf',section:'Docs',format:'PDF',provider:'Google Drive',openUrl:'https://drive.google.com/',
    googleFileId:fileId,folderId,widgetOwned:true,widgetOwnedBinary:true,hostedAttachment:false,syncStatus:'synced',archived:false,
    idempotency:`${taskId.replaceAll('-','')}|upload|upload-request-0001`};
  const page={id:pageId,properties:{'Вложения':{files:[]}}};
  const idemHash=backend.w19Hash_(material.idempotency).slice(0,40);
  const baseDrive={id:fileId,name:'brief.pdf',mimeType:'application/pdf',size:'3',md5Checksum:'5289df737df57326fcdd22597afb1fac',ownedByMe:true,
    trashed:false,parents:[folderId],appProperties:{widgetVersion:'v20',materialState:'active',taskPageId:taskId.replaceAll('-',''),
      notionPageId:pageId.replaceAll('-',''),widgetIdem:idemHash}};
  const calls={create:0,send:0,patch:0,drive:0,mutation:0};
  backend.w19AuthorizedConfig_=()=>cfg;
  backend.w19AssertSchema_=()=>({ok:true});
  backend.w20AssertAuthorizedTaskId_=(value)=>{assert.equal(value,taskId);return taskId;};
  backend.w19AssertMaterialForTask_=(receivedPage,receivedTask,_cfg,allowArchived)=>{
    assert.equal(receivedPage,pageId);assert.equal(receivedTask,taskId);assert.equal(allowArchived,true);return page;
  };
  backend.w19MaterialFromPage_=()=>material;
  backend.w19AssertOwnedBinary_=()=>{calls.drive+=1;return {...baseDrive,appProperties:{...baseDrive.appProperties}};};
  backend.w19EffectiveUploadLimit_=()=>1024;
  backend.DriveApp={getFileById:(id)=>{assert.equal(id,fileId);return {getBlob:()=>({getBytes:()=>[1,2,3]})};}};
  backend.w20CreateNotionUpload_=()=>{calls.create+=1;return {id:'43833259-72ae-404e-8441-b6577f3159b4',status:'pending',expiry_time:'2026-08-28T12:00:00Z'};};
  backend.w20SendNotionUploadBlob_=()=>{calls.send+=1;return {id:'43833259-72ae-404e-8441-b6577f3159b4',status:'uploaded',expiry_time:null};};
  backend.w20GetNotionUpload_=()=>({id:'43833259-72ae-404e-8441-b6577f3159b4',status:'uploaded',expiry_time:null});
  backend.w19WithMutationLock_=(fn)=>{calls.mutation+=1;return fn();};
  backend.w19UpdateNotionPage_=(_id,props)=>{calls.patch+=1;page.properties['Вложения']=props['Вложения'];material.hostedAttachment=true;return page;};
  backend.w20EnqueueAttachmentJob_(taskId,material,baseDrive);
  return {backend,taskId,pageId,fileId,folderId,cfg,material,page,baseDrive,calls};
}

test('attachment queue is compact metadata-only, idempotent, leased once and prunes malformed or expired records', () => {
  const h=installAttachmentFinalizerHarness();
  const props=h.backend.PropertiesService.getScriptProperties();
  const key=h.backend.w20AttachmentJobKey_(h.taskId,h.pageId);
  const raw=props.getProperty(key);
  assert.ok(Buffer.byteLength(raw,'utf8')<9000);
  assert.doesNotMatch(raw,/private-test-token|AQID|base64|https?:\/\//i);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(),['attempts','createdAt','fileId','folderId','idemHash','lastCode','leaseToken','leaseUntil',
    'nextAt','notionUploadId','pageId','schema','sentMd5','sentSize','state','taskId','updatedAt']);
  const first=JSON.parse(raw);
  const duplicate=h.backend.w20EnqueueAttachmentJob_(h.taskId,h.material,h.baseDrive);
  assert.equal(duplicate.createdAt,first.createdAt);
  const claim=h.backend.w20ClaimAttachmentJob_(h.taskId,h.pageId);
  assert.ok(claim);
  assert.ok(claim.job.leaseUntil-Date.now()>=7*60*1000);
  assert.equal(h.backend.w20ClaimAttachmentJob_(h.taskId,h.pageId),null);
  const malformedKey='w20:attachment-job:malformed';
  props.setProperty(malformedKey,'{"bytes":"secret"}');
  const expired={...first,pageId:'3c82d627-39a1-8120-bd0a-f969e6846946',createdAt:Date.now()-h.backend.W20_ATTACHMENT_JOB_TTL_MS-1,
    updatedAt:Date.now()-h.backend.W20_ATTACHMENT_JOB_TTL_MS-1};
  const expiredKey=h.backend.w20AttachmentJobKey_(h.taskId,expired.pageId);
  props.setProperty(expiredKey,JSON.stringify(expired));
  assert.equal(h.backend.w20PruneAttachmentJobs_(),2);
  assert.equal(props.getProperty(malformedKey),null);
  assert.equal(props.getProperty(expiredKey),null);
});

test('finalizer attaches an uploaded null-expiry id to the exact empty target and verifies Drive twice', () => {
  const h=installAttachmentFinalizerHarness();
  const result=h.backend.apiFinalizeUploadAttachment({taskPageId:h.taskId,pageId:h.pageId});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.data.status,'attached');
  assert.equal(h.calls.create,1);
  assert.equal(h.calls.send,1);
  assert.equal(h.calls.patch,1,'expiry_time=null alone must not skip the exact target PATCH');
  assert.equal(h.calls.drive,2,'Drive fingerprint is checked before SEND and immediately before PATCH');
  assert.equal(h.calls.mutation,1,'only the final target recheck and PATCH use the mutation fence');
  assert.equal(h.backend.w20ReadAttachmentJob_(h.taskId,h.pageId),null);
});

test('manual target attachments are never overwritten and a successful knowledge upload survives queue failure', () => {
  const h=installAttachmentFinalizerHarness();
  h.page.properties['Вложения']={files:[{name:'manual.pdf',type:'external',external:{url:'https://example.com/manual.pdf'}}]};
  const blocked=h.backend.apiFinalizeUploadAttachment({taskPageId:h.taskId,pageId:h.pageId});
  assert.equal(blocked.ok,false);
  assert.equal(blocked.error.code,'ATTACHMENT_CONFLICT');
  assert.equal(h.calls.patch,0);
  assert.equal(h.backend.w20ReadAttachmentJob_(h.taskId,h.pageId).state,'error');
  h.backend.w20EnqueueAttachmentJob_(h.taskId,h.material,h.baseDrive);
  assert.equal(h.backend.w20ReadAttachmentJob_(h.taskId,h.pageId).state,'error','ordinary reconciliation must not revive a permanent conflict');

  const upload=installUploadApiHarness();
  upload.backend.w20TryEnqueueAttachmentJob_=()=>null;
  const created=upload.backend.apiUpload(upload.input);
  assert.equal(created.ok,true,JSON.stringify(created));
  assert.equal(upload.calls.notionCreate.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(upload.calls.notionCreate[0].data.attachments)),[]);

  const hosted=installAttachmentFinalizerHarness();
  hosted.material.hostedAttachment=true;
  hosted.page.properties['Вложения']={files:[{name:'manual.pdf',type:'file',file:{url:'https://secure.notion-static.com/manual.pdf',expiry_time:'soon'}}]};
  const hostedBlocked=hosted.backend.apiFinalizeUploadAttachment({taskPageId:hosted.taskId,pageId:hosted.pageId});
  assert.equal(hostedBlocked.ok,false);
  assert.equal(hostedBlocked.error.code,'ATTACHMENT_CONFLICT','a hosted target is not proof when this job never created an upload');
  assert.equal(hosted.calls.patch,0);
});

test('a missing prior Notion upload resets its stale fingerprint before one exact replacement send', () => {
  const h=installAttachmentFinalizerHarness();
  const props=h.backend.PropertiesService.getScriptProperties();
  const key=h.backend.w20AttachmentJobKey_(h.taskId,h.pageId);
  const stale=JSON.parse(props.getProperty(key));
  stale.notionUploadId='43833259-72ae-404e-8441-b6577f3159b4';
  stale.sentMd5=h.baseDrive.md5Checksum;
  stale.sentSize=Number(h.baseDrive.size);
  props.setProperty(key,JSON.stringify(stale));
  const newer={...h.baseDrive,md5Checksum:'b4a3ba90641372b4e4eaa841a5a400ec'};
  h.backend.w19AssertOwnedBinary_=()=>{h.calls.drive+=1;return {...newer,appProperties:{...newer.appProperties}};};
  h.backend.DriveApp={getFileById:()=>({getBlob:()=>({getBytes:()=>[4,5,6]})})};
  h.backend.w20GetNotionUpload_=()=>null;
  h.backend.w20CreateNotionUpload_=()=>{h.calls.create+=1;return {id:'54833259-72ae-404e-8441-b6577f3159b5',status:'pending',expiry_time:'soon'};};
  h.backend.w20SendNotionUploadBlob_=(id)=>{h.calls.send+=1;return {id,status:'uploaded',expiry_time:null};};
  const result=h.backend.apiFinalizeUploadAttachment({taskPageId:h.taskId,pageId:h.pageId});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(h.calls.create,1);
  assert.equal(h.calls.send,1);
  assert.equal(h.calls.patch,1);
  assert.equal(h.calls.drive,2);
});

test('Drive fingerprint changes abandon the old Notion upload and retry with a new exact version', () => {
  const h=installAttachmentFinalizerHarness();
  let driveReads=0,blobReads=0,creates=0,sends=0;
  const newer={...h.baseDrive,md5Checksum:'b4a3ba90641372b4e4eaa841a5a400ec'};
  h.backend.DriveApp={getFileById:()=>({getBlob:()=>({getBytes:()=>blobReads++===0?[1,2,3]:[4,5,6]})})};
  h.backend.w19AssertOwnedBinary_=()=>{driveReads+=1;return driveReads===1?h.baseDrive:newer;};
  h.backend.w20CreateNotionUpload_=()=>({id:creates++===0?'43833259-72ae-404e-8441-b6577f3159b4':'54833259-72ae-404e-8441-b6577f3159b5',status:'pending',expiry_time:'soon'});
  h.backend.w20SendNotionUploadBlob_=(id)=>{sends+=1;return {id,status:'uploaded',expiry_time:null};};
  const first=h.backend.apiFinalizeUploadAttachment({taskPageId:h.taskId,pageId:h.pageId});
  assert.equal(first.ok,false);
  assert.equal(first.error.code,'ATTACHMENT_DRIVE_CHANGED');
  const props=h.backend.PropertiesService.getScriptProperties();
  const key=h.backend.w20AttachmentJobKey_(h.taskId,h.pageId);
  const retry=JSON.parse(props.getProperty(key));retry.nextAt=0;retry.leaseToken='';retry.leaseUntil=0;props.setProperty(key,JSON.stringify(retry));
  h.backend.w19AssertOwnedBinary_=()=>newer;
  const second=h.backend.apiFinalizeUploadAttachment({taskPageId:h.taskId,pageId:h.pageId});
  assert.equal(second.ok,true,JSON.stringify(second));
  assert.equal(creates,2);
  assert.equal(sends,2);
  assert.equal(h.calls.patch,1);
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
    const replacement=backend.w20RegistryReplaceTaskResult_(taskId,[{
      id:'3c72d627-39a1-8120-bd0a-f969e6846945',name:'Существующий',section:'Docs',format:'Google Docs',provider:'Google Drive',
      openUrl:'https://docs.google.com/document/d/ExistingGoogleDoc123/edit',googleFileId:'ExistingGoogleDoc123',folderId:'TaskFolder12345',widgetOwned:true,position:7,syncStatus:'synced'
    }]);
    assert.equal(replacement.ok,true);
    const validatedAt=new Date().toISOString();
    backend.w20RegistryWriteTaskMeta_(taskId,{
      taskName:'Задача',folderId:'TaskFolder12345',rootFolderId:'RootFolder12345',folderVerified:true,
      folderValidatedAt:validatedAt,taskValidatedAt:validatedAt,snapshotValidatedAt:validatedAt,
      snapshotActiveCount:replacement.activeCount
    });
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
  assert.match(sync, /driveData\.sourceUrl !== material\.openUrl/);
  assert.doesNotMatch(sync, /W19_P\.(?:PROVIDER|MIME|SIZE|DRIVE_MD5|DOWNLOAD_NAME|NORMALIZED_URL|SYNC_ERROR|INTEGRITY)/);
});

test('Notion schema keeps the exact minimal widget and shared-context properties', () => {
  const backend = loadBackend();
  const required = [
    'Name', 'Тип', 'Внутри', 'Ссылка', 'Вложения', 'Формат знания', 'Архив',
    '[SYS] Формат файла', '[SYS] Раздел виджета', '[SYS] Google File ID', '[SYS] Google Folder ID',
    '[SYS] Позиция', '[SYS] Sync status', '[SYS] Idempotency key',
    '[SYS] Context path', '[SYS] Ancestor IDs', '[SYS] Глубина',
    '[SYS] Контекст: Сфера', '[SYS] Контекст: Направление', '[SYS] Контекст: Проект', '[SYS] Контекст обновлён'
  ].sort();
  const propertyKeys = [
    'NAME', 'TYPE', 'INSIDE', 'SOURCE', 'ATTACHMENTS', 'KNOWLEDGE_FORMAT', 'ARCHIVE',
    'FILE_FORMAT', 'SECTION', 'GOOGLE_FILE_ID', 'GOOGLE_FOLDER_ID', 'POSITION', 'SYNC_STATUS', 'IDEMPOTENCY',
    'CONTEXT_PATH', 'ANCESTOR_IDS', 'DEPTH', 'CONTEXT_SPHERE', 'CONTEXT_DIRECTION', 'CONTEXT_PROJECT', 'CONTEXT_UPDATED'
  ].sort();
  assert.deepEqual(Object.keys(backend.W19_REQUIRED_SCHEMA).sort(), required);
  assert.deepEqual(Object.keys(backend.W19_P).sort(), propertyKeys);
  assert.match(backendSource, /function w19FindMaterialBySourceUrl_[\s\S]*property: W19_P\.SOURCE, url: \{ equals: url \}/);
});

test('Drive runtime metadata survives authoritative Notion snapshots only through the trusted registry identity', () => {
  const backend = loadBackend();
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const material = {
    id: '3c72d627-39a1-8120-bd0a-f969e6846945', name: 'Файл.docx', section: 'Docs', format: 'Word',
    provider: 'Google Drive', openUrl: 'https://drive.google.com/file/d/OwnedFile12345/view',
    googleFileId: 'OwnedFile12345', folderId: 'OwnedFolder12345', mimeType: null, size: null,
    driveMd5: '', downloadName: 'Файл.docx', normalizedUrl: 'https://drive.google.com/file/d/OwnedFile12345/view'
  };
  backend.w20RegistryReadTaskResult_ = () => ({
    ok: true, integrityOk: true, materials: [{
      ...material, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 12345, driveMd5: 'a'.repeat(32), downloadName: 'Файл.docx'
    }]
  });
  const [preserved] = backend.w20PreserveRegistryRuntimeMetadata_(taskId, [material]);
  assert.equal(preserved.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(preserved.size, 12345);
  assert.equal(preserved.driveMd5, 'a'.repeat(32));
  const [mismatch] = backend.w20PreserveRegistryRuntimeMetadata_(taskId, [{...material, googleFileId:'DifferentOwnedFile123'}]);
  assert.equal(mismatch.mimeType, null);
  assert.equal(mismatch.size, null);
});

test('retired redundant metadata properties are neither required nor written', () => {
  assert.doesNotMatch(backendSource, /W19_P\.(?:SHA256|LAST_SYNC)|\[SYS\] (?:SHA-256|Последняя синхронизация)/);
  assert.doesNotMatch(backendSource, /W19_P\.(?:PROVIDER|MIME|SIZE|DRIVE_MD5|DOWNLOAD_NAME|NORMALIZED_URL|SYNC_ERROR|INTEGRITY)/);
  assert.doesNotMatch(backendSource, /\[SYS\] (?:Провайдер|MIME type|Размер байт|Drive MD5|Download name|Normalized URL|Ошибка sync|Integrity)/);
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

function installFastPrepareDownloadFixture(backend, options = {}) {
  const taskId = '3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId = '3c72d627-39a1-81e1-971f-c6b30665ce55';
  const folderId = 'OwnedTaskFolder12345';
  const rootFolderId = 'OwnedRootFolder12345';
  const fileId = 'OwnedBinaryFile12345';
  const compactTask = backend.WidgetV19Core.compactUuid(taskId);
  const compactPage = backend.WidgetV19Core.compactUuid(pageId);
  const nowIso = new Date().toISOString();
  const cfg = {
    authorizedTaskPageId: taskId,
    dataSourceId: '3822d627-39a1-8018-a2dc-000b95bf5722',
    rootFolderId,
    maxUploadBytes: 1024,
    allowedEmail: 'owner@example.com',
    deniedPageIds: {}
  };
  const cached = { id: pageId, provider: 'Google Drive', googleFileId: fileId, folderId };
  const meta = {
    authoritative: true,
    snapshotActiveCount: 1,
    taskValidatedAt: nowIso,
    snapshotValidatedAt: nowIso,
    folderId,
    rootFolderId,
    folderVerified: true,
    folderValidatedAt: nowIso
  };
  const registry = {
    ok: true,
    integrityOk: true,
    activeCount: 1,
    materials: [{
      id: pageId,
      name: 'report.pdf',
      section: 'Drive',
      format: 'Other File',
      provider: 'Google Drive',
      googleFileId: fileId,
      folderId,
      widgetOwned: true,
      widgetOwnedBinary: true,
      archived: false,
      syncStatus: 'synced'
    }]
  };
  const drive = {
    id: fileId,
    name: 'report.pdf',
    mimeType: 'application/pdf',
    size: '123',
    ownedByMe: true,
    trashed: false,
    parents: [folderId],
    appProperties: {
      widgetVersion: 'v20',
      taskPageId: compactTask,
      notionPageId: compactPage,
      materialState: 'active'
    }
  };
  const calls = { driveGets: 0, notion: 0, root: 0, fallback: 0 };
  backend.w19AuthorizedConfig_ = () => cfg;
  backend.w20DownloadGrantEpoch_ = () => 0;
  backend.w20GetCachedDownloadMaterial_ = () => cached;
  backend.w20FreshRegistryDownloadProof_ = () => {
    const proof = backend.w20RegistryActionProof_(meta, registry, rootFolderId);
    const exact = registry.materials.filter((candidate) => backend.WidgetV19Core.normalizeUuid(candidate.id) === pageId);
    return proof.ready && registry.ok && registry.integrityOk && registry.activeCount === registry.materials.length &&
      registry.activeCount === meta.snapshotActiveCount && exact.length === 1 ? {
        taskId: compactTask, pageId: compactPage, meta, registry, proof, material: exact[0]
      } : null;
  };
  backend.w19AssertMaterialForTask_ = () => { calls.notion += 1; throw new Error('hot cache must not query Notion'); };
  backend.w19AssertRootFolder_ = () => { calls.root += 1; throw new Error('hot proof must not query the root folder'); };
  backend.Drive = { Files: { get(receivedFileId) {
    calls.driveGets += 1;
    assert.equal(receivedFileId, fileId, 'the fast path may GET only the cached exact file id');
    return JSON.parse(JSON.stringify(drive));
  } } };
  backend.w19AssertOwnedBinary_ = () => {
    calls.fallback += 1;
    if (options.rejectFallback) {
      throw new backend.W19Error_('DOWNLOAD_NOT_OWNED', 'full ownership fallback rejected the file', false);
    }
    return { ...drive, id: fileId, ownedByMe: true, trashed: false, parents: [folderId] };
  };
  backend.w20IssueDownloadGrant_ = () => ({
    mode: 'grant',
    downloadGrant: 'a'.repeat(96),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  return { taskId, pageId, folderId, rootFolderId, fileId, cfg, cached, meta, registry, drive, calls };
}

test('prepare download hot cache plus exact fresh registry proof performs one exact Drive file GET', () => {
  const backend = loadBackend();
  const fixture = installFastPrepareDownloadFixture(backend);
  const result = backend.apiPrepareDownload({ taskPageId: fixture.taskId, pageId: fixture.pageId });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.mode, 'grant');
  assert.equal(fixture.calls.driveGets, 1);
  assert.equal(fixture.calls.notion, 0);
  assert.equal(fixture.calls.root, 0);
  assert.equal(fixture.calls.fallback, 0);
  assert.equal(result.data.directDownloadUrl, backend.w20DriveDownloadUrl_(fixture.fileId, fixture.cfg.allowedEmail));
});

test('prepare download cold cache uses one coherent fresh registry snapshot and one exact Drive GET', () => {
  const backend = loadBackend();
  const realFreshRegistryDownloadProof = backend.w20FreshRegistryDownloadProof_;
  const fixture = installFastPrepareDownloadFixture(backend);
  const values = {};
  const safe = backend.w20RegistrySafeMaterial_(fixture.taskId, fixture.registry.materials[0]);
  values[backend.w20RegistryKey_(fixture.taskId, fixture.pageId)] = JSON.stringify(safe);
  values[backend.w20RegistryMetaKey_(fixture.taskId)] = JSON.stringify(
    backend.w20RegistryTaskMetaRecord_(fixture.taskId, fixture.meta)
  );
  let propertyReads = 0;
  backend.PropertiesService = { getScriptProperties: () => ({
    getProperties() { propertyReads += 1; return { ...values }; }
  }) };
  backend.w20GetCachedDownloadMaterial_ = () => null;
  backend.w20FreshRegistryDownloadProof_ = realFreshRegistryDownloadProof;
  backend.w19AssertMaterialForTask_ = () => { fixture.calls.notion += 1; throw new Error('fresh registry proof must avoid Notion'); };

  const result = backend.apiPrepareDownload({ taskPageId: fixture.taskId, pageId: fixture.pageId });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(propertyReads, 1, 'registry materials and task meta must come from one Properties snapshot');
  assert.equal(fixture.calls.driveGets, 1);
  assert.equal(fixture.calls.notion, 0);
  assert.equal(fixture.calls.root, 0);
  assert.equal(fixture.calls.fallback, 0);
});

test('prepare download cold cache rejects stale registry proof and keeps the full fallback', () => {
  const backend = loadBackend();
  const realFreshRegistryDownloadProof = backend.w20FreshRegistryDownloadProof_;
  const fixture = installFastPrepareDownloadFixture(backend);
  const stale = new Date(Date.now() - 21 * 60_000).toISOString();
  fixture.meta.taskValidatedAt = stale;
  fixture.meta.snapshotValidatedAt = stale;
  const values = {};
  values[backend.w20RegistryKey_(fixture.taskId, fixture.pageId)] = JSON.stringify(
    backend.w20RegistrySafeMaterial_(fixture.taskId, fixture.registry.materials[0])
  );
  values[backend.w20RegistryMetaKey_(fixture.taskId)] = JSON.stringify(
    backend.w20RegistryTaskMetaRecord_(fixture.taskId, fixture.meta)
  );
  let propertyReads = 0;
  backend.PropertiesService = { getScriptProperties: () => ({
    getProperties() { propertyReads += 1; return { ...values }; }
  }) };
  backend.w20GetCachedDownloadMaterial_ = () => null;
  backend.w20FreshRegistryDownloadProof_ = realFreshRegistryDownloadProof;
  backend.w19AssertMaterialForTask_ = () => { fixture.calls.notion += 1; return { id: fixture.pageId }; };
  backend.w19MaterialFromPage_ = () => fixture.cached;
  backend.w20CacheDownloadMaterials_ = () => 1;

  const result = backend.apiPrepareDownload({ taskPageId: fixture.taskId, pageId: fixture.pageId });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(propertyReads, 1);
  assert.equal(fixture.calls.driveGets, 0, 'a stale proof must not use the exact fast Drive GET');
  assert.equal(fixture.calls.notion, 1, 'cold stale proof must revalidate through the durable path');
  assert.equal(fixture.calls.fallback, 1);
});

test('prepare download stale or mismatched registry proof uses the full ownership fallback', () => {
  for (const scenario of ['stale proof', 'registry file mismatch', 'registry ownership mismatch']) {
    const backend = loadBackend();
    const fixture = installFastPrepareDownloadFixture(backend);
    if (scenario === 'stale proof') {
      const stale = new Date(Date.now() - 21 * 60_000).toISOString();
      fixture.meta.taskValidatedAt = stale;
      fixture.meta.snapshotValidatedAt = stale;
    } else if (scenario === 'registry file mismatch') {
      fixture.registry.materials[0].googleFileId = 'DifferentOwnedFile12345';
    } else {
      fixture.registry.materials[0].widgetOwnedBinary = false;
    }

    const result = backend.apiPrepareDownload({ taskPageId: fixture.taskId, pageId: fixture.pageId });
    assert.equal(result.ok, true, `${scenario}: ${JSON.stringify(result)}`);
    assert.equal(fixture.calls.driveGets, 0, `${scenario}: rejected proof must not use the fast file GET`);
    assert.equal(fixture.calls.fallback, 1, `${scenario}: the existing full guard remains mandatory`);
    assert.equal(fixture.calls.notion, 0, `${scenario}: the cache hit still avoids Notion`);
  }
});

test('prepare download fast path fails closed on invalid live file id, marker or parent proof', () => {
  for (const scenario of ['file id', 'marker', 'parent']) {
    const backend = loadBackend();
    const fixture = installFastPrepareDownloadFixture(backend, { rejectFallback: true });
    if (scenario === 'file id') fixture.drive.id = 'DifferentOwnedFile12345';
    if (scenario === 'marker') fixture.drive.appProperties.widgetVersion = 'untrusted';
    if (scenario === 'parent') fixture.drive.parents = [fixture.folderId, 'UnexpectedParent12345'];

    const result = backend.apiPrepareDownload({ taskPageId: fixture.taskId, pageId: fixture.pageId });
    assert.equal(result.ok, false, `${scenario}: ${JSON.stringify(result)}`);
    assert.equal(result.error.code, 'DOWNLOAD_NOT_OWNED');
    assert.equal(fixture.calls.driveGets, 1, `${scenario}: exact live metadata must be checked once`);
    assert.equal(fixture.calls.fallback, 1, `${scenario}: invalid fast metadata must fall back and reject`);
    assert.equal(fixture.calls.notion, 0);
  }
});

test('prepare download revalidates server ownership before issuing an account-bound Drive grant', () => {
  const backend = loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e',pageId='3c72d627-39a1-81e1-971f-c6b30665ce55';
  const dataSourceId='3822d627-39a1-8018-a2dc-000b95bf5722';
  const cache=new Map();
  backend.CacheService={getScriptCache:()=>({put:(key,value)=>cache.set(key,value),get:(key)=>cache.get(key)||null,remove:(key)=>cache.delete(key)})};
  backend.UrlFetchApp={fetch:()=>{throw new Error('CDN fetch is forbidden on the fast Drive path');}};
  const cfg={authorizedTaskPageId:taskId,dataSourceId,notionToken:'test-notion-hmac-secret',allowedEmail:'owner@example.com',deniedPageIds:{}};
  backend.w19AuthorizedConfig_=()=>cfg;
  backend.w19AssertMaterialForTask_=(receivedPage,receivedTask)=>({id:receivedPage,taskId:receivedTask});
  backend.w19MaterialFromPage_=()=>({
    id:pageId,name:'report.xlsx',downloadName:'report.xlsx',attachmentName:'report.xlsx',
    widgetOwnedBinary:true,mimeType:'application/octet-stream',size:123
  });
  backend.w20CacheDownloadMaterials_=()=>1;
  let guardCalls=0;
  backend.w19AssertOwnedBinary_=()=>{guardCalls+=1;return {id:'DRIVEFILE123',name:'report.xlsx',mimeType:'application/octet-stream',size:'123'};};
  const expectedDriveUrl='https://drive.google.com/uc?export=download&authuser=owner%40example.com&id=DRIVEFILE123';
  assert.equal(backend.w20DriveDownloadUrl_('DRIVEFILE123',cfg.allowedEmail),expectedDriveUrl);
  assert.equal(backend.w20TrustedDirectDownloadUrl_(expectedDriveUrl),expectedDriveUrl);
  const probeDirect={mode:'direct',url:expectedDriveUrl,name:'report.xlsx',mimeType:'application/octet-stream',size:123,expiresAt:new Date(Date.now()+180_000).toISOString()};
  assert.ok(backend.w20DownloadGrantDirect_(probeDirect));
  const probeIssue=backend.w20IssueDownloadGrant_(taskId,pageId,probeDirect,cfg,0);
  assert.equal(probeIssue.mode,'grant',JSON.stringify(probeIssue));
  const result=backend.apiPrepareDownload({taskPageId:taskId,pageId});
  assert.equal(result.ok,true);
  assert.equal(result.data.mode,'grant',JSON.stringify(result.data));
  assert.match(result.data.downloadGrant,/^[a-f0-9]{96}$/);
  assert.equal(result.data.downloadPackage,undefined,'a permanent Drive URL must stay behind the HMAC grant exchange');
  assert.equal(result.data.packageExpiresAt,undefined);
  assert.equal(backend.w20FastDownloadPackage_(probeDirect,Date.now()),null);
  assert.equal(result.data.url,undefined,'the generic direct result shape is reserved for grant redemption');
  assert.equal(result.data.directDownloadUrl,expectedDriveUrl,'the authenticated priming call may return only the already ownership-checked Drive URL');
  assert.ok(Date.parse(result.data.directDownloadExpiresAt)-Date.now()>10*60_000,'the account-bound direct URL remains hot well beyond the short HMAC grant');
  assert.ok(Date.parse(result.data.directDownloadExpiresAt)-Date.now()<=15*60_000);
  assert.ok(Date.parse(result.data.directDownloadExpiresAt)>Date.parse(result.data.expiresAt));
  assert.equal(backend.w20GetDownloadGrant_(taskId,pageId,result.data.downloadGrant,cfg).url,expectedDriveUrl);
  assert.equal(guardCalls,1);
  cfg.allowedEmail='invalid-account';
  const rejected=backend.apiPrepareDownload({taskPageId:taskId,pageId});
  assert.equal(rejected.ok,true);
  assert.equal(rejected.data.mode,'proxy');
  assert.equal(rejected.data.proxyReason,'metadata');
  assert.equal(guardCalls,2);
});

test('prepare download uses the current Drive filename and never probes the Notion CDN', () => {
  const backend = loadBackend();
  const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e',pageId='3c72d627-39a1-81e1-971f-c6b30665ce55';
  const dataSourceId='3822d627-39a1-8018-a2dc-000b95bf5722';
  const cache=new Map();
  backend.CacheService={getScriptCache:()=>({put:(key,value)=>cache.set(key,value),get:(key)=>cache.get(key)||null,remove:(key)=>cache.delete(key)})};
  backend.UrlFetchApp={fetch:()=>{throw new Error('unexpected CDN request');}};
  const cfg={authorizedTaskPageId:taskId,dataSourceId,notionToken:'test-notion-hmac-secret',allowedEmail:'owner+widget@example.com',deniedPageIds:{}};
  backend.w19AuthorizedConfig_=()=>cfg;
  backend.w19AssertMaterialForTask_=()=>({id:pageId});
  backend.w19MaterialFromPage_=()=>({
    id:pageId,name:'Новое имя.xlsx',downloadName:'Новое имя.xlsx',attachmentName:'Старое имя.xlsx',
    widgetOwnedBinary:true,mimeType:'application/octet-stream',size:123
  });
  backend.w20CacheDownloadMaterials_=()=>1;
  backend.w19AssertOwnedBinary_=()=>({id:'DRIVEFILE123',name:'Новое имя.xlsx',mimeType:'application/octet-stream',size:'123'});
  const result=backend.apiPrepareDownload({taskPageId:taskId,pageId});
  assert.equal(result.ok,true);
  assert.equal(result.data.mode,'grant',JSON.stringify(result.data));
  const direct=backend.w20GetDownloadGrant_(taskId,pageId,result.data.downloadGrant,cfg);
  assert.equal(direct.name,'Новое имя.xlsx');
  assert.equal(direct.url,'https://drive.google.com/uc?export=download&authuser=owner%2Bwidget%40example.com&id=DRIVEFILE123');
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
  assert.match(issued.downloadPackage,/^[A-Za-z0-9_-]{40,9000}$/);
  const fastPackage=JSON.parse(Buffer.from(issued.downloadPackage,'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(fastPackage).sort(),['expiresAt','name','url']);
  assert.equal(fastPackage.url,direct.url);
  assert.equal(fastPackage.name,direct.name);
  assert.equal(fastPackage.expiresAt,issued.packageExpiresAt);
  assert.equal(Date.parse(fastPackage.expiresAt)-now,60_000);
  assert.equal(writes[0].ttl,60);
  assert.equal(Date.parse(issued.expiresAt)-now,60_000);
  const overlapping=backend.w20IssueDownloadGrant_(taskId,pageId,direct,cfg);
  assert.equal(overlapping.downloadGrant,issued.downloadGrant,'overlapping prime must reuse the still-valid grant');
  assert.equal(writes.length,1,'overlapping prime must not overwrite the cache entry');
  assert.equal(backend.w20GetDownloadGrant_(taskId,pageId,issued.downloadGrant,cfg).url,direct.url);
  const expiringDirect={...direct,expiresAt:new RealDate(now+90_000).toISOString()};
  const expiring=backend.w20IssueDownloadGrant_(taskId,otherPage,expiringDirect,cfg);
  assert.equal(expiring.mode,'proxy','package must leave a safety margin before the real signed URL expiry');
  assert.equal(expiring.downloadPackage,undefined);
  assert.equal(backend.w20GetDownloadGrant_(otherTask,pageId,issued.downloadGrant,{...cfg,authorizedTaskPageId:otherTask}),null);
  assert.equal(backend.w20GetDownloadGrant_(taskId,otherPage,issued.downloadGrant,cfg),null);
  assert.equal(backend.w20GetDownloadGrant_(taskId,pageId,issued.downloadGrant,{...cfg,deniedPageIds:{[taskId]:true}}),null);
  assert.equal(backend.w20GetDownloadGrant_(taskId,pageId,`f${issued.downloadGrant.slice(1)}`,cfg),null);
  assert.ok(backend.w20GetDownloadGrant_(taskId,pageId,issued.downloadGrant,cfg),'a bad token must not revoke the real grant');

  backend.w20InvalidateDownloadMaterialCache_(taskId,pageId);
  assert.equal(backend.w20GetDownloadGrant_(taskId,pageId,issued.downloadGrant,cfg),null);
  const stale=backend.w20IssueDownloadGrant_(taskId,pageId,direct,cfg,0);
  assert.equal(stale.mode,'proxy','an epoch race must fail closed before a fast package is formed');
  assert.equal(stale.downloadPackage,undefined);
  const replacement=backend.w20IssueDownloadGrant_(taskId,pageId,direct,cfg);
  assert.notEqual(replacement.downloadGrant,issued.downloadGrant,'revocation epoch must bind replacement grants');
  now+=60_001;
  assert.equal(backend.w20GetDownloadGrant_(taskId,pageId,replacement.downloadGrant,cfg),null);
});

test('download POST redeems a supplied warm grant without preparing or touching Notion and Drive', () => {
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
  let prepareCalls=0;
  backend.apiPrepareDownload=()=>{prepareCalls+=1;throw new Error('a warm grant must not be prepared again');};
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
  assert.equal(prepareCalls,0);

  backend.doPost({...event,parameters:{...event.parameters,extra:['forbidden']}});
  backend.doPost({...event,parameters:{...event.parameters,task:[taskId,taskId]}});
  assert.equal(authCalls,1,'extra and duplicate POST fields must fail before authorization');
  assert.equal(prepareCalls,0);
  assert.equal(JSON.parse(rendered[1].result),null);
  assert.equal(JSON.parse(rendered[2].result),null);
});

test('cold download POST prepares and re-redeems one ownership-checked grant before rendering direct', () => {
  const backend=loadBackend();
  const realIssueDownloadGrant=backend.w20IssueDownloadGrant_;
  const fixture=installFastPrepareDownloadFixture(backend);
  fixture.cfg.notionToken='test-notion-hmac-secret';
  const accessToken='B'.repeat(48),originalTicket='c'.repeat(64),values=new Map();
  backend.CacheService={getScriptCache:()=>({
    put:(key,value)=>values.set(key,String(value)),get:(key)=>values.get(key)||null,
    remove:(key)=>values.delete(key),removeAll:(keys)=>keys.forEach((key)=>values.delete(key))
  })};
  backend.w20IssueDownloadGrant_=realIssueDownloadGrant;
  let prepareCalls=0;
  const realPrepare=backend.apiPrepareDownload;
  backend.apiPrepareDownload=(input)=>{
    prepareCalls+=1;
    assert.deepEqual(JSON.parse(JSON.stringify(input)),{taskPageId:fixture.taskId,pageId:fixture.pageId,accessToken});
    return realPrepare(input);
  };
  const redemptionTickets=[];
  const realGet=backend.w20GetDownloadGrant_;
  backend.w20GetDownloadGrant_=(taskId,pageId,ticket,cfg)=>{
    redemptionTickets.push(String(ticket));
    return realGet(taskId,pageId,ticket,cfg);
  };
  const rendered=[];
  const output={setTitle(){return this;},setXFrameOptionsMode(){return this;},addMetaTag(){return this;}};
  backend.HtmlService={XFrameOptionsMode:{ALLOWALL:'ALLOWALL'},createTemplateFromFile(name){assert.equal(name,'Download');const template={evaluate(){rendered.push({runtime:template.runtimeParamsJson,result:template.precomputedResultJson});return output;}};return template;}};
  const event={parameters:{task:[fixture.taskId],accessToken:[accessToken],downloadPageId:[fixture.pageId],downloadTicket:[originalTicket]},postData:{type:'application/x-www-form-urlencoded'}};

  assert.equal(backend.doPost(event),output);
  assert.equal(prepareCalls,1);
  assert.equal(fixture.calls.driveGets,1,'cold preparation performs one exact live Drive ownership GET');
  assert.equal(fixture.calls.notion,0,'a fresh exact registry proof avoids Notion on the cold POST path');
  assert.equal(fixture.calls.root,0);
  assert.equal(fixture.calls.fallback,0);
  assert.equal(redemptionTickets.length,2,'the submitted ticket miss is followed by one fresh grant redemption');
  assert.equal(redemptionTickets[0],originalTicket);
  assert.match(redemptionTickets[1],/^[a-f0-9]{96}$/);
  assert.equal(rendered[0].runtime,'{}','success never renders the access capability into the page');
  const precomputed=JSON.parse(rendered[0].result);
  assert.deepEqual(Object.keys(precomputed).sort(),['downloadTicket','expiresAt','mimeType','mode','name','size','url']);
  assert.equal(precomputed.mode,'direct');
  assert.equal(precomputed.downloadTicket,originalTicket,'the public courier correlation ticket is not replaced by the private grant');
  assert.equal(precomputed.url,backend.w20DriveDownloadUrl_(fixture.fileId,fixture.cfg.allowedEmail));
  assert.equal(precomputed.name,fixture.drive.name);
  assert.equal(precomputed.mimeType,fixture.drive.mimeType);
  assert.equal(precomputed.size,Number(fixture.drive.size));
  assert.doesNotMatch(rendered[0].result,new RegExp(accessToken));
  assert.doesNotMatch(rendered[0].result,new RegExp(redemptionTickets[1]));
});

test('cold download POST trusts neither prepare metadata nor an unredeemable fresh grant', () => {
  const scenarios=[
    {name:'API error',response:{ok:false,error:{code:'DOWNLOAD_NOT_OWNED'}}},
    {name:'proxy',response:{ok:true,data:{mode:'proxy'}}},
    {name:'malformed grant',response:{ok:true,data:{mode:'grant',downloadGrant:'d'.repeat(95),directDownloadUrl:'https://drive.google.com/uc?export=download&authuser=owner%40example.com&id=AttackerChosenFile123'}}},
    {name:'uppercase grant',response:{ok:true,data:{mode:'grant',downloadGrant:'E'.repeat(96)}}},
    {name:'epoch race',response:{ok:true,data:{mode:'grant',downloadGrant:'f'.repeat(96),directDownloadUrl:'https://drive.google.com/uc?export=download&authuser=owner%40example.com&id=AttackerChosenFile123'}}},
    {name:'throw',throws:true}
  ];
  scenarios.forEach((scenario)=>{
    const backend=loadBackend();
    const taskId='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e',pageId='3c72d627-39a1-81e1-971f-c6b30665ce55';
    const accessToken='G'.repeat(48),ticket='h'.repeat(64);
    const cfg={authorizedTaskPageId:taskId,dataSourceId:'3822d627-39a1-8018-a2dc-000b95bf5722',notionToken:'test-notion-hmac-secret',deniedPageIds:{}};
    backend.w19AuthorizedConfig_=()=>cfg;
    let prepareCalls=0,redemptionCalls=0;
    backend.apiPrepareDownload=()=>{prepareCalls+=1;if(scenario.throws)throw new Error('prepare unavailable');return scenario.response;};
    backend.w20GetDownloadGrant_=(_task,_page,supplied)=>{
      if(String(supplied)===ticket)return null;
      redemptionCalls+=1;
      return null;
    };
    const rendered=[];
    const output={setTitle(){return this;},setXFrameOptionsMode(){return this;},addMetaTag(){return this;}};
    backend.HtmlService={XFrameOptionsMode:{ALLOWALL:'ALLOWALL'},createTemplateFromFile(){const template={evaluate(){rendered.push({runtime:template.runtimeParamsJson,result:template.precomputedResultJson});return output;}};return template;}};
    const event={parameters:{task:[taskId],accessToken:[accessToken],downloadPageId:[pageId],downloadTicket:[ticket]},postData:{type:'application/x-www-form-urlencoded'}};

    backend.doPost(event);
    assert.equal(prepareCalls,1,scenario.name);
    assert.equal(JSON.parse(rendered[0].result),null,scenario.name);
    assert.deepEqual(JSON.parse(rendered[0].runtime),{task:taskId,accessToken,downloadPageId:pageId,downloadTicket:ticket},scenario.name);
    assert.equal(redemptionCalls,scenario.name==='epoch race'?1:0,scenario.name);
  });
});

test('deployment contract supports a capability-authenticated iframe with full Drive metadata access', () => {
  assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/drive'));
  assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/script.scriptapp'));
  assert.ok(!manifest.oauthScopes.includes('https://www.googleapis.com/auth/drive.file'));
  assert.deepEqual(manifest.webapp, { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_DEPLOYING' });
  assert.deepEqual(manifest.executionApi, { access: 'MYSELF' }, 'Apps Script execution stays owner-only');
  assert.match(backendSource, /AUTHORIZED_TASK_PAGE_ID/);
  assert.match(backendSource, /WIDGET_ACCESS_TOKEN_SHA256/);
  assert.match(backendSource, /Session\.getActiveUser\(\).*Административный запуск/s);
});

test('Drive idempotency marker is linked back to the resulting Notion page', () => {
  assert.match(backendSource, /appProperties:\s*\{[\s\S]*widgetIdem:[\s\S]*notionPageId:/);
  assert.match(backendSource, /w19MarkDriveNotionPage_\(driveFile, task\.id, idemHash, page\.id, 'active'\)/);
});
