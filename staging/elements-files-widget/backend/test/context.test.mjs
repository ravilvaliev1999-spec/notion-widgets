import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHORIZED_MAIN } from '../lib/config.mjs';
import { resolveTaskContext } from '../lib/context.mjs';
import { P } from '../lib/records.mjs';

const childId = AUTHORIZED_MAIN.canaryTaskPageId;
const parentId = '11111111111111111111111111111111';
const projectId = '22222222222222222222222222222222';
const directionId = '33333333333333333333333333333333';
const sphereId = '44444444444444444444444444444444';
const config = {
  elementsDataSourceId: AUTHORIZED_MAIN.elementsDataSourceId,
  projectsDataSourceId: AUTHORIZED_MAIN.projectsDataSourceId,
  directionsDataSourceId: AUTHORIZED_MAIN.directionsDataSourceId,
  spheresDataSourceId: AUTHORIZED_MAIN.spheresDataSourceId
};

function relation(ids = [], hasMore = false) {
  return { relation: ids.map((id) => ({ id })), has_more: hasMore };
}

function title(name) {
  return { title: [{ plain_text: name }] };
}

function taskPage(id, { name = 'Task', projects = [], parents = [], projectHasMore = false, parentHasMore = false,
  type = 'Задача', dataSourceId = config.elementsDataSourceId } = {}) {
  return {
    id, archived: false, in_trash: false,
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties: {
      [P.title]: title(name),
      [P.type]: { select: { name: type } },
      [P.taskProjects]: relation(projects, projectHasMore),
      [P.parentItem]: relation(parents, parentHasMore)
    }
  };
}

function contextPages(projectOverrides = {}) {
  return {
    [projectId]: {
      id: projectId, archived: false, in_trash: false,
      parent: { type: 'data_source_id', data_source_id: config.projectsDataSourceId },
      properties: {
        Name: title('Project'),
        '2.Направления': relation([directionId]),
        '1.Cферы': relation([sphereId]),
        ...projectOverrides
      }
    },
    [directionId]: {
      id: directionId, archived: false, in_trash: false,
      parent: { type: 'data_source_id', data_source_id: config.directionsDataSourceId },
      properties: { Name: title('Direction') }
    },
    [sphereId]: {
      id: sphereId, archived: false, in_trash: false,
      parent: { type: 'data_source_id', data_source_id: config.spheresDataSourceId },
      properties: { Name: title('Sphere') }
    }
  };
}

function notionFrom(pages, calls = []) {
  return {
    retrievePage: async (id) => {
      calls.push(id);
      assert.ok(pages[id], `unexpected page ${id}`);
      return pages[id];
    }
  };
}

test('direct task context resolves exact Project -> Direction -> Sphere', async () => {
  const task = taskPage(childId, { name: 'Child', projects: [projectId] });
  const context = await resolveTaskContext(task, notionFrom(contextPages()), config);
  assert.equal(context.projectId, projectId);
  assert.equal(context.directionId, directionId);
  assert.equal(context.sphereId, sphereId);
  assert.equal(context.path, 'Sphere / Direction / Project / Child');
  assert.deepEqual(JSON.parse(context.ancestorIds), [sphereId, directionId, projectId]);
  assert.equal(context.depth, 0);
  assert.equal(context.status, 'synced');
  assert.equal(context.integrity, 'ok');
});

test('subtask inherits one parent project but remains identified as the child', async () => {
  const child = taskPage(childId, { name: 'Child', parents: [parentId] });
  const parent = taskPage(parentId, { name: 'Parent', projects: [projectId] });
  const pages = { [parentId]: parent, ...contextPages() };
  const context = await resolveTaskContext(child, notionFrom(pages), config);
  assert.equal(context.path, 'Sphere / Direction / Project / Parent / Child');
  assert.deepEqual(JSON.parse(context.ancestorIds), [sphereId, directionId, projectId, parentId]);
  assert.equal(context.depth, 1);
  assert.equal(JSON.parse(context.ancestorIds).includes(childId), false);
});

test('ambiguous, truncated, cyclic, and invalid parent context fails as needs_review/context_error', async () => {
  const cases = [
    {
      task: taskPage(childId, { projects: [projectId, '5'.repeat(32)] }),
      pages: contextPages(), reason: 'ambiguous_relation'
    },
    {
      task: taskPage(childId, { projects: [projectId], projectHasMore: true }),
      pages: contextPages(), reason: 'relation_has_more'
    },
    {
      task: taskPage(childId, { parents: [parentId, '5'.repeat(32)] }),
      pages: {}, reason: 'ambiguous_relation'
    },
    {
      task: taskPage(childId, { parents: [parentId] }),
      pages: {
        [parentId]: taskPage(parentId, { parents: [childId] }),
        [childId]: taskPage(childId, { parents: [parentId] })
      }, reason: 'task_parent_cycle'
    },
    {
      task: taskPage(childId, { parents: [parentId] }),
      pages: { [parentId]: taskPage(parentId, { type: 'Знание' }) }, reason: 'invalid_parent_task'
    },
    {
      task: taskPage(childId, { parents: [parentId] }),
      pages: { [parentId]: taskPage(parentId, { dataSourceId: '6'.repeat(32) }) }, reason: 'invalid_parent_task'
    }
  ];

  for (const item of cases) {
    await assert.rejects(resolveTaskContext(item.task, notionFrom(item.pages), config), (error) => {
      assert.equal(error.code, 'context_error');
      assert.equal(error.details.syncStatus, 'needs_review');
      assert.equal(error.details.integrity, 'context_error');
      assert.equal(error.details.reason, item.reason);
      return true;
    });
  }
});

test('project context requires exactly one approved direction and sphere', async () => {
  const task = taskPage(childId, { projects: [projectId] });
  for (const properties of [
    { '2.Направления': relation([]) },
    { '1.Cферы': relation([sphereId, '5'.repeat(32)]) },
    { '2.Направления': relation([directionId], true) }
  ]) {
    await assert.rejects(resolveTaskContext(task, notionFrom(contextPages(properties)), config), (error) => {
      assert.equal(error.code, 'context_error');
      assert.equal(error.details.integrity, 'context_error');
      return true;
    });
  }
});
