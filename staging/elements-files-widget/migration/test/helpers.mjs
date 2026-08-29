import { ELEMENTS_SCHEMA_CONTRACT } from '../lib/schema.mjs';

function id(number) {
  return BigInt(number).toString(16).padStart(32, '0');
}

export const IDS = Object.freeze({
  sourceWorkspace: id(1),
  sourceTasksDataSource: id(2),
  sourceKnowledgeDataSource: id(3),
  sourceSphere: id(4),
  sourceDirection: id(5),
  sourceProject: id(6),
  sandboxWorkspace: 'a'.repeat(32),
  sandboxParent: 'b'.repeat(32),
  elementsDataSource: 'c'.repeat(32),
  sandboxSphere: 'd'.repeat(32),
  sandboxDirection: 'e'.repeat(32),
  sandboxProject: 'f'.repeat(32)
});

export function makeSourceSnapshot({ taskCount = 128, sectionCount = 0, knowledgeCount = 16 } = {}) {
  const tasks = Array.from({ length: taskCount }, (_, index) => ({
    id: id(0x1000 + index),
    title: `Task ${index + 1}`,
    ...(index > 0 && index % 3 === 0 ? { insideSourceTaskId: id(0x1000 + index - 1) } : {}),
    position: index + 1
  }));
  const sections = Array.from({ length: sectionCount }, (_, index) => ({
    id: id(0x1800 + index),
    title: `Section ${index + 1}`,
    ...(index === 0
      ? { sourceTaskId: tasks[0].id }
      : { sourceSectionId: id(0x1800 + index - 1) }),
    position: index + 1
  }));
  const widgetSections = ['Drive', 'Docs', 'Sheets', 'Slides'];
  const knowledge = Array.from({ length: knowledgeCount }, (_, index) => ({
    id: id(0x2000 + index),
    title: `Knowledge ${index + 1}`,
    sourceTaskId: tasks[(index * 7) % tasks.length].id,
    provider: 'External URL',
    section: widgetSections[index % widgetSections.length],
    fileFormat: 'External URL',
    url: `https://example.test/knowledge/${index + 1}`,
    position: index + 1,
    syncStatus: 'synced'
  }));
  return {
    version: 2,
    source: {
      readOnly: true,
      workspaceId: IDS.sourceWorkspace,
      tasksDataSourceId: IDS.sourceTasksDataSource,
      knowledgeDataSourceId: IDS.sourceKnowledgeDataSource
    },
    relationMaps: { sphere: {}, direction: {}, project: {} },
    tasks,
    sections,
    knowledge
  };
}

export function makeSchema(dataSourceId = IDS.elementsDataSource) {
  return {
    dataSourceId,
    properties: Object.fromEntries(Object.entries(ELEMENTS_SCHEMA_CONTRACT).map(([name, contract]) => [name, {
      type: contract.type,
      ...(contract.options ? { options: [...contract.options] } : {}),
      ...(contract.selfRelation ? { dataSourceId } : {})
    }]))
  };
}

export function makeTargetState() {
  return {
    version: 1,
    dataSourceId: IDS.elementsDataSource,
    schema: makeSchema(),
    records: []
  };
}

export function makeEnv(overrides = {}) {
  return {
    APP_ENV: 'staging',
    SANDBOX_WORKSPACE_ID: IDS.sandboxWorkspace,
    SANDBOX_PARENT_PAGE_ID: IDS.sandboxParent,
    ELEMENTS_DATA_SOURCE_ID: IDS.elementsDataSource,
    ORIGINAL_DENYLIST_IDS: [
      IDS.sourceWorkspace,
      IDS.sourceTasksDataSource,
      IDS.sourceKnowledgeDataSource
    ].join(','),
    MIGRATION_EXPECTED_SECTIONS: '0',
    WRITE_GATE: 'closed',
    DRY_RUN: 'true',
    ...overrides
  };
}
