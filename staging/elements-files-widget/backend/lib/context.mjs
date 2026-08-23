import { AppError, invariant } from './errors.mjs';
import {
  assertAuthorizedTask,
  pageParentDataSource,
  propertyRelation,
  propertyText
} from './notion.mjs';
import { normalizeId } from './config.mjs';
import { P } from './records.mjs';

const PROJECT_DIRECTIONS = '2.Направления';
const PROJECT_SPHERES = '1.Cферы';
const MAX_TASK_DEPTH = 20;

function contextFailure(reason, message, details = {}) {
  throw new AppError(409, 'context_error', message, {
    syncStatus: 'needs_review',
    integrity: 'context_error',
    reason,
    ...details
  });
}

function exactRelation(page, propertyName, { required = false } = {}) {
  const property = page?.properties?.[propertyName];
  if (property?.has_more === true) {
    contextFailure('relation_has_more', `Связь «${propertyName}» содержит скрытые дополнительные значения`, {
      pageId: normalizeId(page?.id), property: propertyName
    });
  }
  const ids = propertyRelation(property).map(normalizeId).filter(Boolean);
  if (ids.length > 1) {
    contextFailure('ambiguous_relation', `Связь «${propertyName}» должна содержать не более одного значения`, {
      pageId: normalizeId(page?.id), property: propertyName, count: ids.length
    });
  }
  if (required && ids.length !== 1) {
    contextFailure('missing_relation', `Связь «${propertyName}» должна содержать ровно одно значение`, {
      pageId: normalizeId(page?.id), property: propertyName, count: ids.length
    });
  }
  return ids[0] || '';
}

function assertEntity(page, expectedDataSourceId, kind) {
  invariant(page && page.in_trash !== true && page.archived !== true, 409, 'context_error',
    `${kind} контекста находится в корзине или архиве`, {
      syncStatus: 'needs_review', integrity: 'context_error', reason: 'context_entity_inactive', pageId: normalizeId(page?.id)
    });
  invariant(pageParentDataSource(page) === normalizeId(expectedDataSourceId), 409, 'context_error',
    `${kind} контекста находится вне утверждённого data source`, {
      syncStatus: 'needs_review', integrity: 'context_error', reason: 'context_entity_outside_allowlist', pageId: normalizeId(page?.id)
    });
}

function pageName(page, fallback) {
  return propertyText(page?.properties?.Name) || fallback;
}

/**
 * Resolves the effective Project -> Direction -> Sphere placement for a task.
 * Parent item is used only for task inheritance; the created Knowledge record
 * remains directly related to the requested child task.
 */
export async function resolveTaskContext(taskPage, notion, config) {
  assertAuthorizedTask(taskPage, config.elementsDataSourceId);
  const targetTaskId = normalizeId(taskPage.id);
  const seen = new Set();
  const taskChain = [];
  let cursor = taskPage;
  let projectId = '';

  for (let depth = 0; depth <= MAX_TASK_DEPTH; depth += 1) {
    const cursorId = normalizeId(cursor.id);
    if (seen.has(cursorId)) {
      contextFailure('task_parent_cycle', 'В иерархии задач обнаружен цикл', { taskId: targetTaskId, pageId: cursorId });
    }
    seen.add(cursorId);
    if (depth === 0) {
      assertAuthorizedTask(cursor, config.elementsDataSourceId);
    } else {
      try { assertAuthorizedTask(cursor, config.elementsDataSourceId); }
      catch (error) {
        contextFailure('invalid_parent_task', 'Parent item не является активной задачей утверждённой DS «Элементы»', {
          taskId: targetTaskId, pageId: cursorId, cause: error?.code
        });
      }
    }
    taskChain.push({ id: cursorId, name: pageName(cursor, 'Task') });

    projectId = exactRelation(cursor, P.taskProjects);
    if (projectId) break;

    const parentId = exactRelation(cursor, P.parentItem);
    if (!parentId) {
      contextFailure('context_project_missing', 'У задачи и её родителей не найден однозначный проект', {
        taskId: targetTaskId, depth
      });
    }
    if (depth === MAX_TASK_DEPTH) {
      contextFailure('task_parent_depth_exceeded', 'Иерархия задач превышает безопасную глубину', {
        taskId: targetTaskId, maxDepth: MAX_TASK_DEPTH
      });
    }
    cursor = await notion.retrievePage(parentId);
  }

  const project = await notion.retrievePage(projectId);
  assertEntity(project, config.projectsDataSourceId, 'Проект');
  const directionId = exactRelation(project, PROJECT_DIRECTIONS, { required: true });
  const sphereId = exactRelation(project, PROJECT_SPHERES, { required: true });

  const [direction, sphere] = await Promise.all([
    notion.retrievePage(directionId),
    notion.retrievePage(sphereId)
  ]);
  assertEntity(direction, config.directionsDataSourceId, 'Направление');
  assertEntity(sphere, config.spheresDataSourceId, 'Сфера');

  const hierarchy = [
    { id: sphereId, name: pageName(sphere, 'Sphere') },
    { id: directionId, name: pageName(direction, 'Direction') },
    { id: projectId, name: pageName(project, 'Project') },
    ...taskChain.slice().reverse()
  ];

  return {
    sphereId,
    directionId,
    projectId,
    path: hierarchy.map((entry) => entry.name).join(' / '),
    ancestorIds: JSON.stringify(hierarchy.slice(0, -1).map((entry) => entry.id)),
    depth: taskChain.length - 1,
    updatedAt: new Date(),
    status: 'synced',
    integrity: 'ok',
    syncError: ''
  };
}
