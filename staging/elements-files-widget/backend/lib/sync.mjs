import { normalizeId } from './config.mjs';
import { P, pageToRecord } from './records.mjs';

async function inBatches(items, size, worker) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(worker));
  }
}

export async function reconcileDriveNames(config, notion, drive, repository, logger = console) {
  const pages = await notion.queryDataSource(config.elementsDataSourceId, {
    filter: {
      and: [
        { property: P.provider, select: { equals: 'Google Drive' } },
        { property: P.googleFileId, rich_text: { is_not_empty: true } },
        { property: P.syncStatus, select: { equals: 'synced' } }
      ]
    }
  });
  const mapped = pages.map(pageToRecord);
  const records = mapped.filter((record) => !record.inTrash && record.taskIds.length === 1 && !record.insideHasMore && record.taskId);
  let changed = 0;
  let errors = mapped.length - records.length;
  await inBatches(records, 5, async (record) => {
    try {
      const file = await drive.getFile(record.googleFileId);
      const safeParent = Boolean(record.googleFolderId) && (file.parents || []).includes(record.googleFolderId);
      const safeTask = normalizeId(file.appProperties?.elementsTaskPageId) === record.taskId;
      if (!safeParent || !safeTask || file.trashed) {
        await repository.patch(record.taskId, record.id, { status: 'error', syncedAt: new Date() });
        errors += 1;
        return;
      }
      if (file.name !== record.name) {
        await repository.patch(record.taskId, record.id, { name: file.name, syncedAt: new Date() });
        changed += 1;
      }
    } catch (error) {
      errors += 1;
      logger.warn('[drive-sync] record failed', { recordId: record.id, code: error.code });
    }
  });
  return { scanned: records.length, changed, errors };
}

export function startRenameSync(config, notion, drive, repository, logger = console) {
  if (config.writeGate !== 'open' || config.dryRun) {
    logger.info('[drive-sync] disabled while write gate is closed or DRY_RUN is enabled');
    return () => {};
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await reconcileDriveNames(config, notion, drive, repository, logger); }
    catch (error) { logger.error('[drive-sync] cycle failed', { code: error.code, message: error.message }); }
    finally { running = false; }
  };
  const timer = setInterval(tick, config.driveRenameSyncMs);
  timer.unref();
  setTimeout(tick, 1000).unref();
  return () => clearInterval(timer);
}
