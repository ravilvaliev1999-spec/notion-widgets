import { invariant } from './errors.mjs';

export function normalizeNotionId(value, label = 'Notion ID') {
  const normalized = String(value || '').toLowerCase().replace(/[^a-f0-9]/g, '');
  invariant(normalized.length === 32, 'invalid_notion_id', `${label} должен быть UUID/32-символьным Notion ID`, {
    label
  });
  return normalized;
}

export function normalizeOptionalNotionId(value, label = 'Notion ID') {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  return normalizeNotionId(value, label);
}

export function uniqueNormalizedIds(values, label) {
  const ids = values.map((value, index) => normalizeNotionId(value, `${label}[${index}]`));
  invariant(new Set(ids).size === ids.length, 'duplicate_notion_id', `${label} содержит повторяющиеся ID`);
  return ids;
}
