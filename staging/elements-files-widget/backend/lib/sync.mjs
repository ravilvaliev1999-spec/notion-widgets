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

function isGoogleNative(mimeType) {
  return String(mimeType || '').startsWith('application/vnd.google-apps.');
}

export function driveBinaryIntegrityError(record, file) {
  if (!String(record?.sha256 || '').trim()) return '';
  if (isGoogleNative(file?.mimeType)) return 'drive_content_unverifiable';
  if (!String(file?.mimeType || '').trim()) return 'drive_content_unverifiable';

  const storedSizeRaw = record?.size;
  const driveSizeRaw = file?.size;
  const storedSize = Number(storedSizeRaw);
  const driveSize = Number(driveSizeRaw);
  const storedMd5 = String(record?.md5 || '').trim().toLowerCase();
  const driveMd5 = String(file?.md5Checksum || '').trim().toLowerCase();
  if (storedSizeRaw === null || storedSizeRaw === undefined || storedSizeRaw === '' ||
    driveSizeRaw === null || driveSizeRaw === undefined || driveSizeRaw === '' ||
    !Number.isSafeInteger(storedSize) || storedSize < 0 ||
    !Number.isSafeInteger(driveSize) || driveSize < 0 ||
    !/^[a-f0-9]{32}$/.test(storedMd5) || !/^[a-f0-9]{32}$/.test(driveMd5)) {
    return 'drive_content_unverifiable';
  }
  return storedSize !== driveSize || storedMd5 !== driveMd5 ? 'drive_content_changed' : '';
}

function exactParent(file, parentId) {
  return Array.isArray(file?.parents) && file.parents.length === 1 && String(file.parents[0]) === String(parentId);
}

function folderBoundaryError(config, taskId, record, folder) {
  if (String(folder?.id || '') !== String(record.googleFolderId)) return 'unsafe_drive_folder_identity';
  if (folder?.trashed !== false) return 'drive_folder_trashed';
  if (folder?.mimeType !== 'application/vnd.google-apps.folder') return 'unsafe_drive_folder_type';
  if (!exactParent(folder, config.stagingDriveFolderId)) return 'unsafe_drive_folder_parent';
  if (normalizeId(folder?.appProperties?.elementsTaskPageId) !== taskId) return 'unsafe_drive_folder_binding';
  return '';
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
    const stickyIntegrityError = ['drive_content_changed', 'drive_content_unverifiable'].includes(record.syncError)
      ? record.syncError : '';
    try {
      const file = await drive.getFile(record.googleFileId);
      const safeParent = Boolean(record.googleFolderId) && exactParent(file, record.googleFolderId);
      const safeTask = normalizeId(file.appProperties?.elementsTaskPageId) === expectedTaskId;
      const safeIdentity = String(file.id || '') === String(record.googleFileId);
      const safeIdempotency = Boolean(record.idempotencyKey) &&
        String(file.appProperties?.elementsIdempotencyKey || '') === String(record.idempotencyKey);
      if (!safeParent || !safeTask || !safeIdentity || !safeIdempotency || file.trashed !== false) {
        const reason = file.trashed !== false ? 'drive_file_trashed' :
          !safeParent ? 'unsafe_drive_parent' : !safeTask ? 'unsafe_drive_task_binding' :
            !safeIdentity ? 'unsafe_drive_file_identity' : 'unsafe_drive_idempotency_binding';
        const diagnostic = stickyIntegrityError || reason;
        if (record.status !== (stickyIntegrityError ? 'needs_review' : 'error') ||
          record.integrity !== 'sync_error' || record.syncError !== diagnostic) {
          await repository.patch(expectedTaskId, record.id, {
            status: stickyIntegrityError ? 'needs_review' : 'error',
            syncError: diagnostic,
            integrity: 'sync_error'
          });
        }
        errors += 1;
        continue;
      }

      const folder = await drive.getFile(record.googleFolderId);
      const folderError = folderBoundaryError(config, expectedTaskId, record, folder);
      if (folderError) {
        const diagnostic = stickyIntegrityError || folderError;
        if (record.status !== (stickyIntegrityError ? 'needs_review' : 'error') ||
          record.integrity !== 'sync_error' || record.syncError !== diagnostic) {
          await repository.patch(expectedTaskId, record.id, {
            status: stickyIntegrityError ? 'needs_review' : 'error',
            syncError: diagnostic,
            integrity: 'sync_error'
          });
        }
        errors += 1;
        continue;
      }

      const currentIntegrityError = driveBinaryIntegrityError(record, file);
      const integrityError = currentIntegrityError || stickyIntegrityError;
      if (integrityError) {
        if (record.status !== 'needs_review' || record.integrity !== 'sync_error' || record.syncError !== integrityError) {
          await repository.patch(expectedTaskId, record.id, {
            status: 'needs_review', syncError: integrityError, integrity: 'sync_error'
          });
        }
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
        const diagnostic = stickyIntegrityError || errorCode(error);
        if (record.status !== (stickyIntegrityError ? 'needs_review' : 'error') ||
          record.integrity !== 'sync_error' || record.syncError !== diagnostic) {
          await repository.patch(expectedTaskId, record.id, {
            status: stickyIntegrityError ? 'needs_review' : 'error',
            syncError: diagnostic,
            integrity: 'sync_error'
          });
        }
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

export function metadataSyncTargetId(config) {
  return config.taskWriteScope === 'test-task'
    ? config.authorizedTemplateTestTaskPageId
    : config.authorizedCanaryTaskPageId;
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
  const targetTaskId = metadataSyncTargetId(config);
  const tick = async () => {
    if (running) return;
    running = true;
    try { logger.info('[drive-sync]', await refreshTask(targetTaskId)); }
    catch (error) { logger.error('[drive-sync] cycle failed', { code: error?.code, message: error?.message }); }
    finally { running = false; }
  };
  const timer = setInterval(tick, config.driveRenameSyncMs);
  timer.unref();
  setTimeout(tick, 1000).unref();
  return () => clearInterval(timer);
}
