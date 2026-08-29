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
const mutationRunner = fs.readFileSync(path.join(root, 'Mutation.html'), 'utf8');
const publicCourier = fs.readFileSync(path.join(root, '..', 'download-courier.html'), 'utf8');
const publicCreateCourier = fs.readFileSync(path.join(root, '..', 'create-courier.html'), 'utf8');
const original = fs.readFileSync(path.join(root, '..', 'google-buttons-widget.html'), 'utf8');

test('v20 preserves the original four-column desktop system and uses a readable two-column mobile layout', () => {
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
  assert.match(frontend, /@media \(max-width: 720px\)[\s\S]*\.grid \{ grid-template-columns: repeat\(2,minmax\(0,1fr\)\); \}/);
  assert.match(frontend, /\.material-menu-trigger \{[\s\S]*flex: 0 0 44px; width: 44px; min-height: 44px/);
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
  assert.match(frontend, /card=document\.createElement\('article'\)/);
  assert.match(frontend, /main=document\.createElement\(href\?'a':'button'\)/);
  assert.match(frontend, /main\.innerHTML=materialCardMarkup\(section,count\)/);
  assert.match(frontend, /card\.append\(main,menuButton\)/);
  assert.doesNotMatch(frontend, /main\.append\([^)]*menuButton|main\.innerHTML[\s\S]{0,200}material-menu-trigger/);
  assert.match(frontend, /materials\.forEach\(\(item\)=>files\.appendChild\(materialCard\(item,materials\.length\)\)\)/);
  assert.match(frontend, /add\.textContent='\+ \u0434\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u0434\u043e\u043a\u0443\u043c\u0435\u043d\u0442'/);
});

test('saved-card chevrons own edit/open/hide actions and no saved-card pencil remains', () => {
  const cardMarkup = frontend.slice(frontend.indexOf('function materialCardMarkup'), frontend.indexOf('function escapeHtml'));
  const materialCard = frontend.slice(frontend.indexOf('function materialCard(item,count)'), frontend.indexOf('function downloadMaterialFingerprint'));
  const optimistic = frontend.slice(frontend.indexOf('function beginOptimisticMaterialMutation'), frontend.indexOf('async function saveEdit'));
  const archive = frontend.slice(frontend.indexOf('async function archiveMaterial'), frontend.indexOf('function upsert'));
  assert.match(cardMarkup, /function materialMenuTrigger\(item\)/);
  assert.match(cardMarkup, /button\.dataset\.materialMenuId=/);
  assert.match(cardMarkup, /button\.setAttribute\('aria-haspopup','menu'\)/);
  assert.doesNotMatch(cardMarkup, /data-edit-id|class="gedit"|editIcon/);
  assert.doesNotMatch(materialCard, /data-edit-id|editButton|class="gedit"/);
  assert.match(frontend, /data-material-menu-action="edit"[^>]*>\u0418\u0437\u043c\u0435\u043d\u0438\u0442\u044c \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u0435 \u0438 \u0440\u0430\u0437\u0434\u0435\u043b/);
  assert.match(frontend, /data-material-menu-action="archive"[^>]*>\u0421\u043a\u0440\u044b\u0442\u044c \u0438\u0437 \u0432\u0438\u0434\u0436\u0435\u0442\u0430/);
  assert.match(frontend, /if\(action==='edit'\)openEdit\(item\.id,returnFocus\);else if\(action==='archive'\)archiveMaterial\(item,focusReturnDescriptor\(returnFocus\)\)/);
  assert.match(archive, /call\('apiArchive',\{taskPageId,pageId:item\.id,idempotencyKey:operation\.value\}\)/);
  assert.match(optimistic, /function beginOptimisticMaterialMutation\(item,kind,patch\) \{\s*if\(materialMutationBlockedByOrderSave\(\)\)return null/);
  assert.match(optimistic, /if\(kind==='hide'\)state\.materials=state\.materials\.filter\(\(material\)=>material\.id!==item\.id\)/);
  assert.doesNotMatch(archive, /window\.confirm|\bconfirm\(/);
  assert.doesNotMatch(archive, /apiDeletePhysical/);
});

test('rename is optimistic before the RPC, waits for reorder, and reconciles or rolls back safely', async () => {
  const source = frontend.slice(frontend.indexOf('function materialMutationBusyKey'), frontend.indexOf('function captureOrder'));
  function harness(orderSaveRunning=false,queuedOrder=null) {
    const createRequestId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const item={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',name:'Старое имя',section:'Docs',provider:'Google Drive',openUrl:'https://docs.google.com/document/d/ExampleDocument123/edit',createRequestId};
    const state={materials:[item],busy:new Set(),bootstrapped:true,authoritative:true,snapshotTrusted:false,actionReady:true},optimisticMaterialMutations=new Map(),downloadGrants=new Map([[item.id,{}]]),downloadGrantRetryNotBefore=new Map([[item.id,1]]);
    const recentCompletedCreates=new Map([[createRequestId,item]]);
    const modalState={open:false};
    const fields={editModal:{classList:{contains:(name)=>name==='open'&&modalState.open}},editId:{value:item.id},editName:{value:'Новое имя',focus(){}},editSection:{value:'Slides'},editUrl:{value:item.openUrl},editSubmit:{disabled:false}};
    const events={closed:[],renders:0,restored:[],toasts:[],cleared:0,primed:[],opened:[],rpc:null};
    let resolveRpc,rejectRpc;
    const call=(method,payload)=>{events.rpc={method,payload};return new Promise((resolve,reject)=>{resolveRpc=resolve;rejectRpc=reject;});};
    const handlers=new Function('state','optimisticMaterialMutations','recentCompletedCreates','$','stableIdempotency','modalReturnFocus','downloadGrants','downloadGrantRetryNotBefore','closeModal','render','restoreFocusTarget','toast','call','clearIdempotency','primeDownloadGrant','downloadPrimeGeneration','openEdit','taskPageId','SECTIONS','sectionFor','orderSaveRunning','queuedOrder','resumeDeferredDownloadPrime','cachedMutationReady',`${source};return {saveEdit,archiveMaterial};`)(
      state,optimisticMaterialMutations,recentCompletedCreates,(id)=>fields[id],()=>({slot:'slot',value:'idem-key'}),new Map([['editModal',{materialMenuId:item.id}]]),downloadGrants,downloadGrantRetryNotBefore,
      (...args)=>events.closed.push(args),()=>{events.renders+=1;},(value)=>events.restored.push(value),(message)=>events.toasts.push(message),call,()=>{events.cleared+=1;},(id)=>events.primed.push(id),3,
      (id,returnFocus)=>events.opened.push({id,returnFocus}),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',['Drive','Docs','Sheets','Slides'],(value)=>value.section,orderSaveRunning,queuedOrder,()=>{},
      ()=>Boolean(state.bootstrapped&&state.actionReady&&(state.authoritative||state.snapshotTrusted))
    );
    return {item,state,fields,events,handlers,optimisticMaterialMutations,recentCompletedCreates,modalState,resolveRpc,rejectRpc,getResolve:()=>resolveRpc,getReject:()=>rejectRpc};
  }

  const success=harness();
  const saving=success.handlers.saveEdit({preventDefault(){}});
  assert.equal(success.state.materials[0].name,'Новое имя');
  assert.equal(success.state.materials[0].section,'Slides');
  assert.deepEqual(success.events.closed,[['editModal',false]]);
  assert.equal(success.events.renders,1,'optimistic render must happen before the RPC settles');
  assert.equal(success.events.rpc.method,'apiUpdateMaterial');
  assert.equal(success.optimisticMaterialMutations.has(success.item.id),true);
  assert.equal(success.state.busy.has(`material:${success.item.id}`),true);
  const confirmedRename={...success.item,name:'Серверное имя',section:'Slides'};
  success.getResolve()({material:confirmedRename});
  await saving;
  assert.equal(success.state.materials[0].name,'Серверное имя');
  assert.equal(success.optimisticMaterialMutations.size,0);
  assert.equal(success.state.busy.size,0);
  assert.equal(success.events.cleared,1);
  assert.deepEqual(success.events.primed,[success.item.id]);
  assert.deepEqual(success.recentCompletedCreates.get(success.item.createRequestId),confirmedRename,'an eventual bootstrap must retain the confirmed rename, not the pre-create name');

  const failure=harness();
  const failed=failure.handlers.saveEdit({preventDefault(){}});
  assert.equal(failure.state.materials[0].name,'Новое имя');
  failure.getReject()(new Error('Сервер недоступен'));
  await failed;
  assert.equal(failure.state.materials[0].name,'Старое имя');
  assert.equal(failure.state.materials[0].section,'Docs');
  assert.equal(failure.optimisticMaterialMutations.size,0);
  assert.equal(failure.state.busy.size,0);
  assert.equal(failure.events.opened.length,1,'the edit modal is reopened for a retry');
  assert.equal(failure.fields.editName.value,'Новое имя');
  assert.equal(failure.fields.editSection.value,'Slides');
  assert.match(failure.events.toasts.at(-1),/Сервер недоступен.*Изменения отменены/);
  assert.equal(failure.events.cleared,0,'failed retry keeps the stable idempotency key');
  assert.equal(failure.recentCompletedCreates.get(failure.item.createRequestId),failure.item,'a failed rename keeps the original recent-create buffer');

  const protectedForm=harness(),otherId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const protectedSave=protectedForm.handlers.saveEdit({preventDefault(){}});
  protectedForm.modalState.open=true;
  protectedForm.fields.editId.value=otherId;
  protectedForm.fields.editName.value='Другая открытая форма';
  protectedForm.fields.editSection.value='Sheets';
  protectedForm.getReject()(new Error('Поздняя ошибка'));await protectedSave;
  assert.equal(protectedForm.state.materials[0].name,'Старое имя','the failed optimistic card still rolls back');
  assert.equal(protectedForm.events.opened.length,0,'a late failure must not replace another card already being edited');
  assert.equal(protectedForm.fields.editId.value,otherId);
  assert.equal(protectedForm.fields.editName.value,'Другая открытая форма');
  assert.equal(protectedForm.fields.editSection.value,'Sheets');

  const blocked=harness(true,null);
  await blocked.handlers.saveEdit({preventDefault(){}});
  assert.equal(blocked.events.rpc,null,'rename must not start while apiReorder is in flight');
  assert.equal(blocked.optimisticMaterialMutations.size,0);
  assert.equal(blocked.state.materials[0].name,'Старое имя');
  assert.equal(blocked.fields.editSubmit.disabled,false);
  assert.equal(blocked.events.toasts.at(-1),'Завершаю сохранение порядка…');

  const stale=harness();stale.state.authoritative=false;
  await stale.handlers.saveEdit({preventDefault(){}});
  assert.equal(stale.events.rpc,null,'a form opened before authority expires cannot submit a stale rename');
  assert.equal(stale.state.materials[0].name,'Старое имя');
  assert.equal(stale.events.toasts.at(-1),'Завершаю синхронизацию…');

  const cached=harness();cached.state.authoritative=false;cached.state.snapshotTrusted=true;
  const cachedSave=cached.handlers.saveEdit({preventDefault(){}});
  assert.equal(cached.events.rpc.method,'apiUpdateMaterial','a fresh signed snapshot proof may use the backend-validated rename path immediately');
  cached.getResolve()({material:{...cached.item,name:'Серверное имя',section:'Slides'}});await cachedSave;
});

test('hide removes immediately, waits for queued reorder, and restores its exact position on failure', async () => {
  const source = frontend.slice(frontend.indexOf('function materialMutationBusyKey'), frontend.indexOf('function captureOrder'));
  function harness(orderSaveRunning=false,queuedOrder=null) {
    const createRequestId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const before={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',name:'До'},item={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',name:'Скрыть',section:'Docs',createRequestId},after={id:'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',name:'После'};
    const state={materials:[before,item,after],busy:new Set(),bootstrapped:true,authoritative:true,snapshotTrusted:false,actionReady:true},optimisticMaterialMutations=new Map(),events={closed:0,renders:0,toasts:[],cleared:0,restored:[],primed:[],rpc:null};
    const recentCompletedCreates=new Map([[createRequestId,item]]);
    let resolveRpc,rejectRpc;
    const fields={editId:{value:item.id},editName:{value:item.name,focus(){}},editSection:{value:'Docs'},editUrl:{value:''},editSubmit:{disabled:false}};
    const handlers=new Function('state','optimisticMaterialMutations','recentCompletedCreates','$','stableIdempotency','modalReturnFocus','downloadGrants','downloadGrantRetryNotBefore','closeModal','render','restoreFocusTarget','toast','call','clearIdempotency','primeDownloadGrant','downloadPrimeGeneration','openEdit','taskPageId','SECTIONS','sectionFor','orderSaveRunning','queuedOrder','resumeDeferredDownloadPrime','cachedMutationReady',`${source};return {archiveMaterial};`)(
      state,optimisticMaterialMutations,recentCompletedCreates,(id)=>fields[id],()=>({slot:'slot',value:'idem-key'}),new Map(),new Map(),new Map(),()=>{events.closed+=1;},()=>{events.renders+=1;},(value)=>events.restored.push(value),(message)=>events.toasts.push(message),
      (method,payload)=>{events.rpc={method,payload};return new Promise((resolve,reject)=>{resolveRpc=resolve;rejectRpc=reject;});},()=>{events.cleared+=1;},(id)=>events.primed.push(id),4,()=>{},
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',['Drive','Docs','Sheets','Slides'],(value)=>value.section,orderSaveRunning,queuedOrder,()=>{},
      ()=>Boolean(state.bootstrapped&&state.actionReady&&(state.authoritative||state.snapshotTrusted))
    );
    return {before,item,after,state,events,handlers,optimisticMaterialMutations,recentCompletedCreates,getResolve:()=>resolveRpc,getReject:()=>rejectRpc};
  }

  const success=harness(),focus={materialMenuId:success.item.id};
  const hiding=success.handlers.archiveMaterial(success.item,focus);
  assert.deepEqual(success.state.materials.map((item)=>item.id),[success.before.id,success.after.id]);
  assert.equal(success.events.renders,1,'hide renders before apiArchive resolves');
  assert.equal(success.events.rpc.method,'apiArchive');
  assert.equal(success.optimisticMaterialMutations.has(success.item.id),true);
  success.getResolve()({archived:true});await hiding;
  assert.deepEqual(success.state.materials.map((item)=>item.id),[success.before.id,success.after.id]);
  assert.equal(success.optimisticMaterialMutations.size,0);
  assert.equal(success.events.cleared,1);
  assert.equal(success.recentCompletedCreates.has(success.item.createRequestId),false,'an eventual bootstrap cannot revive a successfully hidden recent create');

  const failure=harness(),failureFocus={materialMenuId:failure.item.id};
  const failed=failure.handlers.archiveMaterial(failure.item,failureFocus);
  assert.deepEqual(failure.state.materials.map((item)=>item.id),[failure.before.id,failure.after.id]);
  failure.getReject()(new Error('Архив недоступен'));await failed;
  assert.deepEqual(failure.state.materials.map((item)=>item.id),[failure.before.id,failure.item.id,failure.after.id]);
  assert.equal(failure.optimisticMaterialMutations.size,0);
  assert.deepEqual(failure.events.restored,[failureFocus]);
  assert.deepEqual(failure.events.primed,[failure.item.id]);
  assert.match(failure.events.toasts.at(-1),/Архив недоступен.*Карточка возвращена/);
  assert.equal(failure.events.cleared,0);
  assert.equal(failure.recentCompletedCreates.get(failure.item.createRequestId),failure.item,'a failed hide keeps the recent-create buffer for rollback consistency');
  assert.doesNotMatch(source,/window\.confirm|\bconfirm\(/);
  assert.doesNotMatch(source,/apiDeletePhysical/);

  const stale=harness();stale.state.authoritative=false;
  await stale.handlers.archiveMaterial(stale.item,{materialMenuId:stale.item.id});
  assert.equal(stale.events.rpc,null,'a menu opened before authority expires cannot submit a stale hide');
  assert.deepEqual(stale.state.materials.map((item)=>item.id),[stale.before.id,stale.item.id,stale.after.id]);
  assert.equal(stale.events.toasts.at(-1),'Завершаю синхронизацию…');

  const blocked=harness(false,[{pageId:failure.item.id}]);
  await blocked.handlers.archiveMaterial(blocked.item,{materialMenuId:blocked.item.id});
  assert.equal(blocked.events.rpc,null,'hide must not start while a newer reorder snapshot is queued');
  assert.deepEqual(blocked.state.materials.map((item)=>item.id),[blocked.before.id,blocked.item.id,blocked.after.id]);
  assert.equal(blocked.optimisticMaterialMutations.size,0);
  assert.equal(blocked.events.toasts.at(-1),'Завершаю сохранение порядка…');
});

test('background snapshots and Drive polling cannot overwrite an optimistic rename or revive an optimistic hide', () => {
  const bootstrap=frontend.slice(frontend.indexOf('function applyBootstrapData'),frontend.indexOf('function readInitialBootstrap'));
  const drive=frontend.slice(frontend.indexOf('function applyDriveMetadata'),frontend.indexOf('function drivePollResultPageIds'));
  assert.match(bootstrap,/optimisticMaterialMutations\.forEach\(\(record,itemId\)=>/);
  assert.match(bootstrap,/if\(index>=0\)\{record\.original=Object\.assign\(\{\},serverMaterials\[index\]\);record\.index=index;\}/);
  assert.match(bootstrap,/record\.kind==='hide'[\s\S]*serverMaterials\.splice\(index,1\)/);
  assert.match(bootstrap,/record\.optimistic=Object\.assign\(\{\},record\.original,record\.patch\);serverMaterials\[index\]=record\.optimistic/);
  assert.match(drive,/if\(optimisticMaterialMutations\.has\(pageId\)\)return/);
});

test('upsert keeps active optimistic overlays while refreshing the rollback baseline', () => {
  const source=frontend.slice(frontend.indexOf('function materialMutationBusyKey'),frontend.indexOf('function captureOrder'));
  const original={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',name:'Исходное имя',section:'Docs',updatedAt:'old'};
  const state={materials:[original],busy:new Set()},optimisticMaterialMutations=new Map();
  const handlers=new Function('state','optimisticMaterialMutations','orderSaveRunning','queuedOrder','toast','resumeDeferredDownloadPrime',`${source};return {beginOptimisticMaterialMutation,finishOptimisticMaterialMutation,rollbackOptimisticMaterialMutation,upsert};`)(state,optimisticMaterialMutations,false,null,()=>{},()=>{});

  const edit=handlers.beginOptimisticMaterialMutation(original,'edit',{name:'Локальное имя',section:'Slides'});
  const fresh={...original,name:'Серверное имя',updatedAt:'fresh',openUrl:'https://docs.google.com/document/d/Fresh/edit'};
  handlers.upsert(fresh);
  assert.equal(state.materials[0].name,'Локальное имя');
  assert.equal(state.materials[0].section,'Slides');
  assert.equal(state.materials[0].updatedAt,'fresh');
  assert.equal(state.materials[0].openUrl,fresh.openUrl);
  assert.deepEqual(edit.original,fresh,'fresh server data becomes the rollback baseline');
  handlers.finishOptimisticMaterialMutation(edit);handlers.rollbackOptimisticMaterialMutation(edit);
  assert.deepEqual(state.materials[0],fresh,'rollback restores the latest server item, not the stale pre-edit item');

  const before={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',name:'До'},hidden={id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',name:'Скрываемый',section:'Docs',updatedAt:'old'},after={id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',name:'После'};
  state.materials=[before,hidden,after];
  const hide=handlers.beginOptimisticMaterialMutation(hidden,'hide',{}),freshHidden={...hidden,name:'Свежее серверное имя',updatedAt:'fresh'};
  handlers.upsert(freshHidden);
  assert.deepEqual(state.materials.map((item)=>item.id),[before.id,after.id],'a server upsert cannot revive a card while hide is pending');
  assert.deepEqual(hide.original,freshHidden,'hide rollback also learns the latest server baseline');
  handlers.finishOptimisticMaterialMutation(hide);handlers.rollbackOptimisticMaterialMutation(hide);
  assert.deepEqual(state.materials,[before,freshHidden,after]);

  const blockedToasts=[],blockedMutations=new Map(),blockedHandlers=new Function('state','optimisticMaterialMutations','orderSaveRunning','queuedOrder','toast',`${source};return {beginOptimisticMaterialMutation};`)(state,blockedMutations,true,null,(message)=>blockedToasts.push(message));
  assert.equal(blockedHandlers.beginOptimisticMaterialMutation(freshHidden,'edit',{name:'Не применять'}),null);
  assert.equal(blockedMutations.size,0,'the low-level mutation helper also fails closed during reorder');
  assert.deepEqual(blockedToasts,['Завершаю сохранение порядка…']);
});

test('drag and reorder are disabled while any material mutation is optimistic', async () => {
  const card=frontend.slice(frontend.indexOf('function materialCard(item,count)'),frontend.indexOf('function downloadMaterialFingerprint'));
  const drag=frontend.slice(frontend.indexOf('function handleDragStart'),frontend.indexOf('function focusReturnDescriptor'));
  const persist=frontend.slice(frontend.indexOf('async function persistOrder'),frontend.indexOf('function handleGridClick'));
  assert.match(card,/card\.draggable=state\.authoritative&&!String\(item\.id\)\.startsWith\('pending:'\)&&optimisticMaterialMutations\.size===0/);
  assert.match(card,/main\.referrerPolicy='no-referrer';main\.draggable=false/);
  assert.match(drag,/function handleDragStart\(event\)\{if\(!state\.authoritative\|\|optimisticMaterialMutations\.size\)\{event\.preventDefault\(\);return;\}/);
  assert.match(drag,/function handleDropReorder\(event\)\{if\(!state\.authoritative\|\|optimisticMaterialMutations\.size\)\{event\.preventDefault\(\);handleDragEnd\(\);return;\}/);
  assert.match(persist,/async function persistOrder\(\)\{if\(!state\.authoritative\|\|optimisticMaterialMutations\.size\)\{queuedOrder=null;return;\}queuedOrder=captureOrder\(\)/);
  assert.match(persist,/while\(queuedOrder\)\{if\(!state\.authoritative\|\|optimisticMaterialMutations\.size\)\{queuedOrder=null;return;\}/);

  let prevented=0,targetInspected=0;
  const start=new Function('optimisticMaterialMutations','state',`${drag.slice(0,drag.indexOf('function handleDragEnd'))};return handleDragStart;`)(new Map([['pending',{}]]),{});
  start({preventDefault(){prevented+=1;},target:{closest(){targetInspected+=1;return null;}}});
  assert.equal(prevented,1);
  assert.equal(targetInspected,0,'blocked drag exits before it can select a card');

  let captures=0,renders=0;
  const saveOrder=new Function('state','optimisticMaterialMutations','queuedOrder','captureOrder','render','orderSaveRunning',`${persist};return persistOrder;`)({authoritative:true},new Map([['pending',{}]]),null,()=>{captures+=1;return [];},()=>{renders+=1;},false);
  await saveOrder();
  assert.equal(captures,0,'blocked reorder cannot serialize an optimistic hide as a deletion');
  assert.equal(renders,0);

  const cachedStart=new Function('optimisticMaterialMutations','state',`${drag.slice(0,drag.indexOf('function handleDragEnd'))};return handleDragStart;`)(new Map(),{authoritative:false});
  cachedStart({preventDefault(){prevented+=1;},target:{closest(){targetInspected+=1;return {draggable:true};}}});
  assert.equal(targetInspected,0,'a signed cached snapshot cannot start a native anchor drag');
  const cachedSave=new Function('state','optimisticMaterialMutations','queuedOrder','captureOrder','render','orderSaveRunning',`${persist};return persistOrder;`)({authoritative:false},new Map(),null,()=>{captures+=1;return [];},()=>{renders+=1;},false);
  await cachedSave();
  assert.equal(captures,0,'a signed cached snapshot cannot issue a stale reorder');
});

test('saved-card menu restores focus, supports menu keys and survives a card rerender', () => {
  const menu = frontend.slice(frontend.indexOf('function materialMenuTriggerForId'),frontend.indexOf('function isBoundedAncestor'));
  const render = frontend.slice(frontend.indexOf('function render()'),frontend.indexOf('function scheduleActionProofRefresh'));
  assert.match(menu,/openMaterialMenuTrigger/);
  assert.match(menu,/settings\.afterRender\)pendingMaterialMenuFocusId=id/);
  assert.match(menu,/restorePendingMaterialMenuFocus\(\)/);
  assert.match(render,/closeMaterialMenu\(\{restoreFocus:Boolean\(openMaterialMenuId\),afterRender:true\}\)/);
  assert.match(render,/restorePendingMaterialMenuFocus\(\)/);
  assert.match(menu,/event\.key==='Escape'\|\|event\.key==='Tab'/);
  assert.match(menu,/event\.key==='ArrowDown'/);
  assert.match(menu,/event\.key==='ArrowUp'/);
  assert.match(menu,/event\.key==='Home'/);
  assert.match(menu,/event\.key==='End'/);
  assert.match(frontend,/const modalReturnFocus = new Map\(\)/);
  assert.match(frontend,/function restoreFocusTarget\(descriptor\)/);
});

test('menu open revalidates every native navigation gesture and fails closed on a stale link', () => {
  const source=frontend.slice(frontend.indexOf('function refreshMaterialMenuOpenTarget'),frontend.indexOf('function handleMaterialMenuKeydown'));
  const item={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',provider:'Google Drive'};
  const state={authoritative:true,materials:[item]};
  let currentHref='',prevented=0,removed=0,primed=0,closed=0,lastToast='';
  const handlers=new Function('state','openMaterialMenuId','materialMenuHref','canPrepareDownload','closeMaterialMenu','primeDownloadGrant','downloadPrimeGeneration','toast','recentDrivePageIds','cachedMutationReady',`${source};return {open:handleMaterialMenuOpen,intent:handleMaterialMenuOpenIntent};`)(
    state,item.id,()=>currentHref,()=>true,()=>{closed+=1;},()=>{primed+=1;},7,(message)=>{lastToast=message;},new Set(),()=>true
  );
  const staleTarget={removeAttribute(name){if(name==='href'){removed+=1;delete this.href;}}};
  handlers.intent({cancelable:true,preventDefault(){prevented+=1;},currentTarget:staleTarget});
  assert.equal(prevented,1);
  assert.equal(removed,1);
  assert.equal(primed,1);
  assert.equal(closed,0,'pointer and context intent refresh without closing the native menu target');
  handlers.open({preventDefault(){prevented+=1;},currentTarget:staleTarget});
  assert.equal(prevented,2);
  assert.equal(primed,2);
  assert.equal(closed,1);
  assert.match(lastToast,/Обновляю защищённую ссылку/);
  currentHref='https://docs.google.com/document/d/ExampleDocument123/edit';
  const freshTarget={href:'https://stale.example/',removeAttribute(name){if(name==='href')delete this.href;}};
  handlers.intent({cancelable:true,preventDefault(){prevented+=1;},currentTarget:freshTarget});
  assert.equal(freshTarget.href,currentHref);
  handlers.open({preventDefault(){prevented+=1;},currentTarget:freshTarget});
  assert.equal(freshTarget.href,currentHref);
  assert.equal(prevented,2,'a newly validated target is allowed to navigate');
  assert.match(frontend, /materialMenuOpen\.addEventListener\('pointerdown',handleMaterialMenuOpenIntent\)/);
  assert.match(frontend, /materialMenuOpen\.addEventListener\('contextmenu',handleMaterialMenuOpenIntent\)/);
  assert.match(frontend, /materialMenuOpen\.addEventListener\('auxclick',handleMaterialMenuOpen\)/);
  const toggle=frontend.slice(frontend.indexOf('function toggleMaterialMenu'),frontend.indexOf('function handleMaterialMenuAction'));
  assert.match(toggle,/open\.removeAttribute\('href'\);open\.hidden=!href/);
});

test('each column offers one Add document chooser for either a link or an upload', () => {
  const render = frontend.slice(frontend.indexOf('function render()'), frontend.indexOf('function scheduleActionProofRefresh'));
  assert.match(render, /SECTIONS\.forEach\(\(section\)=>/);
  assert.match(render, /add\.dataset\.addDocument=section/);
  assert.match(render, /add\.textContent='\+ \u0434\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u0434\u043e\u043a\u0443\u043c\u0435\u043d\u0442'/);
  assert.match(frontend, /data-document-action="link"/);
  assert.match(frontend, /data-document-action="upload"/);
  assert.match(frontend, /if\(action==='link'\)openLinkModal\(section,returnFocus\);else if\(action==='upload'\)\{chooseFiles\(section\);restoreFocusTarget\(returnFocus\);\}/);
  assert.doesNotMatch(render, /data\.addLink|\+ \u0434\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u0441\u0441\u044b\u043b\u043a\u0443/);
});

test('primary cards create Google files and their pencils upload into the matching section', () => {
  const primaryMarkup = frontend.slice(frontend.indexOf('function cardMarkup'), frontend.indexOf('function materialCardMarkup'));
  const render = frontend.slice(frontend.indexOf('function render()'), frontend.indexOf('function scheduleActionProofRefresh'));
  assert.match(frontend, /data-upload-section="\$\{section\}"/);
  assert.match(frontend, /chooseFiles\(upload\.dataset\.uploadSection\)/);
  assert.match(primaryMarkup, /class="gedit"/);
  assert.doesNotMatch(primaryMarkup, /chevronSvg|material-menu-trigger/);
  assert.match(render, /primary\.classList\.toggle\('busy',state\.busy\.has\(`create:\$\{section\}`\)\)/);
  assert.match(render, /primary\.setAttribute\('aria-disabled',String\(!actionReady\)\)/);
  assert.match(render, /const actionReady=state\.actionReady,mutationReady=cachedMutationReady\(\)/);
  assert.match(render, /uploadButton\.disabled=!mutationReady/);
  assert.match(render, /add\.disabled=!mutationReady\|\|state\.busy\.has/);
  assert.doesNotMatch(render, /classList\.toggle\('busy'[^\n]*!actionReady/);
  assert.match(frontend, /if\(section==='Drive'\)[\s\S]*createGoogle\(section\)/);
  assert.match(frontend, /const payload=\{taskPageId,section,idempotencyKey:operation\.value\}/);
  assert.match(frontend, /const prepared=bridgeRequest&&bridgeRequest\.reservation\|\|\(!bridgeRequest&&state\.preparedCreates\[section\]\)/);
  assert.match(frontend, /payload\.reservationId=prepared\.reservationId/);
  assert.match(frontend, /preparedName:prepared\.preparedName,generation:prepared\.generation,navigateUntil:prepared\.navigateUntil,reservationProof:prepared\.reservationProof/);
  assert.match(frontend, /createGoogleWithRecovery\(payload\)/);
  assert.match(frontend, /call\('apiUpload',\{taskPageId,name:file\.name,mimeType:file\.type\|\|'application\/octet-stream',section,dataBase64,idempotencyKey:operation\.value\}\)/);
  assert.doesNotMatch(frontend, /seedDownloadFromFile\(data\.material,file\)/);
});

test('signed prepared files open directly and bind the background claim to the same request', () => {
  assert.match(frontend, /preparedCreates:\{\}/);
  assert.match(frontend, /function safePreparedCreate\(value\)/);
  assert.match(frontend, /url\.hostname!=='docs\.google\.com'/);
  assert.match(frontend, /url\.search\|\|url\.hash/);
  assert.match(frontend, /function warmPreparedCreates\(\)/);
  assert.match(frontend, /!\(state\.authoritative\|\|state\.snapshotTrusted\)\|\|state\.busy\.size/);
  assert.match(frontend, /Object\.keys\(state\.preparedCreates\)\.length>=3/);
  assert.match(frontend, /const proofOnly=!state\.actionReady/);
  assert.match(frontend, /call\('apiWarmCreateContext',\{taskPageId,proofOnly:true\}\)/);
  assert.match(frontend, /Promise\.allSettled\(missing\.map\(\(section\)=>\s*call\('apiWarmCreateContext',\{taskPageId,section\}\)/);
  assert.match(frontend, /call\('apiWarmCreateContext',\{taskPageId\}\)/);
  assert.match(frontend, /function mergePreparedCreates\(value,expectedSection\)/);
  assert.match(frontend, /safeTaskFolderUrl\(data&&data\.folderUrl\)/);
  assert.match(frontend, /state\.snapshotTrusted=true;state\.actionReady=true/);
  assert.match(frontend, /state\.actionReady\?Object\.values\(state\.preparedCreates\)/);
  assert.match(frontend, /trustedUntil:state\.actionReady&&Number\.isFinite\(state\.trustedUntil\)\?new Date\(state\.trustedUntil\)\.toISOString\(\):''/);
  assert.match(frontend, /const issued=issuedPreparedCreates\.get\(reservationId\),reservation=issued&&Number\.isSafeInteger\(issued\.generation\)\?safePreparedCreate\(data\):issued/);
  assert.match(frontend, /!preparedCreateMatches\(issued,reservation\)/);
  assert.match(frontend, /type:'notion-widget-v20-primary-started',requestId/);
  assert.match(frontend, /activeBridgeCreateRequests\.get\(data\.section\)===requestId/);
  assert.match(frontend, /reservationProof:item\.reservationProof/);
  assert.match(frontend, /createGoogle\(data\.section,\{source:event\.source,origin:event\.origin,requestId,reservationId,reservation\}\)/);
  assert.match(frontend, /prepared&&prepared\.reservationId===bridgeRequest\.reservationId\)delete state\.preparedCreates\[section\]/);
});

test('v2 prepared descriptors are exact, canonical and fail closed before bridge forwarding', () => {
  const source=frontend.slice(frontend.indexOf('function normalizeClientId'),frontend.indexOf('function preparedCreateMap'));
  const helpers=new Function('URL',`${source};return {normalizeClientId,safePreparedCreate,preparedCreateMatches};`)(URL);
  const clientId='a1111111-1111-4111-8111-111111111111';
  assert.equal(helpers.normalizeClientId(clientId),clientId);
  assert.equal(helpers.normalizeClientId(` ${clientId} `),'');
  assert.equal(helpers.normalizeClientId(clientId.toUpperCase()),'');
  const descriptor={
    section:'Docs',reservationId:'b2222222-2222-4222-8222-222222222222',
    openUrl:'https://docs.google.com/document/d/PreparedGoogleDoc123/edit',preparedName:'Новый Google документ',
    generation:1,navigateUntil:new Date(Date.now()+30*24*60*60*1000).toISOString(),reservationProof:'a'.repeat(64)
  };
  const safe=helpers.safePreparedCreate(descriptor);
  assert.deepEqual(safe,descriptor);
  assert.equal(helpers.safePreparedCreate({...descriptor,generation:'1'}),null);
  assert.equal(helpers.safePreparedCreate({...descriptor,preparedName:` ${descriptor.preparedName} `}),null);
  assert.equal(helpers.safePreparedCreate({...descriptor,reservationProof:descriptor.reservationProof.toUpperCase()}),null);
  assert.equal(helpers.safePreparedCreate({...descriptor,reservationId:descriptor.reservationId.toUpperCase()}),null);
  assert.equal(helpers.preparedCreateMatches(safe,{...safe,preparedName:'Другое'}),false);
});

test('fresh cached action proof starts missing Docs, Sheets and Slides warm RPCs in parallel', async () => {
  const source=frontend.slice(frontend.indexOf('function warmPreparedCreates()'),frontend.indexOf('function resolveRuntimeLocation()'));
  assert.ok(source.startsWith('function warmPreparedCreates()'));
  const state={bootstrapped:true,authoritative:false,snapshotTrusted:true,actionReady:true,preparedCreates:{},busy:new Set()};
  const calls=[],resolvers=new Map();
  let allStartedResolve;
  const allStarted=new Promise((resolve)=>{allStartedResolve=resolve;});
  const call=(method,payload)=>{
    calls.push({method,payload:{...payload}});
    if(!payload.section)throw new Error('batch fallback must not run when every sectional warm succeeds');
    return new Promise((resolve)=>{
      resolvers.set(payload.section,resolve);
      if(resolvers.size===3)allStartedResolve();
    });
  };
  const missingPreparedCreateSections=()=>['Docs','Sheets','Slides'].filter((section)=>!state.preparedCreates[section]);
  const acceptWarmCreateContext=(data,_merge,expectedSection)=>{
    const item=(data.preparedCreates||[]).find((candidate)=>candidate.section===expectedSection);
    if(!item)return false;
    state.preparedCreates[expectedSection]=item;
    return true;
  };
  const factory=new Function('state','runtimeLocationResolved','taskPageId','createPoolWarmPromise','call','missingPreparedCreateSections','acceptWarmCreateContext','scheduleActionProofRetry','window',`${source};return {warmPreparedCreates};`);
  const warm=factory(state,true,'3c62d627-39a1-80a1-aac7-ec19ffc9ef8e',null,call,missingPreparedCreateSections,acceptWarmCreateContext,()=>{},globalThis).warmPreparedCreates();
  await Promise.race([allStarted,new Promise((_,reject)=>setTimeout(()=>reject(new Error('sectional warms did not start in parallel')),500))]);
  assert.deepEqual(calls.map((entry)=>entry.payload.section).sort(),['Docs','Sheets','Slides']);
  assert.ok(calls.every((entry)=>entry.method==='apiWarmCreateContext'&&!Object.prototype.hasOwnProperty.call(entry.payload,'proofOnly')));
  for(const [section,resolve] of resolvers)resolve({preparedCreates:[{section,reservationId:`reservation-${section}`,openUrl:`https://example.invalid/${section}`}]});
  assert.equal(await warm,true);
  assert.deepEqual(Object.keys(state.preparedCreates).sort(),['Docs','Sheets','Slides']);
  assert.equal(calls.length,3,'successful sectional calls must not trigger the slower batch fallback');
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
  assert.match(frontend, /id="runtimeParams" data-params="<\?= runtimeParamsJson \?>"/);
  assert.match(frontend, /let accessToken = params\.get\('accessToken'\) \|\| String\(serverRuntimeParams\.accessToken\|\|''\)/);
  assert.match(frontend, /let clientIdInput = String\(params\.get\('clientId'\) \|\| serverRuntimeParams\.clientId \|\| ''\)\.slice\(0,80\)/);
  assert.match(frontend, /let embedNonce = params\.get\('embedNonce'\) \|\| String\(serverRuntimeParams\.embedNonce\|\|''\)/);
  assert.match(frontend, /let clientId = normalizeClientId\(clientIdInput\)/);
  assert.match(frontend, /function normalizeClientId\(value\)/);
  assert.match(frontend, /\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-4\[0-9a-f\]\{3\}-\[89ab\]\[0-9a-f\]\{3\}-\[0-9a-f\]\{12\}\$/);
  assert.match(frontend, /google\.script\.url/);
  assert.match(frontend, /accessToken=String\(runtimeParams\.accessToken\|\|accessToken\|\|''\)/);
  assert.match(frontend, /clientIdInput=String\(runtimeParams\.clientId\|\|clientIdInput\|\|''\)\.slice\(0,80\)/);
  assert.match(frontend, /clientId=normalizeClientId\(clientIdInput\)/);
  assert.match(frontend, /securedPayload=Object\.assign\(\{\},payload\|\|\{\},\{accessToken\}\)/);
  assert.match(frontend, /if\(clientIdInput\)securedPayload\.clientId=clientId\|\|clientIdInput/);
  assert.doesNotMatch(frontend, /console\.(?:log|debug|info|warn|error)/);
});

test('owned binaries use only a server-prepared direct Drive link or the strict neutral courier', () => {
  const materialCard = frontend.slice(frontend.indexOf('function materialCard'), frontend.indexOf('async function bootstrap'));
  const gridClick = frontend.slice(frontend.indexOf('function handleGridClick'), frontend.indexOf('function handleGridKeydown'));
  assert.match(materialCard, /const directDownloadHref=freshDirectDownloadUrl\(item\),courierHref=downloadCourierHref\(item\)/);
  assert.match(materialCard, /main=document\.createElement\(href\?'a':'button'\)/);
  assert.match(materialCard, /main\.href=href;main\.target='_blank';main\.rel='noopener noreferrer';main\.referrerPolicy='no-referrer'/);
  assert.match(materialCard, /if\(directDownloadHref\)main\.dataset\.downloadDirect='true';else main\.dataset\.downloadCourier='true'/);
  assert.match(materialCard, /const action=canPrepareDownload\(item\)\?'\u0421\u043a\u0430\u0447\u0430\u0442\u044c'/);
  assert.match(gridClick, /itemOpen\.dataset\.downloadDirect==='true'[\s\S]*freshDirectDownloadUrl\(item\)/);
  assert.match(gridClick, /if\(!item\|\|!freshHref\)[\s\S]*downloadCourierHref\(item\)[\s\S]*delete itemOpen\.dataset\.downloadDirect/);
  assert.match(gridClick, /if\(!fallbackHref\)\{itemOpen\.removeAttribute\('href'\)[\s\S]*delete itemOpen\.dataset\.downloadDirect[\s\S]*delete itemOpen\.dataset\.downloadCourier/);
  assert.match(gridClick, /itemOpen\.dataset\.directOpen==='true'&&item\)recentDrivePageIds\.add/);
  assert.ok(gridClick.indexOf("const menuTrigger=event.target.closest('[data-material-menu-id]')") < gridClick.indexOf("const itemOpen=event.target.closest('[data-item-open]')"));
  assert.match(gridClick, /if\(menuTrigger\)\{event\.preventDefault\(\);event\.stopPropagation\(\);toggleMaterialMenu/);
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

test('a hot account-bound server-prepared Drive URL bypasses the courier only for the exact material', () => {
  const helpersSource = frontend.slice(frontend.indexOf('function strongDownloadTicket'), frontend.indexOf('function canPrepareDownload'));
  const normalizeUuid = (value) => String(value || '').toLowerCase();
  const canPrepareDownload = (item) => Boolean(item?.canDownload && item?.widgetOwned && !item?.archived);
  const state = { bootstrapped:true, serviceUrl:'https://script.google.com/macros/s/abcdefghijklmnopqrstuvwxyz0123456789_-AB/exec' };
  const taskPageId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',accessToken='A'.repeat(48);
  const item={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',googleFileId:'DRIVEFILE123',canDownload:true,widgetOwned:true};
  const direct='https://drive.google.com/uc?export=download&authuser=owner%40example.com&id=DRIVEFILE123';
  const downloadGrants=new Map([[item.id,{downloadGrant:'a'.repeat(96),expiresAt:new Date(Date.now()+30000).toISOString(),directDownloadUrl:direct,directDownloadExpiresAt:new Date(Date.now()+30000).toISOString()}]]);
  const build = new Function('window','TextEncoder','btoa','URL','normalizeUuid','state','taskPageId','accessToken','canPrepareDownload','DOWNLOAD_COURIER_URL','downloadGrants','DIRECT_DOWNLOAD_MAX_TTL_MS',`${helpersSource};return {freshDirectDownloadUrl,downloadCourierHref};`);
  const helpers = build({crypto:{getRandomValues(){}}},TextEncoder,btoa,URL,normalizeUuid,state,taskPageId,accessToken,canPrepareDownload,'https://ravilvaliev1999-spec.github.io/notion-widgets/download-courier.html',downloadGrants,15*60*1000);
  assert.equal(helpers.freshDirectDownloadUrl(item),direct);
  assert.equal(helpers.downloadCourierHref(item),direct);
  assert.equal(direct.includes(accessToken),false);
  assert.equal(helpers.freshDirectDownloadUrl({...item,googleFileId:'OTHERFILE123'}),'');
  downloadGrants.get(item.id).directDownloadUrl='https://drive.google.com/uc?authuser=owner%40example.com&export=download&id=DRIVEFILE123';
  assert.equal(helpers.freshDirectDownloadUrl(item),'','query order is canonical and fail-closed');
  downloadGrants.get(item.id).directDownloadUrl='https://drive.google.com/uc?export=download&authuser=owner%40example.com&id=DRIVEFILE123&extra=1';
  assert.equal(helpers.freshDirectDownloadUrl(item),'','extra parameters are rejected');
});

test('the live bridge exposes only exact encrypted-navigation material for real saved cards', () => {
  const source=frontend.slice(frontend.indexOf('function presentationSnapshotSourceMaterials'),frontend.indexOf('function announceEmbedSnapshot'));
  const nativeBinding='a'.repeat(64),binaryBinding='b'.repeat(64);
  const native={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'  Отчёт   за август  ',section:'Docs',format:'Google Docs',position:1,openUrl:'https://docs.google.com/document/d/ExampleDocument123/edit',syncStatus:'synced',navigationBinding:nativeBinding};
  const binary={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',name:'Архив.zip',section:'Drive',format:'ZIP',position:2,canDownload:true,widgetOwned:true,syncStatus:'synced',navigationBinding:binaryBinding};
  const disguised={id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',name:'Не Google',section:'Docs',format:'Word',position:3,openUrl:'https://docs.google.com/document/d/AnotherDocument123/edit',syncStatus:'synced'};
  const state={materials:[native,binary,disguised]},optimisticMaterialMutations=new Map();
  const direct='https://drive.google.com/uc?export=download&authuser=owner%40example.com&id=DRIVEFILE123';
  const expiresAt=new Date(Date.now()+14*60*1000).toISOString(),downloadGrants=new Map([[binary.id,{directDownloadExpiresAt:expiresAt}]]);
  const build=new Function('state','SECTIONS','canPrepareDownload','URL','optimisticMaterialMutations','freshDirectDownloadUrl','downloadGrants','normalizeUuid','DIRECT_DOWNLOAD_MAX_TTL_MS',`${source};return {presentationSnapshotMaterials,navigationSnapshotMaterials,nativeGoogleNavigationUrl};`);
  const helpers=build(state,['Drive','Docs','Sheets','Slides'],(item)=>Boolean(item&&item.canDownload&&item.widgetOwned),URL,optimisticMaterialMutations,(item)=>item===binary?direct:'',downloadGrants,(value)=>String(value||'').toLowerCase(),15*60*1000);
  assert.deepEqual(helpers.presentationSnapshotMaterials()[0],{name:'Отчёт за август',section:'Docs',format:'Google Docs',position:1,navigationBinding:nativeBinding});
  assert.deepEqual(helpers.navigationSnapshotMaterials(),[
    {name:'Отчёт за август',section:'Docs',format:'Google Docs',position:1,navigationBinding:nativeBinding,openUrl:native.openUrl},
    {name:'Архив.zip',section:'Drive',format:'ZIP',position:2,navigationBinding:binaryBinding,directDownloadUrl:direct,directDownloadExpiresAt:expiresAt}
  ]);
  downloadGrants.get(binary.id).directDownloadExpiresAt=new Date(Date.now()+16*60*1000).toISOString();
  assert.deepEqual(helpers.navigationSnapshotMaterials(),[
    {name:'Отчёт за август',section:'Docs',format:'Google Docs',position:1,navigationBinding:nativeBinding,openUrl:native.openUrl}
  ],'a direct URL beyond fifteen minutes is never published to the wrapper');
  downloadGrants.get(binary.id).directDownloadExpiresAt=expiresAt;
  native.navigationBinding='c'.repeat(64);
  assert.equal(helpers.navigationSnapshotMaterials()[0].navigationBinding,native.navigationBinding,'an otherwise identical replacement publishes a different opaque identity/revision binding');
  const canonicalNativeUrl=native.openUrl;
  native.openUrl+='?usp=sharing';
  assert.equal(helpers.nativeGoogleNavigationUrl(native),canonicalNativeUrl,'a single benign Drive usp marker is stripped before persistence');
  native.openUrl+='&unexpected=1';
  assert.equal(helpers.nativeGoogleNavigationUrl(native),'','other Google URL parameters fail closed');
  native.openUrl=canonicalNativeUrl;
  native.section='Sheets';
  assert.equal(helpers.nativeGoogleNavigationUrl(native),canonicalNativeUrl,'moving a Docs material between widget columns keeps the exact link validated by its real format');
  optimisticMaterialMutations.set(native.id,{kind:'edit'});
  assert.deepEqual(helpers.navigationSnapshotMaterials(),[],'optimistic mutations are never persisted as confirmed navigation');
  assert.match(frontend,/navigationMaterials:navigationSnapshotMaterials\(\)/);
  assert.match(frontend,/navigationFolderUrl:state\.actionReady\?safeTaskFolderUrl\(state\.folderUrl\):''/);
  const prime=frontend.slice(frontend.indexOf('function primeDownloadGrant'),frontend.indexOf('async function refreshVisibleDownloadGrants'));
  assert.match(prime,/downloadGrants\.set\([\s\S]*refreshDownloadGrantLink\(materialId\);announceEmbedBridgeReady\(\)/);
});

test('optimistic edits and hides never become durable bridge snapshots, while confirmed or rolled-back renders do', () => {
  const optimisticMaterialMutations=new Map([['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',{kind:'edit'}]]);
  let rows=[{name:'Исходное имя',section:'Docs',format:'Google Docs',position:0}];
  const snapshotMessages=[];
  const snapshotSource=frontend.slice(frontend.indexOf('function announceEmbedSnapshot'),frontend.indexOf('function announceEmbedBridgeReady'));
  const snapshotHarness=new Function('optimisticMaterialMutations','isEmbedBridgeMode','state','presentationSnapshotMaterials','postToEmbedAncestors',`
    let lastAnnouncedSnapshotFingerprint='',bridgeAnnouncements=0;
    function announceEmbedBridgeReady(){bridgeAnnouncements+=1;}
    ${snapshotSource}
    return {announce:announceEmbedSnapshot,bridgeAnnouncements:()=>bridgeAnnouncements};
  `)(optimisticMaterialMutations,()=>true,{bootstrapped:true},()=>rows.map((row)=>({...row})),(message)=>snapshotMessages.push(message));

  snapshotHarness.announce();
  assert.equal(snapshotMessages.length,0,'an optimistic presentation snapshot must not reach durable wrapper storage');
  assert.equal(snapshotHarness.bridgeAnnouncements(),0,'the companion bridge payload is also withheld while mutation state is provisional');
  optimisticMaterialMutations.clear();
  snapshotHarness.announce();
  assert.equal(snapshotMessages.length,1,'the first confirmed render publishes its real snapshot');
  assert.equal(snapshotHarness.bridgeAnnouncements(),1);

  optimisticMaterialMutations.set('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',{kind:'hide'});
  rows=[];
  snapshotHarness.announce();
  assert.equal(snapshotMessages.length,1,'a provisional hide cannot overwrite the last confirmed durable snapshot');
  optimisticMaterialMutations.clear();
  snapshotHarness.announce();
  assert.equal(snapshotMessages.length,2,'after RPC success, the confirmed hidden state is published');
  assert.deepEqual(snapshotMessages[1].materials,[]);

  const bridgeMessages=[];
  const bridgeSource=frontend.slice(frontend.indexOf('function announceEmbedBridgeReady'),frontend.indexOf('function postEmbedBridgeGeometry'));
  const announceBridge=new Function('optimisticMaterialMutations','runtimeLocationResolved','isEmbedBridgeMode','state','completedCreateAnnouncements','presentationSnapshotMaterials','navigationSnapshotMaterials','safeTaskFolderUrl','primaryGeometry','window','postToEmbedAncestors','bridgeInstanceId',`${bridgeSource};return announceEmbedBridgeReady;`)(
    optimisticMaterialMutations,true,()=>true,{bootstrapped:true,authoritative:true,snapshotTrusted:false,actionReady:false,materials:[],preparedCreates:{},trustedUntil:0,folderUrl:''},new Map(),()=>[],()=>[],()=>'',()=>[],{innerWidth:900,innerHeight:500},(message)=>bridgeMessages.push(message),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  optimisticMaterialMutations.set('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',{kind:'edit'});
  announceBridge();
  assert.equal(bridgeMessages.length,0);
  optimisticMaterialMutations.clear();
  announceBridge();
  assert.equal(bridgeMessages.length,1,'confirmed state resumes complete bridge publication');
});

test('trusted bootstrap primes only visible downloads independently from create warming while preserving unchanged packages', () => {
  const bootstrap=frontend.slice(frontend.indexOf('function applyBootstrapData'),frontend.indexOf('function refresh('));
  const prime=frontend.slice(frontend.indexOf('function freshDownloadGrant'),frontend.indexOf('function downloadCourierHref'));
  const automaticPrime=frontend.slice(frontend.indexOf('function deferDownloadPrimeForBusy'),frontend.indexOf('function downloadCourierHref'));
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
  assert.match(bootstrap,/if\(state\.authoritative\|\|state\.snapshotTrusted\)deferInitialDownloadPrimeUntilAuthoritative=false/);
  assert.match(bootstrap,/scheduleDownloadGrantPrime\(downloadPrimeGeneration\)/);
  assert.match(frontend,/let deferredDownloadPrimeGeneration = -1/);
  assert.match(automaticPrime,/function deferDownloadPrimeForBusy\(generation\)/);
  assert.match(automaticPrime,/function resumeDeferredDownloadPrime\(\)/);
  assert.match(automaticPrime,/if\(state\.busy\.size\)\{deferDownloadPrimeForBusy\(generation\);return;\}/);
  assert.match(automaticPrime,/canPrepareDownload\(item\)&&downloadCardIsVisible\(item\.id\)&&downloadGrantNeedsRefresh\(item,true\)/);
  assert.doesNotMatch(automaticPrime,/createPoolWarmPromise|missingPreparedCreateSections|warmPreparedCreates/);
  assert.match(automaticPrime,/for\(const pageId of candidates\)/);
  assert.match(automaticPrime,/,DOWNLOAD_PRIME_IDLE_MS\)/);
  assert.doesNotMatch(automaticPrime,/DOWNLOAD_GRANT_PRIME_WORKERS|Promise\.all/);
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

test('trusted cached and authoritative snapshots prime visible downloads serially without waiting for create heads', async () => {
  const source=frontend.slice(frontend.indexOf('function deferDownloadPrimeForBusy'),frontend.indexOf('function downloadCourierHref'));
  const visible={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
  const hidden={id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'};
  const makeHarness=({authoritative,deferred=false,busy=false,warm=null,actionReady=true,missing=()=>[],headWarm=async()=>{},visibleAll=false,needsRefresh=()=>true,onPrime=async()=>{}}={})=>{
    const timers=[],calls=[],state={authoritative,snapshotTrusted:true,actionReady,busy:new Set(busy?['create:Docs']:[]),materials:[visible,hidden]};let renewals=0;
    const api=new Function('state','deferInitialDownloadPrimeUntilAuthoritative','downloadPrimeGeneration','canPrepareDownload','downloadCardIsVisible','downloadGrantNeedsRefresh','normalizeUuid','window','createPoolWarmPromise','missingPreparedCreateSections','warmPreparedCreates','primeDownloadGrant','scheduleDownloadGrantRenewal','deferredDownloadPrimeGeneration','DOWNLOAD_PRIME_IDLE_MS',`${source};return {schedule:scheduleDownloadGrantPrime,resume:resumeDeferredDownloadPrime,deferred:()=>deferredDownloadPrimeGeneration,setGeneration:(value)=>downloadPrimeGeneration=value};`)(
      state,deferred,7,()=>true,(id)=>visibleAll||id===visible.id,needsRefresh,(id)=>id,{setTimeout(callback){timers.push(callback);}},warm,missing,headWarm,async(id)=>{calls.push(id);await onPrime(id,state);},()=>{renewals+=1;},-1,750
    );
    return {state,timers,calls,...api,renewals:()=>renewals};
  };

  const cached=makeHarness({authoritative:false});
  cached.schedule(7);
  assert.equal(cached.timers.length,1,'a fresh server proof may prepare its exact registry downloads');
  await cached.timers[0]();
  assert.deepEqual(cached.calls,[visible.id]);

  const inconsistent=makeHarness({authoritative:true,deferred:true});
  inconsistent.schedule(7);
  assert.equal(inconsistent.timers.length,0,'the explicit startup deferral fails closed even if authority flags race');

  const busy=makeHarness({authoritative:true,busy:true});
  busy.schedule(7);
  assert.equal(busy.timers.length,0,'active creation takes priority over automatic download preparation');
  assert.equal(busy.deferred(),7);
  busy.state.busy.clear();busy.resume();busy.resume();
  assert.equal(busy.timers.length,1,'one busy period queues exactly one bounded retry');
  await busy.timers[0]();
  assert.deepEqual(busy.calls,[visible.id]);

  let releaseWarm;
  const warm=new Promise((resolve)=>{releaseWarm=resolve;});
  const live=makeHarness({authoritative:true,warm});
  live.schedule(7);
  assert.equal(live.timers.length,1);
  const completion=live.timers[0]();
  await Promise.resolve();
  assert.deepEqual(live.calls,[visible.id],'download preparation is independent from the create pool');
  releaseWarm();
  await completion;
  assert.deepEqual(live.calls,[visible.id],'automatic preparation excludes off-screen cards');
  assert.equal(live.renewals(),1);

  const prepared=new Set();
  const interrupted=makeHarness({authoritative:true,visibleAll:true,needsRefresh:(item)=>!prepared.has(item.id),onPrime:async(id,state)=>{prepared.add(id);if(id===visible.id)state.busy.add('create:Docs');}});
  interrupted.schedule(7);await interrupted.timers[0]();
  assert.deepEqual(interrupted.calls,[visible.id]);
  assert.equal(interrupted.deferred(),7,'busy appearing inside the serial loop preserves exactly one continuation');
  interrupted.state.busy.clear();interrupted.resume();interrupted.resume();
  assert.equal(interrupted.timers.length,2,'repeated completion signals cannot multiply the deferred retry');
  await interrupted.timers[1]();
  assert.deepEqual(interrupted.calls,[visible.id,hidden.id]);
});

test('download prime waits for action proof but never for prepared create heads', async () => {
  const source=frontend.slice(frontend.indexOf('function deferDownloadPrimeForBusy'),frontend.indexOf('function downloadCourierHref'));
  const item={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
  const events=[],timers=[],state={authoritative:true,snapshotTrusted:false,actionReady:false,busy:new Set(),materials:[item]};
  const api=new Function('state','deferInitialDownloadPrimeUntilAuthoritative','downloadPrimeGeneration','canPrepareDownload','downloadCardIsVisible','downloadGrantNeedsRefresh','normalizeUuid','window','createPoolWarmPromise','missingPreparedCreateSections','warmPreparedCreates','primeDownloadGrant','scheduleDownloadGrantRenewal','deferredDownloadPrimeGeneration','DOWNLOAD_PRIME_IDLE_MS',`${source};return scheduleDownloadGrantPrime;`)(
    state,false,11,()=>true,()=>true,()=>true,(id)=>id,{setTimeout(callback){timers.push(callback);}},Promise.resolve(),()=>['Docs','Sheets','Slides'],async()=>{events.push('heads');},async()=>{events.push('download');},()=>{},-1,750
  );
  api(11);
  assert.equal(timers.length,0,'no binary work starts before the server action proof');
  state.actionReady=true;
  api(11);
  await timers[0]();
  assert.deepEqual(events,['download']);
});

test('applying a trusted cached snapshot safely releases download preparation without a full Notion refresh', () => {
  const source=frontend.slice(frontend.indexOf('function applyBootstrapData'),frontend.indexOf('function readInitialBootstrap'));
  const state={task:null,folderUrl:null,serviceUrl:null,materials:[],preparedCreates:{},authoritative:false,snapshotTrusted:false,actionReady:false,fullySynced:false,trustedUntil:0,maxUploadBytes:1,claimRefreshNotBefore:0,bootstrapped:false};
  const scheduled=[];
  const harness=new Function('state','canPrepareDownload','downloadMaterialFingerprint','pendingCreatePolls','rememberCompletedCreate','recentDrivePageIds','recentCompletedCreates','optimisticMaterialMutations','preparedCreateMap','rememberIssuedPreparedCreates','bootstrapSnapshotIsTrusted','downloadPrimeGeneration','deferredDownloadPrimeGeneration','downloadGrants','downloadGrantRetryNotBefore','downloadGrantRenewTimer','downloadGrantExpiryTimer','window','scheduleActionReadyExpiry','runtimeLocationResolved','warmPreparedCreates','render','announceEmbedBridgeReady','scheduleDownloadGrantPrime','deferInitialDownloadPrimeUntilAuthoritative',`${source};return {apply:applyBootstrapData,deferred:()=>deferInitialDownloadPrimeUntilAuthoritative};`)(
    state,()=>false,()=>'',new Map(),()=>{},new Set(),new Map(),new Map(),()=>({}),()=>{},(data,authoritative)=>data.cached===true||authoritative,0,-1,new Map(),new Map(),0,0,{clearTimeout(){},setTimeout(){}},()=>{},false,()=>{},()=>{},()=>{},(generation)=>scheduled.push(generation),true
  );
  const trustedUntil=new Date(Date.now()+60000).toISOString();
  harness.apply({task:{id:'task'},materials:[],cached:true,authoritative:false,actionReady:true,trustedUntil},false);
  assert.equal(state.snapshotTrusted,true);
  assert.equal(state.authoritative,false);
  assert.equal(harness.deferred(),false,'the fresh server proof is sufficient for an independently authorized download RPC');
  assert.deepEqual(scheduled,[1]);

  harness.apply({task:{id:'task'},materials:[],cached:false,authoritative:true,actionReady:true,trustedUntil},true);
  assert.equal(state.authoritative,true);
  assert.equal(harness.deferred(),false);
  assert.deepEqual(scheduled,[1,2]);
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
  assert.match(frontend,/id="runtimeParams" data-params="<\?= runtimeParamsJson \?>"/);
  assert.match(startup,/data\.cached!==true/);
  assert.match(startup,/data\.authoritative!==false/);
  assert.match(startup,/Array\.isArray\(data\.materials\)/);
  assert.match(startup,/applyBootstrapData\(initialBootstrap,false,\{skipDownloadPrime:true\}\)/);
  assert.match(frontend,/let runtimeLocationResolved = Boolean\(taskPageId&&accessToken\)/);
  assert.match(frontend,/state\.authoritative=Boolean\(authoritative&&data&&data\.authoritative!==false\)/);
  assert.match(frontend,/state\.snapshotTrusted=bootstrapSnapshotIsTrusted\(data,state\.authoritative\)/);
  assert.match(frontend,/state\.actionReady=Boolean\(runtimeLocationResolved&&state\.snapshotTrusted\)/);
  assert.match(frontend,/if\(!runtimeLocationResolved\|\|!isEmbedBridgeMode\(\)\|\|!state\.bootstrapped\)return/);
  assert.match(startupTail,/deferInitialDownloadPrimeUntilAuthoritative=!bootstrapSnapshotIsTrusted\(initialBootstrap,false\)/);
  assert.match(startupTail,/if\(!state\.bootstrapped\|\|!state\.actionReady\)applyBootstrapData\(initialBootstrap,false,\{skipDownloadPrime:true\}\)/);
  assert.match(startupTail,/if\(runtimeLocationResolved\)continueStartup\(\)/);
  assert.match(startupTail,/scheduleCachedRefresh\(state\.actionReady\?CACHED_REFRESH_IDLE_MS:0\)/);
  assert.match(startupTail,/if\(state\.actionReady\)scheduleDownloadGrantPrime/);
  assert.match(frontend,/if\(state\.authoritative\|\|state\.snapshotTrusted\)deferInitialDownloadPrimeUntilAuthoritative=false/);
  assert.match(frontend,/!deferInitialDownloadPrimeUntilAuthoritative\)scheduleDownloadGrantPrime\(downloadPrimeGeneration\)/);
});

test('visible download grants renew just before expiry with one timer, bounded workers and intent refresh', () => {
  const prime=frontend.slice(frontend.indexOf('function downloadCardIsVisible'),frontend.indexOf('function downloadCourierHref'));
  assert.match(frontend,/const DIRECT_DOWNLOAD_MAX_TTL_MS = 15\*60\*1000/);
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
  const main={tagName:'A',href:'https://drive.google.com/uc?export=download&authuser=owner%40example.com&id=DRIVEFILE123',dataset:{downloadDirect:'true'},removeAttribute(name){if(name==='href')delete this.href;}};
  const card={querySelector(){return main;},classList:{remove(value){classes.delete(value);},add(value){classes.add(value);}}};
  const refresh=new Function('state','document','freshDirectDownloadUrl','downloadCourierHref',`${source};return refreshDownloadGrantLink;`)(
    {materials:[item]},
    {querySelector(){return card;}},
    ()=>'',
    ()=>''
  );
  refresh(item.id);
  assert.equal('href' in main,false);
  assert.equal(main.dataset.downloadDirect,undefined);
  assert.equal(main.dataset.downloadCourier,undefined);
  assert.equal(classes.has('download-ready'),false);
});

test('grant refresh eligibility honors expiry lead and suppresses repeated proxy intent calls', () => {
  const source=frontend.slice(frontend.indexOf('function trustedPreparedDriveDownloadUrl'),frontend.indexOf('function deferDownloadGrantRefresh'));
  const downloadGrants=new Map(),downloadGrantRetryNotBefore=new Map();
  const normalizeUuid=(value)=>String(value||'').toLowerCase();
  const needs=new Function('URL','normalizeUuid','downloadGrants','downloadGrantRetryNotBefore','DOWNLOAD_GRANT_RENEW_LEAD_MS','DIRECT_DOWNLOAD_MAX_TTL_MS',`${source};return downloadGrantNeedsRefresh;`)(URL,normalizeUuid,downloadGrants,downloadGrantRetryNotBefore,15000,15*60*1000);
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
  downloadGrants.set(item.id,{downloadGrant:grant,expiresAt:new Date(now+30000).toISOString(),directDownloadUrl:'https://drive.google.com/uc?export=download&authuser=owner%40example.com&id=DRIVEFILE123',directDownloadExpiresAt:new Date(now+10*60*1000).toISOString()});
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
  assert.match(publicCourier, /frame-src https:\/\/script\.google\.com https:\/\/\*\.googleusercontent\.com/);
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
  assert.match(downloader, /function validatedPreparedDrive\(data\)/);
  assert.match(downloader, /const prepared=prepareResponse&&prepareResponse\.ok\?validatedPreparedDrive\(prepareResponse\.data\):null/);
  assert.match(downloader, /if\(prepared\)[\s\S]*notifyCourierDirect\(prepared\);[\s\S]*return/);
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

test('Apps Script courier uses a canonical prepared Drive URL without a second RPC and falls back on malformed prepared data', async () => {
  const script=downloader.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const task='3c62d627-39a1-80a1-aac7-ec19ffc9ef8e';
  const pageId='3c72d627-39a1-81e1-971f-c6b30665ce55';
  const accessToken='t'.repeat(64),downloadTicket='d'.repeat(64);
  const driveUrl='https://drive.google.com/uc?export=download&authuser=owner%40example.com&id=DriveBinaryFile123';

  async function run(preparedData,downloadData=null,precomputed=null){
    const calls=[];
    let settle;
    const completed=new Promise((resolve)=>{settle=resolve;});
    const runtime={
      success:null,failure:null,
      withSuccessHandler(handler){this.success=handler;return this;},
      withFailureHandler(handler){this.failure=handler;return this;},
      apiPrepareDownload(input){calls.push({method:'apiPrepareDownload',input});const handler=this.success;queueMicrotask(()=>handler({ok:true,data:preparedData}));},
      apiDownload(input){calls.push({method:'apiDownload',input});const handler=this.success;queueMicrotask(()=>handler({ok:true,data:downloadData}));}
    };
    const nodes={
      status:{textContent:''},
      runtimeParams:{dataset:{params:JSON.stringify({task,pageId,accessToken,downloadTicket})}},
      precomputedResult:{dataset:{result:JSON.stringify(precomputed)}}
    };
    const top={postMessage(payload){settle(payload);},close(){}};
    const context={
      console,Date,JSON,Math,Number,String,RegExp,Set,Array,Object,Promise,URL,Blob,Uint8Array,
      atob,queueMicrotask,setTimeout,clearTimeout,
      document:{
        getElementById:(id)=>nodes[id]||null,
        createElement:()=>({click(){},remove(){}}),
        body:{appendChild(){}}
      },
      google:{script:{run:runtime}}
    };
    context.window=context;
    context.window.top=top;
    vm.runInNewContext(script,context,{filename:'Download.html'});
    const payload=await Promise.race([completed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('download runner timed out')),500))]);
    return {calls,payload,status:nodes.status.textContent};
  }

  const serverExpiresAt=new Date(Date.now()+120_000).toISOString();
  const serverPrecomputed=await run(null,null,{
    mode:'direct',url:driveUrl,name:'report.xlsx',mimeType:'application/pdf',size:123,
    expiresAt:serverExpiresAt,downloadTicket
  });
  assert.deepEqual(serverPrecomputed.calls,[],'a cold POST server result starts without google.script.run');
  assert.equal(serverPrecomputed.payload.status,'direct');
  assert.equal(serverPrecomputed.payload.downloadTicket,downloadTicket);
  assert.equal(serverPrecomputed.payload.url,driveUrl);
  assert.equal(serverPrecomputed.payload.name,'report.xlsx');

  const expiresAt=new Date(Date.now()+50_000).toISOString();
  const directExpiresAt=new Date(Date.now()+10*60_000).toISOString();
  const valid=await run({
    mode:'grant',downloadGrant:'a'.repeat(96),expiresAt,
    directDownloadUrl:driveUrl,directDownloadExpiresAt:directExpiresAt,directDownloadName:'report.xlsx'
  });
  assert.deepEqual(valid.calls.map((call)=>call.method),['apiPrepareDownload']);
  assert.equal(valid.payload.status,'direct');
  assert.equal(valid.payload.url,driveUrl);
  assert.equal(valid.payload.name,'report.xlsx');

  const fallbackExpiresAt=new Date(Date.now()+120_000).toISOString();
  const malformed=await run({
    mode:'grant',downloadGrant:'b'.repeat(96),expiresAt,
    directDownloadUrl:`${driveUrl}&extra=1`,directDownloadExpiresAt:directExpiresAt,directDownloadName:'report.xlsx'
  },{mode:'direct',url:driveUrl,name:'report.xlsx',expiresAt:fallbackExpiresAt});
  assert.deepEqual(malformed.calls.map((call)=>call.method),['apiPrepareDownload','apiDownload']);
  assert.equal(malformed.calls[1].input.downloadGrant,'b'.repeat(96));
  assert.equal(malformed.payload.status,'direct');
  assert.equal(malformed.payload.url,driveUrl);
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
  assert.match(publicCreateCourier, /frame-src https:\/\/script\.google\.com https:\/\/\*\.googleusercontent\.com/);
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
  assert.match(frontend, /startOptimisticCreate\(section,bridgeRequest\.requestId,false,prepared\)/);
  assert.match(frontend, /name:preparedForSection&&preparedForSection\.preparedName\|\|pendingCreateName\(section\)/);
  assert.match(frontend, /openUrl:preparedForSection&&preparedForSection\.openUrl\|\|''/);
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
  assert.match(frontend, /if\(state\.actionReady!==true\)/);
  assert.match(frontend, /authoritative:state\.authoritative\|\|state\.snapshotTrusted/);
  assert.match(frontend, /actionReady:state\.actionReady===true/);
  assert.doesNotMatch(frontend, /actionReady:state\.actionReady===true\|\|state\.authoritative/);
  assert.match(frontend, /state\.materials\.slice\(\)\.reverse\(\)\.filter\(\(item\)=>item&&!String\(item\.id\|\|''\)\.startsWith\('pending:'\)&&item\.syncStatus!=='pending'\)/);
  assert.match(frontend, /pendingCreatePolls\.delete\(requestId\);rememberCompletedCreate\(requestId\);recentDrivePageIds\.add\(completed\.id\)/);
  assert.match(frontend, /warmPreparedCreates\(\)\.catch\(\(\)=>\{\}\)/);
  assert.doesNotMatch(frontend, /apiGetCreateStatus[^\n]+idempotencyKey/);
});

test('live authority and a fresh signed snapshot proof unlock only their intended actions', () => {
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
  assert.match(frontend,/runtimeLocationResolved&&state\.authoritative&&!state\.actionReady&&!\(options&&options\.deferActionProofRetry\)\)window\.setTimeout\(\(\)=>warmPreparedCreates\(\),0\)/);
  assert.match(frontend,/applyBootstrapData\(fresh,true,\{deferActionProofRetry:true\}\)/);
  assert.match(frontend,/state\.trustedUntil-Date\.now\(\)<=ACTION_READY_RENEW_LEAD_MS\)\)scheduleActionProofRefresh\(0\)/);
  assert.match(frontend,/state\.snapshotTrusted=bootstrapSnapshotIsTrusted\(data,state\.authoritative\)/);
  assert.match(frontend,/state\.actionReady=Boolean\(runtimeLocationResolved&&state\.snapshotTrusted\)/);
  assert.doesNotMatch(frontend,/state\.actionReady=state\.authoritative\|\|/);
  assert.doesNotMatch(frontend,/const actionReady=state\.actionReady\|\|state\.authoritative/);
  const mutationSource=frontend.slice(frontend.indexOf('function cachedMutationReady'),frontend.indexOf('function render()'));
  const mutationFactory=new Function('state','runtimeLocationResolved',`${mutationSource};return cachedMutationReady;`);
  assert.equal(mutationFactory({bootstrapped:true,actionReady:true,authoritative:false,snapshotTrusted:true},true)(),true,'fresh signed registry proof unlocks backend-validated mutations');
  assert.equal(mutationFactory({bootstrapped:true,actionReady:true,authoritative:false,snapshotTrusted:false},true)(),false,'cached data without a fresh proof remains read-only');
  assert.equal(mutationFactory({bootstrapped:true,actionReady:false,authoritative:true,snapshotTrusted:false},true)(),false,'live authority without an action proof remains fail-closed');
  assert.equal(mutationFactory({bootstrapped:true,actionReady:true,authoritative:true,snapshotTrusted:true},false)(),false,'unresolved runtime credentials cannot mutate');
  for (const gate of [
    /function openLinkModal[\s\S]*if\(!cachedMutationReady\(\)\)/,
    /async function addLink[\s\S]*if\(!cachedMutationReady\(\)\)/,
    /function chooseFiles[\s\S]*if\(!cachedMutationReady\(\)\)/,
    /async function uploadFiles[\s\S]*if\(!cachedMutationReady\(\)\)/,
    /function openEdit[\s\S]*if\(!cachedMutationReady\(\)\)/
  ]) assert.match(frontend,gate);
  const saveEditSource=frontend.slice(frontend.indexOf('async function saveEdit'),frontend.indexOf('function currentItem'));
  const archiveSource=frontend.slice(frontend.indexOf('async function archiveMaterial'),frontend.indexOf('function upsert'));
  assert.match(saveEditSource,/if\(!cachedMutationReady\(\)\)\{toast\('Завершаю синхронизацию…'\);return;\}/);
  assert.match(archiveSource,/if\(!cachedMutationReady\(\)\)\{toast\('Завершаю синхронизацию…'\);return;\}/);
  assert.match(frontend,/function handleDragStart\(event\)\{if\(!state\.authoritative\|\|optimisticMaterialMutations\.size\)/,'cached proof never unlocks reorder');

  const proofSource=frontend.slice(frontend.indexOf('function actionProofIsFresh'),frontend.indexOf('function scheduleActionProofRetry'));
  const proofs=new Function(`${proofSource};return {live:actionProofIsFresh,snapshot:bootstrapSnapshotIsTrusted};`)();
  const future=new Date(Date.now()+60000).toISOString();
  assert.equal(proofs.live({cached:false,authoritative:true,actionReady:true,trustedUntil:future}),true);
  assert.equal(proofs.live({cached:true,authoritative:false,actionReady:true,trustedUntil:future}),false);
  assert.equal(proofs.live({cached:false,authoritative:true,actionReady:false,trustedUntil:future}),false);
  assert.equal(proofs.live({cached:false,authoritative:true,actionReady:true,trustedUntil:new Date(Date.now()-1).toISOString()}),false);
  assert.equal(proofs.snapshot({cached:true,authoritative:false,actionReady:true,trustedUntil:future},false),true,'fresh server registry proof enables native create/read without changing live authority');
  assert.equal(proofs.snapshot({cached:true,authoritative:false,actionReady:true,trustedUntil:new Date(Date.now()-1).toISOString()},false),false);
  assert.equal(proofs.snapshot({cached:true,authoritative:true,actionReady:true,trustedUntil:future},false),false,'mixed cached authority flags fail closed');
  assert.equal(proofs.snapshot({cached:false,authoritative:true,actionReady:true,trustedUntil:future},false),false,'live payload needs the independently derived authority bit');
  assert.equal(proofs.snapshot({cached:false,authoritative:true,actionReady:true,trustedUntil:future},true),true);

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

test('outer mutation runner emits only an exact safe presentation to the fixed public origin', () => {
  const script=mutationRunner.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1]||'';
  assert.ok(script);
  assert.match(mutationRunner,/id="precomputedResult" data-result="<\?= precomputedResultJson \?>"/);
  assert.match(script,/const TARGET_ORIGIN='https:\/\/ravilvaliev1999-spec\.github\.io'/);
  assert.doesNotMatch(script,/accessToken|idempotencyKey|googleFileId|pageId|openUrl|window\.open/);
  const requestId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',binding='b'.repeat(64),nextBinding='c'.repeat(64);
  function run(value) {
    const messages=[];
    const parent={postMessage(message,origin){messages.push({message:JSON.parse(JSON.stringify(message)),origin});}};
    parent.parent=parent;
    vm.runInNewContext(script,{
      window:{parent},
      document:{getElementById(id){return id==='precomputedResult'?{dataset:{result:JSON.stringify(value)}}:null;}},
      JSON,String,Number,Array,Object,RegExp
    });
    return messages;
  }
  const success=run({requestId,status:'success',kind:'edit',binding,material:{name:'Новое имя',section:'Docs',format:'Google Docs',position:2,navigationBinding:nextBinding}});
  assert.equal(success.length,1);
  assert.equal(success[0].origin,'https://ravilvaliev1999-spec.github.io');
  assert.deepEqual(Object.keys(success[0].message).sort(),['binding','kind','material','requestId','status','type']);
  assert.deepEqual(Object.keys(success[0].message.material).sort(),['format','name','navigationBinding','position','section']);
  assert.equal(JSON.stringify(success).includes(binding),true);
  assert.doesNotMatch(JSON.stringify(success),/accessToken|idempotency|googleFileId|pageId|openUrl/);
  const hidden=run({requestId,status:'success',kind:'hide',binding,material:null});
  assert.equal(hidden[0].message.material,null);
  const error=run({requestId,status:'error',message:'Повторите действие',retryable:true});
  assert.deepEqual(Object.keys(error[0].message).sort(),['message','requestId','retryable','status','type']);
  assert.equal(run({requestId,status:'success',kind:'edit',binding,material:{name:'X',section:'Docs',format:'Google Docs',position:1,navigationBinding:nextBinding,idempotencyKey:'forbidden'}}).length,0);
  assert.equal(run({requestId,status:'success',kind:'hide',binding,material:null,accessToken:'forbidden'}).length,0);
});

test('production bridge and local mock expose all required scenarios and scripts parse', () => {
  assert.match(frontend, /window\.google && google\.script && google\.script\.run/);
  for (const method of ['apiBootstrap','apiPollDriveMetadata','apiSyncTask','apiCreateGoogle','apiAddLink','apiUpload','apiDownload']) assert.ok(frontend.includes(`method==='${method}'`), `mock does not implement ${method}`);
  assert.match(frontend,/const mockActionProof=\(\)=>\(\{authoritative:true,actionReady:true,trustedUntil:new Date\(Date\.now\(\)\+120000\)\.toISOString\(\)\}\)/);
  assert.match(frontend,/method==='apiBootstrap'[\s\S]*mockActionProof\(\)/);
  assert.match(frontend,/method==='apiSyncTask'[\s\S]*mockActionProof\(\)/);
  for (const html of [frontend,downloader,creator,mutationRunner,publicCourier,publicCreateCourier]) {
    const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match)=>match[1]);
    assert.ok(scripts.length>0);scripts.forEach((script)=>assert.doesNotThrow(()=>new Function(script)));
  }
});
