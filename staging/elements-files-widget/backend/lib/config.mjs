import { invariant } from './errors.mjs';

export const AUTHORIZED_MAIN = Object.freeze({
  workspaceId: 'ed4b491dab6b449dbd9a7b7992281f96',
  elementsDatabaseId: '3822d62739a1807a966df43585d75212',
  elementsDataSourceId: '3822d62739a18018a2dc000b95bf5722',
  taskTemplatePageId: '3832d62739a180269d86d4b40101c0d7',
  canaryTaskPageId: '3ae2d62739a180adb49ce028699b75d9',
  canaryMaterialPageId: '3c52d62739a1815397f5c0c65e4d294f',
  spheresDataSourceId: '3822d62739a180529ef1000bc10b8f68',
  directionsDataSourceId: '3822d62739a180699637000ba20c3b1d',
  projectsDataSourceId: '3822d62739a18068aafa000b9db5ed1c'
});

// These containers remain Legacy/read-only until the owner explicitly accepts the
// migration. The active Elements/Spheres/Directions/Projects IDs intentionally do
// not appear here: they are checked against AUTHORIZED_MAIN instead.
export const LEGACY_NOTION_DENYLIST = Object.freeze([
  '045802df7e54463bac86f0e02d057231',
  'a8e81b3f5b8840a39e6c911a6be59d11',
  '79b560c5a3ad48c1a0dd5bc418c83277',
  'dcc5e9aadbe74b0ba4e5450e0b17263b',
  '2d90f52de6374648bfa059584a170a07',
  'c43dbf411e734e889994a21fabe1529c',
  '3842d62739a18074b000d6477d56768c',
  '3902d62739a1808689d2f829226f2b7e',
  '3932d62739a181849f88c232b8cc988f',
  '3992d62739a180eebab9e8dbc7850435'
]);

export function normalizeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-f0-9]/g, '');
}

function isNotionId(value) {
  return /^[a-f0-9]{32}$/.test(normalizeId(value));
}

function csv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function value(env, key, fallback = '') {
  return String(env[key] ?? fallback).trim();
}

function booleanValue(env, key, fallback = false) {
  const raw = value(env, key, fallback ? 'true' : 'false').toLowerCase();
  invariant(raw === 'true' || raw === 'false', 500, 'invalid_boolean', `${key} должен быть true или false`);
  return raw === 'true';
}

function assertExactMainTarget(config) {
  if (config.allowTestTargets) return;
  const expected = {
    authorizedWorkspaceId: AUTHORIZED_MAIN.workspaceId,
    authorizedElementsDatabaseId: AUTHORIZED_MAIN.elementsDatabaseId,
    elementsDataSourceId: AUTHORIZED_MAIN.elementsDataSourceId,
    authorizedTaskTemplatePageId: AUTHORIZED_MAIN.taskTemplatePageId,
    authorizedCanaryTaskPageId: AUTHORIZED_MAIN.canaryTaskPageId,
    authorizedCanaryMaterialPageId: AUTHORIZED_MAIN.canaryMaterialPageId,
    spheresDataSourceId: AUTHORIZED_MAIN.spheresDataSourceId,
    directionsDataSourceId: AUTHORIZED_MAIN.directionsDataSourceId,
    projectsDataSourceId: AUTHORIZED_MAIN.projectsDataSourceId
  };
  for (const [key, id] of Object.entries(expected)) {
    invariant(normalizeId(config[key]) === id, 500, 'unauthorized_main_target',
      'Конфигурация не совпадает с утверждённым main allowlist', { key });
  }
}

export function authorizedNotionIds(config) {
  return Object.freeze({
    identity: new Set([
      config.authorizedWorkspaceId,
      config.authorizedElementsDatabaseId
    ].map(normalizeId)),
    write: new Set([
      config.elementsDataSourceId,
      config.authorizedTaskTemplatePageId,
      config.authorizedCanaryTaskPageId,
      config.authorizedCanaryMaterialPageId,
      ...(config.authorizedTemplateTestTaskPageId ? [config.authorizedTemplateTestTaskPageId] : [])
    ].map(normalizeId)),
    relationTargets: new Set([
      config.spheresDataSourceId,
      config.directionsDataSourceId,
      config.projectsDataSourceId
    ].map(normalizeId))
  });
}

