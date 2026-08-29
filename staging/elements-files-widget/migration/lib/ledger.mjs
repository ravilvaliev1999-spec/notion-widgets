import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalJson } from './canonical.mjs';
import { invariant } from './errors.mjs';
import { normalizeNotionId } from './ids.mjs';

const KINDS = Object.freeze(['task', 'section', 'knowledge']);

function sectionName(kind) {
  invariant(KINDS.includes(kind), 'invalid_ledger_kind', 'Неизвестный kind ledger', { kind });
  return kind === 'task' ? 'tasks' : kind === 'section' ? 'sections' : 'knowledge';
}

export function createLedger(sourceAudit, config, now = () => new Date()) {
  return {
    version: 2,
    source: {
      fingerprint: sourceAudit.fingerprint,
      workspaceId: sourceAudit.normalized.source.workspaceId,
      tasksDataSourceId: sourceAudit.normalized.source.tasksDataSourceId,
      knowledgeDataSourceId: sourceAudit.normalized.source.knowledgeDataSourceId
    },
    target: {
      workspaceId: normalizeNotionId(config.sandboxWorkspaceId, 'SANDBOX_WORKSPACE_ID'),
      parentPageId: normalizeNotionId(config.sandboxParentPageId, 'SANDBOX_PARENT_PAGE_ID'),
      elementsDataSourceId: normalizeNotionId(config.elementsDataSourceId, 'ELEMENTS_DATA_SOURCE_ID')
    },
    entries: { tasks: {}, sections: {}, knowledge: {} },
    complete: false,
    createdAt: now().toISOString()
  };
}

export function assertLedgerCompatible(ledger, sourceAudit, config) {
  invariant(ledger && ledger.version === 2, 'invalid_ledger',
    'Ledger отсутствует или не соответствует knowledge-contract version=2');
  invariant(ledger.entries && ledger.entries.tasks && ledger.entries.sections && ledger.entries.knowledge,
    'invalid_ledger', 'Ledger не содержит sections tasks/sections/knowledge');
  invariant(ledger.source && ledger.source.fingerprint === sourceAudit.fingerprint,
    'ledger_source_mismatch', 'Ledger создан для другого source snapshot');
  const expectedTarget = {
    workspaceId: normalizeNotionId(config.sandboxWorkspaceId, 'SANDBOX_WORKSPACE_ID'),
    parentPageId: normalizeNotionId(config.sandboxParentPageId, 'SANDBOX_PARENT_PAGE_ID'),
    elementsDataSourceId: normalizeNotionId(config.elementsDataSourceId, 'ELEMENTS_DATA_SOURCE_ID')
  };
  for (const [key, id] of Object.entries(expectedTarget)) {
    invariant(normalizeNotionId(ledger.target && ledger.target[key], `ledger.target.${key}`) === id,
      'ledger_target_mismatch', 'Ledger относится к другому sandbox target', { key });
  }
  return ledger;
}

export function ledgerEntry(ledger, kind, sourceId) {
  const section = ledger.entries[sectionName(kind)];
  return section[normalizeNotionId(sourceId, `${kind}.sourceId`)] || null;
}

export function recordLedgerEntry(ledger, kind, mapping, now = () => new Date()) {
  const sourceId = normalizeNotionId(mapping.sourceId, `${kind}.sourceId`);
  const targetId = normalizeNotionId(mapping.targetId, `${kind}.targetId`);
  const section = ledger.entries[sectionName(kind)];
  const next = {
    sourceId,
    targetId,
    sourceFingerprint: String(mapping.sourceFingerprint),
    idempotencyKey: String(mapping.idempotencyKey),
    ...(mapping.placement ? { placement: structuredClone(mapping.placement) } : {}),
    recordedAt: now().toISOString()
  };
  const existing = section[sourceId];
  if (existing) {
    invariant(existing.targetId === targetId, 'ledger_mapping_conflict',
      'Source ID уже связан с другим target ID', {
        kind,
        sourceId,
        existing: existing.targetId,
        attempted: targetId
      });
    invariant(existing.sourceFingerprint === next.sourceFingerprint,
      'ledger_record_changed', 'Source-запись изменилась после внесения в ledger', { kind, sourceId });
    invariant(existing.idempotencyKey === next.idempotencyKey,
      'ledger_idempotency_conflict', 'Изменился idempotency key записи', { kind, sourceId });
    invariant(canonicalJson(existing.placement ?? null) === canonicalJson(next.placement ?? null),
      'ledger_placement_conflict', 'Изменилось точное размещение элемента', { kind, sourceId });
    return existing;
  }
  section[sourceId] = next;
  return next;
}

export function markLedgerComplete(ledger, counts, now = () => new Date()) {
  if (!ledger.complete) {
    ledger.complete = true;
    ledger.completedAt = now().toISOString();
    ledger.counts = {
      tasks: counts.tasks,
      sections: counts.sections,
      knowledge: counts.knowledge
    };
  }
  return ledger;
}

export class FileLedgerStore {
  constructor(path) {
    this.path = path;
  }

  async load() {
    try {
      return JSON.parse(await readFile(this.path, 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(ledger) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
    await rename(temporary, this.path);
  }
}
