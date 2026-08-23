import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHORIZED_MAIN, loadConfig } from '../lib/config.mjs';
import { createApplication } from '../server.mjs';
import { ELEMENTS_RUNTIME_SCHEMA_CONTRACT, FORMULA_EXPRESSIONS, WIDGET_PROPERTY, WIDGET_SCHEMA_CONTRACT } from '../lib/schema.mjs';

const config = loadConfig({
  APP_ENV: 'staging', TARGET_PROFILE: 'authorized-main',
  STAGING_DRIVE_FOLDER_ID: 'drive-staging-folder', STAGING_DRIVE_MARKER: 'marker',
  GOOGLE_EXPECTED_ACCOUNT_EMAIL: 'staging@example.test', WRITE_GATE: 'closed', DRY_RUN: 'true'
}, { allowMissingSecrets: true });

function property(expected) {
  if (expected.type === 'select') {
    return { type: 'select', select: { options: (expected.options || expected.requiredOptions).map((name) => ({ name })) } };
  }
  return { type: expected.type, [expected.type]: {} };
}

function relation(target, limit) {
  return { type: 'relation', relation: { data_source_id: target, ...(limit ? { max_items: limit } : {}) } };
}

function elementsDataSource() {
  const properties = Object.fromEntries(Object.entries({ ...WIDGET_SCHEMA_CONTRACT, ...ELEMENTS_RUNTIME_SCHEMA_CONTRACT })
    .map(([name, expected]) => [name, property(expected)]));
  Object.assign(properties, {
    'Внутри': relation(config.elementsDataSourceId),
    '3. Проекты': relation(config.projectsDataSourceId),
    'Parent item': relation(config.elementsDataSourceId, 1),
    'Знание: Сфера': relation(config.spheresDataSourceId),
    'Знание: Направление': relation(config.directionsDataSourceId),
    'Знание: Проект': relation(config.projectsDataSourceId),
    '[SYS] Контекст: Сфера': relation(config.spheresDataSourceId),
    '[SYS] Контекст: Направление': relation(config.directionsDataSourceId),
    '[SYS] Контекст: Проект': relation(config.projectsDataSourceId)
  });
  for (const [name, expression] of Object.entries(FORMULA_EXPRESSIONS)) {
    properties[name].formula.expression = expression;
  }
  return {
    id: config.elementsDataSourceId,
    parent: { database_id: config.authorizedElementsDatabaseId },
    properties
  };
}

function contextSources() {
  return {
    [config.spheresDataSourceId]: { id: config.spheresDataSourceId, properties: { Name: { type: 'title', title: {} } } },
    [config.directionsDataSourceId]: { id: config.directionsDataSourceId, properties: { Name: { type: 'title', title: {} } } },
    [config.projectsDataSourceId]: {
      id: config.projectsDataSourceId,
      properties: {
        Name: { type: 'title', title: {} },
        '2.Направления': relation(config.directionsDataSourceId, 1),
        '1.Cферы': relation(config.spheresDataSourceId, 1)
      }
    }
  };
}

function canaryMaterial(knowledgeKeySuffix = '') {
  const task = '3ae2d627-39a1-80ad-b49c-e028699b75d9';
  const googleFileId = 'drive-canary-file';
  return {
    id: config.authorizedCanaryMaterialPageId,
    parent: { data_source_id: config.elementsDataSourceId },
    properties: {
      'Тип': { select: { name: 'Знание' } },
      'Внутри': { relation: [{ id: config.authorizedCanaryTaskPageId }], has_more: false },
      [WIDGET_PROPERTY.googleFileId]: { rich_text: [{ plain_text: googleFileId }] },
      [WIDGET_PROPERTY.taskPageId]: { formula: { type: 'string', string: task } },
      [WIDGET_PROPERTY.knowledgeKey]: { formula: { type: 'string', string: `${task}|g|${googleFileId}${knowledgeKeySuffix}` } }
    }
  };
}

function application({ corruptProject = false, corruptCanary = false, omitExpressions = false } = {}) {
  const sources = contextSources();
  if (corruptProject) sources[config.projectsDataSourceId].properties['1.Cферы'] = relation(config.directionsDataSourceId);
  const elements = elementsDataSource();
  if (omitExpressions) {
    for (const name of Object.keys(FORMULA_EXPRESSIONS)) delete elements.properties[name].formula.expression;
  }
  const dataSources = { [config.elementsDataSourceId]: elements, ...sources };
  const calls = { dataSources: [], pages: [] };
  const notion = {
    retrieveDatabase: async (id) => ({ id, data_sources: [{ id: config.elementsDataSourceId }] }),
    retrieveDataSource: async (id) => { calls.dataSources.push(id); return dataSources[id]; },
    retrievePage: async (id) => { calls.pages.push(id); return canaryMaterial(corruptCanary ? '-corrupt' : ''); }
  };
  return {
    calls,
    app: createApplication(config, { notion, drive: {}, records: {}, logger: { info() {}, warn() {}, error() {} } })
  };
}

test('runtime preflight fetches all four exact data sources and exact canary outputs', async () => {
  const { app, calls } = application();
  await app.targetPreflight();
  assert.deepEqual(new Set(calls.dataSources), new Set([
    config.elementsDataSourceId, config.spheresDataSourceId, config.directionsDataSourceId, config.projectsDataSourceId
  ]));
  assert.deepEqual(calls.pages, [config.authorizedCanaryMaterialPageId]);
});

test('runtime preflight fails closed when formula expressions are not exposed', async () => {
  const hidden = application({ omitExpressions: true });
  await assert.rejects(hidden.app.targetPreflight(), { code: 'formula_expression_unavailable' });
  assert.deepEqual(hidden.calls.pages, []);
});

test('runtime preflight fails before mutations on a corrupt context relation or canary formula output', async () => {
  const corruptRelation = application({ corruptProject: true });
  await assert.rejects(corruptRelation.app.targetPreflight(), { code: 'wrong_relation_target' });
  assert.deepEqual(corruptRelation.calls.pages, []);

  const corruptFormula = application({ corruptCanary: true });
  await assert.rejects(corruptFormula.app.targetPreflight(), { code: 'wrong_knowledge_key_formula_output' });
  assert.deepEqual(corruptFormula.calls.pages, [config.authorizedCanaryMaterialPageId]);
});