export function assertTargetSafety(config) {
  invariant(config.appEnv === 'staging', 500, 'unsafe_environment', 'Разрешён только APP_ENV=staging');
  invariant(config.targetProfile === (config.allowTestTargets ? 'test' : 'authorized-main'), 500,
    'unsafe_target_profile', 'Разрешён только утверждённый main target в staging runtime');
  invariant(config.notionVersion === '2026-03-11', 500, 'unsupported_notion_version',
    'Staging зафиксирован на Notion API 2026-03-11');

  const configuredIds = [
    config.authorizedWorkspaceId,
    config.authorizedElementsDatabaseId,
    config.elementsDataSourceId,
    config.authorizedTaskTemplatePageId,
    config.authorizedCanaryTaskPageId,
    config.authorizedCanaryMaterialPageId,
    config.spheresDataSourceId,
    config.directionsDataSourceId,
    config.projectsDataSourceId
  ];
  invariant(configuredIds.every((id) => String(id || '').trim()), 500, 'missing_main_allowlist',
    'Не заполнен полный main allowlist');
  invariant(configuredIds.every(isNotionId), 500, 'invalid_notion_allowlist_id',
    'Main allowlist содержит некорректный Notion ID');
  const normalized = configuredIds.map(normalizeId);
  invariant(new Set(normalized).size === normalized.length, 500, 'duplicate_main_target',
    'Main allowlist содержит повторяющиеся ID');
  assertExactMainTarget(config);

  const denyInput = [...LEGACY_NOTION_DENYLIST, ...config.extraDenylist];
  invariant(denyInput.every(isNotionId), 500, 'invalid_notion_denylist_id',
    'Legacy denylist содержит некорректный Notion ID');
  const deny = new Set(denyInput.map(normalizeId));
  for (const id of normalized) {
    invariant(!deny.has(id), 500, 'allow_deny_overlap',
      'Утверждённый main allowlist пересекается с Legacy denylist', { id });
  }

  const templateTestId = normalizeId(config.authorizedTemplateTestTaskPageId);
  if (templateTestId) {
    invariant(/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i
      .test(String(config.authorizedTemplateTestTaskPageId).trim()), 500, 'invalid_template_test_task_id',
      'AUTHORIZED_TEMPLATE_TEST_TASK_PAGE_ID содержит некорректный Notion ID');
    invariant(!new Set(normalized).has(templateTestId), 500, 'duplicate_main_target',
      'Template-test task должен иметь отдельный точный ID');
    invariant(!deny.has(templateTestId), 500, 'allow_deny_overlap',
      'Template-test task пересекается с Legacy denylist', { id: templateTestId });
  }

  invariant(Boolean(config.stagingDriveFolderId), 500, 'missing_drive_folder',
    'Не задан staging Drive folder');
  invariant(!config.originalDriveDenylist.includes(config.stagingDriveFolderId), 500,
    'production_drive_target_blocked', 'Staging Drive folder совпал с production denylist');
  invariant(['disabled', 'canary', 'test-task', 'template'].includes(config.embedRolloutPhase), 500,
    'invalid_embed_rollout_phase', 'EMBED_ROLLOUT_PHASE должен быть disabled, canary, test-task или template');
  invariant(['canary', 'test-task', 'elements'].includes(config.taskWriteScope), 500,
    'invalid_task_write_scope', 'TASK_WRITE_SCOPE должен быть canary, test-task или elements');

  if (!config.acceptanceApproved) {
    invariant(config.taskWriteScope === 'canary', 500, 'acceptance_required',
      'До приёмки запись разрешена только в canary-задачу');
    invariant(config.enableNewTaskWebhook === false, 500, 'acceptance_required',
      'До приёмки webhook новых задач должен быть выключен');
    invariant(['disabled', 'canary'].includes(config.embedRolloutPhase), 500, 'acceptance_required',
      'До приёмки обновление embed разрешено только для canary-задачи');
    invariant(config.allowRelationUnlink === false, 500, 'destructive_action_blocked',
      'До приёмки очистка Type/Inside запрещена');
    invariant(config.allowDriveTrash === false, 500, 'destructive_action_blocked',
      'До приёмки Drive Trash запрещён');
  }
  if (config.embedRolloutPhase === 'test-task' || config.taskWriteScope === 'test-task') {
    invariant(Boolean(templateTestId), 500, 'missing_template_test_task_id',
      'Для test-task scope нужен точный AUTHORIZED_TEMPLATE_TEST_TASK_PAGE_ID');
  }
  return true;
}

