import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { deepClone } from './canonical.mjs';
import { invariant } from './errors.mjs';
import { normalizeNotionId } from './ids.mjs';

const PLACEMENT_PROPERTIES = Object.freeze(['inside', 'project', 'direction', 'sphere']);

function deterministicPageId(dataSourceId, key) {
  return createHash('sha256').update(`${dataSourceId}:${key}`).digest('hex').slice(0, 32);
}

function sameRecord(existing, attempted) {
  return JSON.stringify(existing.properties) === JSON.stringify(attempted.properties);
}

function emptyPlacement() {
  return { inside: [], project: [], direction: [], sphere: [] };
}

function placementProperty(kind) {
  if (kind === 'task' || kind === 'section') return 'inside';
  invariant(['project', 'direction', 'sphere'].includes(kind), 'invalid_placement_kind',
    'Неизвестный вид размещения', { kind });
  return kind;
}

function countDirectPlacement(properties) {
  return PLACEMENT_PROPERTIES.reduce((total, property) => {
    invariant(Array.isArray(properties[property]), 'invalid_placement_property',
      `Target property ${property} должен быть массивом`);
    return total + properties[property].length;
  }, 0);
}

export class OfflineTarget {
  constructor(state) {
    invariant(state && (state.version === 1 || state.version === 2), 'invalid_target_snapshot',
      'Target snapshot должен иметь version=1 или version=2');
    invariant(Array.isArray(state.records), 'invalid_target_snapshot', 'Target snapshot records должен быть массивом');
    this.state = deepClone(state);
    this.dataSourceId = normalizeNotionId(state.dataSourceId, 'target.dataSourceId');
    this.schema = this.state.schema;
  }

  static async load(path) {
    return new OfflineTarget(JSON.parse(await readFile(path, 'utf8')));
  }

  get records() {
    return this.state.records;
  }

  getById(id) {
    const normalized = normalizeNotionId(id, 'target record ID');
    return this.records.find((record) => normalizeNotionId(record.id) === normalized) || null;
  }

  getByIdempotencyKey(key) {
    return this.records.find((record) => record.idempotencyKey === key) || null;
  }

  async upsertTask(operation, parentTargetId = '') {
    const properties = {
      ...operation.payload,
      ...emptyPlacement(),
      inside: parentTargetId ? [normalizeNotionId(parentTargetId, 'parent target task ID')] : []
    };
    return this.#upsert(operation, properties);
  }

  async upsertSection(operation, resolvedPlacement) {
    const properties = this.#placedProperties(operation, resolvedPlacement, 'Раздел');
    return this.#upsert(operation, properties);
  }

  async upsertKnowledge(operation, resolvedPlacement) {
    const properties = this.#placedProperties(operation, resolvedPlacement, 'Знание');
    const scope = resolvedPlacement.mode === 'direct'
      ? `${resolvedPlacement.kind}:${resolvedPlacement.targetId}`
      : 'inbox';
    const uniqueness = properties.googleFileId
      ? `file:${scope}:${properties.googleFileId}`
      : properties.normalizedUrl ? `url:${scope}:${properties.normalizedUrl}` : '';
    if (uniqueness) {
      const duplicate = this.records.find((record) => record.kind === 'knowledge' &&
        record.uniqueness === uniqueness && record.idempotencyKey !== operation.idempotencyKey);
      invariant(!duplicate, 'target_uniqueness_conflict',
        'В target уже существует другой материал с тем же placement+file/URL', { uniqueness });
    }
    return this.#upsert(operation, properties, uniqueness);
  }

  #placedProperties(operation, resolvedPlacement, directType) {
    invariant(resolvedPlacement && ['direct', 'inbox'].includes(resolvedPlacement.mode),
      'invalid_resolved_placement', 'Операция не содержит разрешённое размещение', {
        sourceId: operation.sourceId
      });
    const properties = { ...operation.payload, ...emptyPlacement() };
    if (resolvedPlacement.mode === 'inbox') {
      invariant(properties.type === '' && properties.syncStatus === 'needs_review',
        'invalid_inbox_contract', 'Inbox должен иметь пустой Тип и needs_review', {
          sourceId: operation.sourceId
        });
      invariant(countDirectPlacement(properties) === 0, 'placement_not_exact',
        'Inbox не должен иметь direct placement', { sourceId: operation.sourceId });
      return properties;
    }

