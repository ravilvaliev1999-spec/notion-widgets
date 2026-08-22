import { assertSourceSnapshot } from './audit.mjs';
import { canonicalJson, deepClone, deepFreeze } from './canonical.mjs';
import { assertWritesEnabled } from './config.mjs';
import { invariant } from './errors.mjs';
import {
  assertLedgerCompatible,
  createLedger,
  ledgerEntry,
  markLedgerComplete,
  recordLedgerEntry
} from './ledger.mjs';
import { assertExactPlacement } from './offline-target.mjs';
import { buildMigrationPlan } from './plan.mjs';
import { assertElementsSchema } from './schema.mjs';

function verifyMappedTarget(target, entry, operation, kind) {
  const record = target.getById(entry.targetId);
  invariant(record && record.kind === kind, 'mapped_target_missing', 'Запись из ledger отсутствует в target', {
    kind,
    sourceId: operation.sourceId,
    targetId: entry.targetId
  });
  invariant(record.idempotencyKey === operation.idempotencyKey &&
    record.sourceFingerprint === operation.sourceFingerprint,
  'mapped_target_drift', 'Запись из ledger не соответствует source snapshot', {
    kind,
    sourceId: operation.sourceId,
    targetId: entry.targetId
  });
}

function resolvePlacement(ledger, operation) {
  const placement = operation.placement;
  invariant(placement && ['direct', 'inbox'].includes(placement.mode), 'invalid_operation_placement',
    'Операция не содержит placement-контракт', { kind: operation.kind, sourceId: operation.sourceId });
  if (placement.mode === 'inbox') return structuredClone(placement);
  if (placement.kind === 'task' || placement.kind === 'section') {
    const mapping = ledgerEntry(ledger, placement.kind, placement.sourceId);
    invariant(mapping, 'inside_mapping_missing', 'Для «Внутри» отсутствует target mapping', {
      sourceId: operation.sourceId,
      placementKind: placement.kind,
      placementSourceId: placement.sourceId
    });
    return { ...placement, targetId: mapping.targetId };
  }
  invariant(['project', 'direction', 'sphere'].includes(placement.kind) && placement.targetId,
    'external_mapping_missing', 'External placement не содержит sandbox target ID', {
      sourceId: operation.sourceId,
      placement
    });
  return structuredClone(placement);
}

function assertMappedPlacement(mapped, resolvedPlacement, operation) {
  invariant(canonicalJson(mapped.placement) === canonicalJson(resolvedPlacement),
    'mapped_placement_drift', 'Размещение элемента из ledger изменилось', {
      kind: operation.kind,
      sourceId: operation.sourceId
    });
}

async function migratePlacedOperations({
  kind,
  operations,
  target,
  ledger,
  stats,
  onCheckpoint,
  now
}) {
  for (const operation of operations) {
    const resolvedPlacement = resolvePlacement(ledger, operation);
    const mapped = ledgerEntry(ledger, kind, operation.sourceId);
    if (mapped) {
      verifyMappedTarget(target, mapped, operation, kind);
      assertMappedPlacement(mapped, resolvedPlacement, operation);
      stats.skipped += 1;
      continue;
    }
    const result = kind === 'section'
      ? await target.upsertSection(operation, resolvedPlacement)
      : await target.upsertKnowledge(operation, resolvedPlacement);
    recordLedgerEntry(ledger, kind, {
      ...operation,
      targetId: result.record.id,
      placement: resolvedPlacement
    }, now);
    stats[result.created ? 'created' : 'recovered'] += 1;
    await onCheckpoint({ target, ledger, operation });
  }
}

export async function runOfflineMigration({
  snapshot,
  config,
  target,
  ledger = null,
  onCheckpoint = async () => {},
  now = () => new Date()
}) {
  assertWritesEnabled(config, snapshot);
  const sourceAudit = assertSourceSnapshot(snapshot, config);
  assertElementsSchema(target.schema, config.elementsDataSourceId);
  invariant(target.dataSourceId === target.schema.dataSourceId.replace(/[^a-f0-9]/gi, '').toLowerCase(),
    'target_schema_state_mismatch', 'Target snapshot и schema относятся к разным data source');
  const source = deepFreeze(deepClone(sourceAudit.normalized));
  const plan = buildMigrationPlan(source);
  const activeLedger = ledger
    ? assertLedgerCompatible(ledger, sourceAudit, config)
    : createLedger(sourceAudit, config, now);
  const stats = {
    created: 0,
    recovered: 0,
    skipped: 0,
    tasks: plan.tasks.length,
    sections: plan.sections.length,
    knowledge: plan.knowledge.length
  };

  for (const operation of plan.tasks) {
    const mapped = ledgerEntry(activeLedger, 'task', operation.sourceId);
    if (mapped) {
      verifyMappedTarget(target, mapped, operation, 'task');
      stats.skipped += 1;
      continue;
    }
    const parent = operation.parentSourceId ? ledgerEntry(activeLedger, 'task', operation.parentSourceId) : null;
    invariant(!operation.parentSourceId || parent, 'parent_mapping_missing',
      'Родительская задача ещё не мигрирована', {
        sourceId: operation.sourceId,
        parentSourceId: operation.parentSourceId
      });
    const result = await target.upsertTask(operation, parent && parent.targetId);
    recordLedgerEntry(activeLedger, 'task', {
      ...operation,
      targetId: result.record.id
    }, now);
    stats[result.created ? 'created' : 'recovered'] += 1;
    await onCheckpoint({ target, ledger: activeLedger, operation });
  }

  await migratePlacedOperations({
    kind: 'section',
    operations: plan.sections,
    target,
    ledger: activeLedger,
    stats,
    onCheckpoint,
    now
  });
  await migratePlacedOperations({
    kind: 'knowledge',
    operations: plan.knowledge,
    target,
    ledger: activeLedger,
    stats,
    onCheckpoint,
    now
  });

  assertExactPlacement(target, activeLedger);
  markLedgerComplete(activeLedger, {
    tasks: plan.tasks.length,
    sections: plan.sections.length,
    knowledge: plan.knowledge.length
  }, now);
  await onCheckpoint({ target, ledger: activeLedger, operation: null });
  return Object.freeze({ source, plan, ledger: activeLedger, stats });
}