export function assertTaskWriteAllowed(config, taskId) {
  const normalized = normalizeId(taskId);
  if (config.taskWriteScope === 'canary') {
    invariant(normalized === normalizeId(config.authorizedCanaryTaskPageId), 403,
      'task_write_not_allowlisted', 'Запись разрешена только в утверждённую canary-задачу');
    return true;
  }
  if (config.taskWriteScope === 'test-task') {
    invariant(config.acceptanceApproved === true, 403, 'acceptance_required',
      'Запись в template-test task требует явной приёмки');
    const target = normalizeId(config.authorizedTemplateTestTaskPageId);
    invariant(/^[a-f0-9]{32}$/.test(target), 403, 'task_write_not_allowlisted',
      'Не задан точный allowlist template-test task');
    invariant(normalized === target, 403, 'task_write_not_allowlisted',
      'Запись разрешена только в утверждённую template-test task');
    return true;
  }
  invariant(config.acceptanceApproved === true, 403, 'acceptance_required',
    'Расширенная запись требует явной приёмки');
  return true;
}

export function embedRolloutTargetIds(config) {
  if (['test-task', 'template'].includes(config.embedRolloutPhase)) {
    invariant(config.acceptanceApproved === true, 500, 'acceptance_required',
      'Расширенное обновление embed требует явной приёмки');
  }
  if (config.embedRolloutPhase === 'canary') return [normalizeId(config.authorizedCanaryTaskPageId)];
  if (config.embedRolloutPhase === 'test-task') {
    const target = normalizeId(config.authorizedTemplateTestTaskPageId);
    invariant(/^[a-f0-9]{32}$/.test(target), 500, 'missing_template_test_task_id',
      'Для test-task нужен точный AUTHORIZED_TEMPLATE_TEST_TASK_PAGE_ID');
    return [target];
  }
  if (config.embedRolloutPhase === 'template') return [normalizeId(config.authorizedTaskTemplatePageId)];
  return [];
}

export function assertWriteGate(config) {
  assertTargetSafety(config);
  invariant(config.writeGate === 'open', 503, 'write_gate_closed', 'Staging write gate закрыт');
  invariant(config.dryRun === false, 503, 'dry_run_enabled', 'DRY_RUN включён');
  invariant(Boolean(config.stagingDriveMarker), 503, 'missing_drive_marker', 'Не задан STAGING_DRIVE_MARKER');
  invariant(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(config.googleExpectedAccountEmail), 503,
    'missing_google_account_boundary', 'Не задан GOOGLE_EXPECTED_ACCOUNT_EMAIL');
}