    invariant(properties.type === directType, 'invalid_element_type',
      `Размещённый элемент должен иметь Тип «${directType}»`, { sourceId: operation.sourceId });
    const targetId = normalizeNotionId(resolvedPlacement.targetId, 'resolved placement target ID');
    if (resolvedPlacement.kind === 'task' || resolvedPlacement.kind === 'section') {
      const parent = this.getById(targetId);
      invariant(parent && parent.kind === resolvedPlacement.kind, 'placement_inside_missing',
        'Целевой элемент для «Внутри» отсутствует или имеет другой тип', {
          sourceId: operation.sourceId,
          placementKind: resolvedPlacement.kind,
          targetId
        });
    }
    properties[placementProperty(resolvedPlacement.kind)] = [targetId];
    invariant(countDirectPlacement(properties) === 1, 'placement_not_exact',
      'Элемент должен иметь ровно один direct placement', {
        sourceId: operation.sourceId,
        placement: resolvedPlacement
      });
    return properties;
  }

  #upsert(operation, properties, uniqueness = '') {
    const attempted = {
      id: deterministicPageId(this.dataSourceId, operation.idempotencyKey),
      kind: operation.kind,
      idempotencyKey: operation.idempotencyKey,
      sourceId: operation.sourceId,
      sourceFingerprint: operation.sourceFingerprint,
      ...(uniqueness ? { uniqueness } : {}),
      properties
    };
    const existing = this.getByIdempotencyKey(operation.idempotencyKey);
    if (existing) {
      invariant(existing.sourceId === operation.sourceId && existing.sourceFingerprint === operation.sourceFingerprint,
        'target_idempotency_conflict', 'Idempotency key target связан с другой source-записью');
      invariant(existing.kind === operation.kind, 'target_kind_drift',
        'Уже созданная target-запись имеет другой kind', { targetId: existing.id });
      invariant(sameRecord(existing, attempted), 'target_record_drift',
        'Уже созданная target-запись отличается от плана', { targetId: existing.id });
      return { record: existing, created: false };
    }
    this.records.push(attempted);
    return { record: attempted, created: true };
  }

  async save(path) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
    await rename(temporary, path);
  }
}

function expectedInternalTarget(ledger, placement, sourceId) {
  if (placement.kind === 'task') {
    const entry = ledger.entries.tasks[placement.sourceId];
    invariant(entry, 'ledger_task_mapping_missing', 'Для placement отсутствует task mapping', { sourceId });
    return entry.targetId;
  }
  if (placement.kind === 'section') {
    const entry = ledger.entries.sections[placement.sourceId];
    invariant(entry, 'ledger_section_mapping_missing', 'Для placement отсутствует section mapping', { sourceId });
    return entry.targetId;
  }
  return placement.targetId;
}

function assertPlacedEntry(target, ledger, entry, kind) {
  const record = target.getById(entry.targetId);
  invariant(record && record.kind === kind, 'ledger_target_missing',
    'Ledger указывает на отсутствующий target-элемент', {
      kind,
      sourceId: entry.sourceId,
      targetId: entry.targetId
    });
  const placement = entry.placement;
  invariant(placement && ['direct', 'inbox'].includes(placement.mode), 'invalid_ledger_placement',
    'Ledger не содержит placement-контракт', { kind, sourceId: entry.sourceId });
  const count = countDirectPlacement(record.properties);
  if (placement.mode === 'inbox') {
    invariant(count === 0 && record.properties.type === '' && record.properties.syncStatus === 'needs_review',
      'inbox_placement_drift', 'Inbox target больше не соответствует fail-closed контракту', {
        kind,
        sourceId: entry.sourceId
      });
    return;
  }
  const expectedTargetId = normalizeNotionId(expectedInternalTarget(ledger, placement, entry.sourceId),
    'ledger placement target ID');
  invariant(normalizeNotionId(placement.targetId, 'placement.targetId') === expectedTargetId,
    'ledger_placement_mismatch', 'Ledger placement не соответствует source→target mapping', {
      kind,
      sourceId: entry.sourceId
    });
  const property = placementProperty(placement.kind);
  invariant(count === 1 && record.properties[property].length === 1 &&
    normalizeNotionId(record.properties[property][0]) === expectedTargetId,
  'placement_not_exact', 'Элемент размещён не в точной целевой связи', {
    kind,
    sourceId: entry.sourceId,
    placement,
    actual: Object.fromEntries(PLACEMENT_PROPERTIES.map((name) => [name, record.properties[name]]))
  });
}

export function assertExactPlacement(target, ledger) {
  for (const entry of Object.values(ledger.entries.sections || {})) {
    assertPlacedEntry(target, ledger, entry, 'section');
  }
  for (const entry of Object.values(ledger.entries.knowledge || {})) {
    assertPlacedEntry(target, ledger, entry, 'knowledge');
  }
  return true;
}
