import { AppError, invariant } from './errors.mjs';
import { normalizeId } from './config.mjs';

const API = 'https://api.notion.com/v1';

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1000, 30_000);
  return Math.min(500 * (2 ** attempt), 8000) + Math.floor(Math.random() * 250);
}

function errorMessage(payload, fallback) {
  return payload && typeof payload.message === 'string' ? payload.message : fallback;
}

export class NotionClient {
  constructor(config, fetchImpl = fetch) {
    this.token = config.notionToken;
    this.version = config.notionVersion;
    this.fetch = fetchImpl;
  }

  async request(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const retrySafe = options.retrySafe === true || method === 'GET';
    const { retrySafe: _retrySafe, ...fetchOptions } = options;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let response;
      try {
        response = await this.fetch(API + path, {
          ...fetchOptions,
          signal: fetchOptions.signal || AbortSignal.timeout(15_000),
          headers: {
            Authorization: 'Bearer ' + this.token,
            'Notion-Version': this.version,
            'Content-Type': 'application/json',
            ...(fetchOptions.headers || {})
          }
        });
      } catch (error) {
        if (!retrySafe || attempt === 4) throw new AppError(502, 'notion_network_error', 'Notion API недоступен после повторных попыток');
        await wait(retryDelay(null, attempt));
        continue;
      }
      const text = await response.text();
      let payload = null;
      if (text) {
        try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
      }
      if (response.ok) return payload;
      if (retrySafe && (response.status === 429 || response.status >= 500) && attempt < 4) {
        await wait(retryDelay(response, attempt));
        continue;
      }
      throw new AppError(response.status, 'notion_api_error', errorMessage(payload, 'Ошибка Notion API'), {
        notionCode: payload && payload.code,
        requestId: response.headers.get('x-request-id') || undefined
      });
    }
    throw new AppError(502, 'notion_api_error', 'Notion API недоступен');
  }

  retrievePage(pageId) {
    return this.request('/pages/' + normalizeId(pageId));
  }

  createPage(dataSourceId, properties, children = []) {
    return this.request('/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { type: 'data_source_id', data_source_id: normalizeId(dataSourceId) },
        properties,
        ...(children.length ? { children } : {})
      })
    });
  }

  updatePage(pageId, properties) {
    return this.request('/pages/' + normalizeId(pageId), {
      method: 'PATCH',
      body: JSON.stringify({ properties }),
      retrySafe: true
    });
  }

  trashPage(pageId) {
    return this.request('/pages/' + normalizeId(pageId), {
      method: 'PATCH',
      body: JSON.stringify({ in_trash: true }),
      retrySafe: true
    });
  }

  appendBlockChildren(blockId, children) {
    return this.request('/blocks/' + normalizeId(blockId) + '/children', {
      method: 'PATCH',
      body: JSON.stringify({ children })
    });
  }

  updateEmbedBlock(blockId, url) {
    return this.request('/blocks/' + normalizeId(blockId), {
      method: 'PATCH',
      body: JSON.stringify({ embed: { url } }),
      retrySafe: true
    });
  }

  trashBlock(blockId) {
    return this.request('/blocks/' + normalizeId(blockId), { method: 'DELETE', retrySafe: true });
  }

  async listBlockChildren(blockId) {
    const rows = [];
    let cursor;
    do {
      const suffix = new URLSearchParams({ page_size: '100', ...(cursor ? { start_cursor: cursor } : {}) });
      const page = await this.request('/blocks/' + normalizeId(blockId) + '/children?' + suffix.toString());
      rows.push(...(page.results || []));
      cursor = page.has_more ? page.next_cursor : undefined;
    } while (cursor);
    return rows;
  }

  async queryDataSource(dataSourceId, body = {}) {
    const rows = [];
    let cursor;
    do {
      const page = await this.request('/data_sources/' + normalizeId(dataSourceId) + '/query', {
        method: 'POST',
        body: JSON.stringify({ ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
        retrySafe: true
      });
      rows.push(...(page.results || []));
      cursor = page.has_more ? page.next_cursor : undefined;
    } while (cursor);
    return rows;
  }
}

export function titleValue(text) {
  return { title: [{ type: 'text', text: { content: String(text).slice(0, 2000) } }] };
}

export function richTextValue(text) {
  if (text === null || text === undefined || text === '') return { rich_text: [] };
  return { rich_text: [{ type: 'text', text: { content: String(text).slice(0, 2000) } }] };
}

export function selectValue(name) {
  return name ? { select: { name: String(name) } } : { select: null };
}

export function relationValue(ids) {
  return { relation: (ids || []).map((id) => ({ id: normalizeId(id) })) };
}

export function dateValue(value) {
  return value ? { date: { start: new Date(value).toISOString() } } : { date: null };
}

export function pageParentDataSource(page) {
  const parent = page && page.parent;
  return normalizeId(parent && (parent.data_source_id || parent.database_id));
}

export function propertyText(property) {
  const items = property && (property.title || property.rich_text);
  return Array.isArray(items) ? items.map((item) => item.plain_text || item.text?.content || '').join('') : '';
}

export function propertySelect(property) {
  return property && property.select ? property.select.name : '';
}

export function propertyNumber(property) {
  return property && typeof property.number === 'number' ? property.number : null;
}

export function propertyRelation(property) {
  return property && Array.isArray(property.relation) ? property.relation.map((item) => item.id) : [];
}

export function assertSandboxTask(page, expectedDataSourceId) {
  invariant(page && page.in_trash !== true && page.archived !== true, 410, 'task_in_trash', 'Задача находится в корзине или архиве');
  invariant(pageParentDataSource(page) === normalizeId(expectedDataSourceId), 403, 'task_outside_sandbox', 'Задача не принадлежит sandbox «Элементы»');
  invariant(propertySelect(page.properties && page.properties['Тип']) === 'Задача', 422, 'not_a_task', 'Страница не является задачей');
}
