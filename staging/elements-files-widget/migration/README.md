# Offline migration harness

This directory is the only supported migration path for the staging
`Elements` data source. It has no HTTP client and cannot call Notion, Drive,
Apps Script, GitHub Pages, or another external service.

## Safety model

- The source is a JSON snapshot marked `source.readOnly=true`.
- The CLI only opens the source with `readFile`; source and output paths may
  not overlap by canonical path or filesystem identity. Case-only aliases on
  Windows, symlinks/junctions, and hardlinks fail before any output write.
- `DRY_RUN` defaults to `true`; `WRITE_GATE` defaults to `closed`.
- `apply` writes only an offline target JSON file and version-2 ledger, and
  requires `APP_ENV=staging`, `WRITE_GATE=open`, and `DRY_RUN=false`.
- `SANDBOX_WORKSPACE_ID`, `SANDBOX_PARENT_PAGE_ID`, and
  `ELEMENTS_DATA_SOURCE_ID` form the required write allowlist.
- Every sandbox page ID used by an external relation map must also be listed in
  `SANDBOX_WRITE_ALLOWLIST_IDS`.
- A relation-map target may never be a source ID, an original denylist ID, or
  an ID outside the sandbox allowlist.
- `ORIGINAL_DENYLIST_IDS` must contain the source workspace, task data source,
  and knowledge data source IDs. Any allowlist/denylist overlap fails closed.
- Defaults enforce exactly 128 tasks, 0 sections, and 16 knowledge records.
  Override only with reviewed `MIGRATION_EXPECTED_TASKS`,
  `MIGRATION_EXPECTED_SECTIONS`, and `MIGRATION_EXPECTED_KNOWLEDGE`.

The CLI does not load `.env` files. Supply environment variables through the
calling process and never put credentials in snapshots or the ledger.

## Elements schema contract

`Тип` has only three configured options:

- `Задача`
- `Знание`
- `Раздел`

Inbox is deliberately represented by a blank `Тип`, not another select
option. An Inbox record has `[SYS] Sync status=needs_review` and no direct
placement.

The four direct-placement properties are:

- `Внутри` — self-relation to a task or section;
- `Знание: Проект`;
- `Знание: Направление`;
- `Знание: Сфера`.

A resolved knowledge/section record must have exactly one of those four
relations. Inbox must have zero. The contract also requires `Архив` as a
checkbox and `Ссылка` as a URL in addition to the widget/system properties.

## Snapshot contract

Version 2 is canonical; version 1 is accepted and normalized to version 2.
IDs below are placeholders.

```json
{
  "version": 2,
  "source": {
    "readOnly": true,
    "workspaceId": "00000000000000000000000000000001",
    "tasksDataSourceId": "00000000000000000000000000000002",
    "knowledgeDataSourceId": "00000000000000000000000000000003"
  },
  "relationMaps": {
    "sphere": {
      "10000000000000000000000000000001": "20000000000000000000000000000001"
    },
    "direction": {},
    "project": {}
  },
  "tasks": [
    {
      "id": "00000000000000000000000000000101",
      "title": "Task"
    }
  ],
  "sections": [
    {
      "id": "00000000000000000000000000000151",
      "title": "Section",
      "sourceTaskId": "00000000000000000000000000000101"
    }
  ],
  "knowledge": [
    {
      "id": "00000000000000000000000000000201",
      "title": "Material",
      "sourceSectionId": "00000000000000000000000000000151",
      "provider": "External URL",
      "section": "Drive",
      "url": "https://example.test/material"
    }
  ]
}
```

External `relationMaps` are source-page-ID to sandbox-page-ID maps for
`sphere`, `direction`, and `project`. They are not optional when the
selected placement uses that level.

### Placement fields and precedence

Knowledge and sections may use scalar or array forms:

- `sourceTaskId` / `sourceTaskIds`;
- `sourceSectionId` / `sourceSectionIds`;
- `sourceProjectId` / `sourceProjectIds`;
- `sourceDirectionId` / `sourceDirectionIds`;
- `sourceSphereId` / `sourceSphereIds`.

`insideSourceTaskId(s)` and `insideSourceSectionId(s)` are accepted aliases
for section placement.

Legacy KB precedence is strict:

1. `Внутри` task/section
2. Project
3. Direction
4. Sphere

Lower levels are inherited context. Thus sphere+direction resolves only to
direction, and direction+project resolves only to project. They never produce
two direct relations.

If the selected level contains multiple distinct IDs, the harness never picks
one and never falls back to a lower level. It creates a blank-Type
`needs_review` Inbox operation. Missing placement follows the same Inbox
path. A selected external ID without a relation map fails the audit.

Sections are topologically ordered. Missing parents, self-parenting, and cycles
fail before target mutation.

## Commands

```powershell
node migration/cli.mjs audit --source source.json --target target.json
node migration/cli.mjs plan --source source.json --target target.json
node migration/cli.mjs apply --source source.json --target target.json --ledger ledger.json
```

`audit` and `plan` never write. `apply` is an offline simulation used to
prove write guards, mapping, idempotency, recovery, and placement invariants
before any separately approved external adapter exists.

## Ledger and idempotency

The version-2 ledger has separate task, section, and knowledge mappings. Each
entry records deterministic idempotency key, source fingerprint, target ID,
and the complete resolved placement:

- direct: source kind/ID plus exact sandbox target ID;
- Inbox: reason, selected level, and ambiguous source IDs.

A rerun skips mapped records. If a target write succeeded before the ledger
checkpoint, the rerun recovers it by deterministic idempotency key. Changed
source content, target drift, another sandbox, an old version-1 ledger, or a
conflicting placement stops the migration instead of creating a duplicate.
