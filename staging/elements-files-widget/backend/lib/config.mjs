import { invariant } from './errors.mjs';

export const ORIGINAL_DENYLIST = Object.freeze([
  'ed4b491dab6b449dbd9a7b7992281f96',
  '3822d62739a180f28da8ca56604ff7b8',
  '3822d62739a180529ef1000bc10b8f68',
  '3822d62739a180c181fef3e5fbe7237a',
  '3822d62739a180699637000ba20c3b1d',
  '3822d62739a1806993f2d330e7ae918e',
  '3822d62739a18068aafa000b9db5ed1c',
  '3822d62739a1807a966df43585d75212',
  '3822d62739a18018a2dc000b95bf5722',
  '045802df7e54463bac86f0e02d057231',
  'a8e81b3f5b8840a39e6c911a6be59d11',
  '79b560c5a3ad48c1a0dd5bc418c83277',
  'dcc5e9aadbe74b0ba4e5450e0b17263b',
  '2d90f52de6374648bfa059584a170a07',
  'c43dbf411e734e889994a21fabe1529c',
  '3842d62739a18074b000d6477d56768c',
  '3832d62739a180269d86d4b40101c0d7',
  '3902d62739a1808689d2f829226f2b7e',
  '3ae2d62739a180adb49ce028699b75d9',
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

export function assertTargetSafety(config) {
  invariant(config.appEnv === 'staging', 500, 'unsafe_environment', 'Разрешён только APP_ENV=staging');
  invariant(config.notionVersion === '2026-03-11', 500, 'unsupported_notion_version', 'Staging зафиксирован на Notion API 2026-03-11');
  const allowInput = [
    config.sandboxWorkspaceId,
    config.sandboxParentPageId,
    config.elementsDataSourceId
  ];
  invariant(allowInput.every((id) => String(id || '').trim()), 500, 'missing_sandbox_allowlist', 'Не заполнен полный sandbox allowlist');
  invariant(allowInput.every(isNotionId), 500, 'invalid_notion_allowlist_id', 'Sandbox allowlist содержит некорректный Notion ID');
  const allow = allowInput.map(normalizeId);
  const denyInput = [...ORIGINAL_DENYLIST, ...config.extraDenylist];
  invariant(denyInput.every(isNotionId), 500, 'invalid_notion_denylist_id', 'Original denylist содержит некорректный Notion ID');
  const deny = new Set(denyInput.map(normalizeId));
  invariant(new Set(allow).size === allow.length, 500, 'duplicate_sandbox_target', 'Sandbox IDs должны быть разными');
  for (const id of allow) {
    invariant(!deny.has(id), 500, 'production_target_blocked', 'Целевой ID совпал с оригиналом/production', { id });
  }
  invariant(Boolean(config.stagingDriveFolderId), 500, 'missing_drive_folder', 'Не задан staging Drive folder');
  invariant(!config.originalDriveDenylist.includes(config.stagingDriveFolderId), 500, 'production_drive_target_blocked', 'Staging Drive folder совпал с original denylist');
  return true;
}

export function assertWriteGate(config) {
  assertTargetSafety(config);
  invariant(config.writeGate === 'open', 503, 'write_gate_closed', 'Staging write gate закрыт');
  invariant(config.dryRun === false, 503, 'dry_run_enabled', 'DRY_RUN включён');
  invariant(Boolean(config.stagingDriveMarker), 503, 'missing_drive_marker', 'Не задан STAGING_DRIVE_MARKER');
  invariant(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(config.googleExpectedAccountEmail), 503, 'missing_google_account_boundary', 'Не задан GOOGLE_EXPECTED_ACCOUNT_EMAIL');
}

export function loadConfig(env = process.env, options = {}) {
  const config = {
    appEnv: value(env, 'APP_ENV', 'staging'),
    port: Number(value(env, 'PORT', '8787')),
    publicBaseUrl: value(env, 'PUBLIC_BASE_URL'),
    widgetPublicUrl: value(env, 'WIDGET_PUBLIC_URL'),
    allowedOrigins: csv(value(env, 'ALLOWED_ORIGINS', 'http://localhost:8080')),
    notionToken: value(env, 'NOTION_TOKEN'),
    notionVersion: value(env, 'NOTION_VERSION', '2026-03-11'),
    notionWebhookVerificationToken: value(env, 'NOTION_WEBHOOK_VERIFICATION_TOKEN'),
    sandboxWorkspaceId: value(env, 'SANDBOX_WORKSPACE_ID'),
    sandboxParentPageId: value(env, 'SANDBOX_PARENT_PAGE_ID'),
    elementsDataSourceId: value(env, 'ELEMENTS_DATA_SOURCE_ID'),
    stagingDriveFolderId: value(env, 'STAGING_DRIVE_FOLDER_ID'),
    stagingDriveMarker: value(env, 'STAGING_DRIVE_MARKER'),
    googleExpectedAccountEmail: value(env, 'GOOGLE_EXPECTED_ACCOUNT_EMAIL').toLowerCase(),
    googleClientId: value(env, 'GOOGLE_CLIENT_ID'),
    googleClientSecret: value(env, 'GOOGLE_CLIENT_SECRET'),
    googleRefreshToken: value(env, 'GOOGLE_REFRESH_TOKEN'),
    signingSecret: value(env, 'TOKEN_SIGNING_SECRET'),
    writeGate: value(env, 'WRITE_GATE', 'closed').toLowerCase(),
    dryRun: value(env, 'DRY_RUN', 'true').toLowerCase() !== 'false',
    driveRenameSyncMs: Number(value(env, 'DRIVE_RENAME_SYNC_MS', '45000')),
    embedRenewalMs: Number(value(env, 'EMBED_RENEWAL_MS', '86400000')),
    extraDenylist: csv(value(env, 'ORIGINAL_DENYLIST_IDS')),
    originalDriveDenylist: csv(value(env, 'ORIGINAL_DRIVE_DENYLIST_IDS'))
  };

  invariant(Number.isInteger(config.port) && config.port > 0, 500, 'invalid_port', 'PORT некорректен');
  invariant(config.driveRenameSyncMs >= 15000 && config.driveRenameSyncMs <= 60000, 500, 'invalid_sync_interval', 'Drive sync должен быть от 15 до 60 секунд');
  invariant(config.embedRenewalMs >= 3600000 && config.embedRenewalMs <= 604800000, 500, 'invalid_embed_renewal_interval', 'Embed renewal должен быть от 1 часа до 7 дней');
  if (!options.allowMissingSecrets) {
    assertTargetSafety(config);
    invariant(config.notionToken.length >= 20, 500, 'missing_notion_token', 'Нет sandbox NOTION_TOKEN');
    invariant(config.signingSecret.length >= 32, 500, 'weak_signing_secret', 'TOKEN_SIGNING_SECRET должен быть не короче 32 символов');
    invariant(config.googleClientId && config.googleClientSecret && config.googleRefreshToken, 500, 'missing_google_oauth', 'Не заполнен server-side Google OAuth');
    invariant(config.publicBaseUrl.startsWith('https://') || config.publicBaseUrl.startsWith('http://localhost:'), 500, 'invalid_public_url', 'PUBLIC_BASE_URL некорректен');
    invariant(config.widgetPublicUrl.startsWith('https://') || config.widgetPublicUrl.startsWith('http://localhost:'), 500, 'invalid_widget_url', 'WIDGET_PUBLIC_URL некорректен');
  }
  return config;
}
