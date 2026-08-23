import { assertTaskWriteAllowed, normalizeId } from './config.mjs';

function optionalNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function recoveredIntegrity(record) {
  if (record.integrity === 'duplicate' || record.integrity === 'context_error') return record.integrity;
  return 'ok';
}

function recoveredStatus(integrity) {
  return integrity === 'duplicate' || integrity === 'context_error' ? 'needs_review' : 'synced';
}

function errorCode(error, fallback = 'drive_sync_error') {
  return String(error?.code || fallback).slice(0, 2000);
}

/**
 * Refreshes only Google Drive records directly related to one authorized task.
 * The result is checked again before a Drive request, so a loose query response
 * cannot widen the operation.
 */
export async function reconcileTaskFiles(config, taskId, drive, repository, logger = console) {
  const expectedTaskId = normalizeId(taskId);
  assertTaskWriteAllowed(config, expectedTaskId);
  const rows = await repository.listGoogleDriveForTask(expectedTaskId, false);
  const records = rows.filter((record) =>
    normalizeId(record.taskId) === expectedTaskId &&
    Array.isArray(record.taskIds) && record.taskIds.length === 1 &&
    normalizeId(record.taskIds[0]) === expectedTaskId && record.insideHasMore !== true &&
    record.provider === 'Google Drive' && Boolean(record.googleFileId));

  let changed = 0;
  let errors = rows.length - records.length;
  let recovered = 0;

  for (const record of records) {
    try {
      const file = await drive.getFile(record.googleFileId);
      const safeParent = Boolean(record.googleFolderId) && (file.parents || []).includes(record.googleFolderId);
      const safeTask = normalizeId(file.appProperties?.elementsTaskPageId) === expectedTaskId;
      const safeIdentity = String(file.id || '') === String(record.googleFileId);
      if (!safeParent || !safeTask || !safeIdentity || file.trashed === true) {
        const reason = file.trashed === true ? 'drive_file_trashed' :
          !safeParent ? 'unsafe_drive_parent' : !safeTask ? 'unsafe_drive_task_binding' : 'unsafe_drive_file_identity';
        await repository.patch(expectedTaskId, record.id, {
          status: 'error', syncError: reason, integrity: 'sync_error', syncedAt: new Date()
        });
        errors += 1;
        continue;
      }

      const integrity = recoveredIntegrity(record);
      const syncError = integrity === 'ok' ? '' : record.syncError;
      const patch = {
        name: file.name || record.name,
        url: file.webViewLink || record.url,
        mimeType: file.mimeType || record.mimeType,
        size: optionalNumber(file.size, record.size),
        md5: file.md5Checksum === undefined ? record.md5 : String(file.md5Checksum || ''),
        downloadName: record.downloadName || record.name || file.name,
        status: recoveredStatus(integrity),
        syncError,
        integrity,
        syncedAt: new Date()
      };
      const metadataChanged = patch.name !== record.name || patch.url !== record.url ||
        patch.mimeType !== record.mimeType || patch.size !== record.size || patch.md5 !== record.md5 ||
        patch.downloadName !== record.downloadName || patch.status !== record.status ||
        patch.syncError !== record.syncError || patch.integrity !== record.integrity;
      await repository.patch(expectedTaskId, record.id, patch);
      if (metadataChanged) changed += 1;
      if ((record.status === 'error' || record.integrity === 'sync_error' || record.syncError) &&
        patch.status !== 'error' && patch.integrity !== 'sync_error') recovered += 1;
    } catch (error) {
      errors += 1;
      try {
        await repository.patch(expectedTaskId, record.id, {
          status: 'error', syncError: errorCode(error), integrity: 'sync_error', syncedAt: new Date()
        });
      } catch (patchError) {
        logger.error('[drive-sync] diagnostic patch failed', {
          recordId: record.id, code: patchError?.code, message: patchError?.message
        });
      }
      logger.warn('[drive-sync] record failed', { recordId: record.id, code: error?.code, message: error?.message });
    }
  }

  return { taskId: expectedTaskId, scanned: records.length, changed, recovered, errors };
}

/**
 * Pre-acceptance background refresh is intentionally bounded to the canary.
 * There is no data-source-wide sweep in the runtime.
 */
export function startTaskMetadataSync(config, refreshTask, logger = console) {
  if (config.writeGate !== 'open' || config.dryRun) {
    logger.info('[drive-sync] disabled while write gate is closed or DRY_RUN is enabled');
    return () => {};
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { logger.info('[drive-sync]', await refreshTask(config.authorizedCanaryTaskPageId)); }
    catch (error) { logger.error('[drive-sync] cycle failed', { code: error?.code, message: error?.message }); }
    finally { running = false; }
  };
  const timer = setInterval(tick, config.driveRenameSyncMs);
  timer.unref();
  setTimeout(tick, 1000).unref();
  return () => clearInterval(timer);
}