export function loadConfig(env = process.env, options = {}) {
  const allowTestTargets = options.allowTestTargets === true;
  const config = {
    appEnv: value(env, 'APP_ENV', 'staging'),
    targetProfile: value(env, 'TARGET_PROFILE', allowTestTargets ? 'test' : 'authorized-main').toLowerCase(),
    allowTestTargets,
    port: Number(value(env, 'PORT', '8787')),
    publicBaseUrl: value(env, 'PUBLIC_BASE_URL'),
    widgetPublicUrl: value(env, 'WIDGET_PUBLIC_URL'),
    allowedOrigins: csv(value(env, 'ALLOWED_ORIGINS', 'http://localhost:8080')),
    notionToken: value(env, 'NOTION_TOKEN'),
    notionVersion: value(env, 'NOTION_VERSION', '2026-03-11'),
    notionWebhookVerificationToken: value(env, 'NOTION_WEBHOOK_VERIFICATION_TOKEN'),
    authorizedWorkspaceId: value(env, 'AUTHORIZED_NOTION_WORKSPACE_ID', AUTHORIZED_MAIN.workspaceId),
    authorizedElementsDatabaseId: value(env, 'AUTHORIZED_ELEMENTS_DATABASE_ID', AUTHORIZED_MAIN.elementsDatabaseId),
    elementsDataSourceId: value(env, 'ELEMENTS_DATA_SOURCE_ID', AUTHORIZED_MAIN.elementsDataSourceId),
    authorizedTaskTemplatePageId: value(env, 'AUTHORIZED_TASK_TEMPLATE_PAGE_ID', AUTHORIZED_MAIN.taskTemplatePageId),
    authorizedCanaryTaskPageId: value(env, 'AUTHORIZED_CANARY_TASK_PAGE_ID', AUTHORIZED_MAIN.canaryTaskPageId),
    authorizedCanaryMaterialPageId: value(env, 'AUTHORIZED_CANARY_MATERIAL_PAGE_ID', AUTHORIZED_MAIN.canaryMaterialPageId),
    authorizedTemplateTestTaskPageId: value(env, 'AUTHORIZED_TEMPLATE_TEST_TASK_PAGE_ID'),
    spheresDataSourceId: value(env, 'SPHERES_DATA_SOURCE_ID', AUTHORIZED_MAIN.spheresDataSourceId),
    directionsDataSourceId: value(env, 'DIRECTIONS_DATA_SOURCE_ID', AUTHORIZED_MAIN.directionsDataSourceId),
    projectsDataSourceId: value(env, 'PROJECTS_DATA_SOURCE_ID', AUTHORIZED_MAIN.projectsDataSourceId),
    stagingDriveFolderId: value(env, 'STAGING_DRIVE_FOLDER_ID'),
    stagingDriveMarker: value(env, 'STAGING_DRIVE_MARKER'),
    googleExpectedAccountEmail: value(env, 'GOOGLE_EXPECTED_ACCOUNT_EMAIL').toLowerCase(),
    googleClientId: value(env, 'GOOGLE_CLIENT_ID'),
    googleClientSecret: value(env, 'GOOGLE_CLIENT_SECRET'),
    googleRefreshToken: value(env, 'GOOGLE_REFRESH_TOKEN'),
    signingSecret: value(env, 'TOKEN_SIGNING_SECRET'),
    writeGate: value(env, 'WRITE_GATE', 'closed').toLowerCase(),
    dryRun: booleanValue(env, 'DRY_RUN', true),
    acceptanceApproved: booleanValue(env, 'ACCEPTANCE_APPROVED', false),
    taskWriteScope: value(env, 'TASK_WRITE_SCOPE', 'canary').toLowerCase(),
    embedRolloutPhase: value(env, 'EMBED_ROLLOUT_PHASE', 'disabled').toLowerCase(),
    enableNewTaskWebhook: booleanValue(env, 'ENABLE_NEW_TASK_WEBHOOK', false),
    allowRelationUnlink: booleanValue(env, 'ALLOW_RELATION_UNLINK', false),
    allowDriveTrash: booleanValue(env, 'ALLOW_DRIVE_TRASH', false),
    driveRenameSyncMs: Number(value(env, 'DRIVE_RENAME_SYNC_MS', '45000')),
    embedRenewalMs: Number(value(env, 'EMBED_RENEWAL_MS', '86400000')),
    extraDenylist: csv(value(env, 'LEGACY_NOTION_DENYLIST_IDS')),
    originalDriveDenylist: csv(value(env, 'ORIGINAL_DRIVE_DENYLIST_IDS'))
  };

  invariant(Number.isInteger(config.port) && config.port > 0, 500, 'invalid_port', 'PORT некорректен');
  invariant(config.driveRenameSyncMs >= 15000 && config.driveRenameSyncMs <= 60000, 500,
    'invalid_sync_interval', 'Drive sync должен быть от 15 до 60 секунд');
  invariant(config.embedRenewalMs >= 3600000 && config.embedRenewalMs <= 604800000, 500,
    'invalid_embed_renewal_interval', 'Embed renewal должен быть от 1 часа до 7 дней');
  if (!options.allowMissingSecrets) {
    assertTargetSafety(config);
    invariant(config.notionToken.length >= 20, 500, 'missing_notion_token', 'Нет staging NOTION_TOKEN');
    invariant(config.signingSecret.length >= 32, 500, 'weak_signing_secret',
      'TOKEN_SIGNING_SECRET должен быть не короче 32 символов');
    invariant(config.googleClientId && config.googleClientSecret && config.googleRefreshToken, 500,
      'missing_google_oauth', 'Не заполнен server-side Google OAuth');
    invariant(config.publicBaseUrl.startsWith('https://') || config.publicBaseUrl.startsWith('http://localhost:'),
      500, 'invalid_public_url', 'PUBLIC_BASE_URL некорректен');
    invariant(config.widgetPublicUrl.startsWith('https://') || config.widgetPublicUrl.startsWith('http://localhost:'),
      500, 'invalid_widget_url', 'WIDGET_PUBLIC_URL некорректен');
  }
  return config;
}
