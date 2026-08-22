#!/usr/bin/env node
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { assertSourceSnapshot } from './lib/audit.mjs';
import { assertSandboxSafety, loadMigrationConfig } from './lib/config.mjs';
import { asIssue, invariant } from './lib/errors.mjs';
import { FileLedgerStore } from './lib/ledger.mjs';
import { OfflineTarget } from './lib/offline-target.mjs';
import { buildMigrationPlan } from './lib/plan.mjs';
import { runOfflineMigration } from './lib/runner.mjs';
import { assertElementsSchema } from './lib/schema.mjs';

function usage() {
  return `Usage:
  node migration/cli.mjs audit --source SOURCE.json --target TARGET.json
  node migration/cli.mjs plan  --source SOURCE.json --target TARGET.json
  node migration/cli.mjs apply --source SOURCE.json --target TARGET.json --ledger LEDGER.json

The CLI is offline-only: it reads a source snapshot and never contacts Notion,
Google Drive, GitHub Pages, Apps Script, or any other network service.`;
}

function parseArguments(argv) {
  const [command = 'help', ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    invariant(token.startsWith('--'), 'invalid_argument', `Неизвестный аргумент: ${token}`);
    const key = token.slice(2);
    invariant(['source', 'target', 'ledger'].includes(key), 'invalid_argument', `Неизвестный параметр: --${key}`);
    const value = rest[index + 1];
    invariant(value && !value.startsWith('--'), 'missing_argument_value', `Не задано значение --${key}`);
    options[key] = resolve(value);
    index += 1;
  }
  return { command, options };
}

async function jsonFile(path, label) {
  invariant(path, 'missing_path', `Не задан --${label}`);
  return JSON.parse(await readFile(path, 'utf8'));
}

function comparablePath(path) {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

async function canonicalPath(path) {
  let cursor = resolve(path);
  const missing = [];
  while (true) {
    try {
      return resolve(await realpath(cursor), ...missing);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

async function pathDescriptor(path) {
  const canonical = comparablePath(await canonicalPath(path));
  let identity = null;
  try {
    const metadata = await stat(path, { bigint: true });
    identity = `${metadata.dev}:${metadata.ino}`;
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  return Object.freeze({ canonical, identity });
}

function sameFile(left, right) {
  return left.canonical === right.canonical ||
    (left.identity !== null && right.identity !== null && left.identity === right.identity);
}

async function assertPathIsolation(options, command) {
  invariant(options.source && options.target, 'missing_path', 'Требуются --source и --target');
  const source = await pathDescriptor(options.source);
  const target = await pathDescriptor(options.target);
  invariant(!sameFile(source, target), 'source_write_collision',
    'Source snapshot не может быть target-файлом или его alias');
  if (command === 'apply') {
    invariant(options.ledger, 'missing_path', 'Для apply требуется --ledger');
    const ledger = await pathDescriptor(options.ledger);
    invariant(!sameFile(ledger, source), 'source_write_collision',
      'Ledger не может совпадать с source snapshot или его alias');
    invariant(!sameFile(ledger, target), 'target_ledger_collision',
      'Ledger и target должны быть разными файлами и aliases');
  }
}

function auditOffline(snapshot, target, config) {
  assertSandboxSafety(config, snapshot);
  const sourceAudit = assertSourceSnapshot(snapshot, config);
  assertElementsSchema(target.schema, config.elementsDataSourceId);
  invariant(target.dataSourceId === config.elementsDataSourceId.replace(/[^a-f0-9]/gi, '').toLowerCase(),
    'wrong_target_snapshot', 'Target snapshot относится не к ELEMENTS_DATA_SOURCE_ID');
  return sourceAudit;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const { command, options } = parseArguments(argv);
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  invariant(['audit', 'plan', 'apply'].includes(command), 'invalid_command', `Неизвестная команда: ${command}`);
  await assertPathIsolation(options, command);
  const config = loadMigrationConfig(env);
  const snapshot = await jsonFile(options.source, 'source');
  const target = await OfflineTarget.load(options.target);
  const sourceAudit = auditOffline(snapshot, target, config);

  if (command === 'audit') {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: 'offline-audit',
      dryRun: config.dryRun,
      writeGate: config.writeGate,
      counts: sourceAudit.counts,
      sourceFingerprint: sourceAudit.fingerprint,
      targetRecords: target.records.length
    }, null, 2)}\n`);
    return;
  }

  const plan = buildMigrationPlan(sourceAudit.normalized);
  if (command === 'plan') {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: 'offline-plan',
      dryRun: true,
      sourceFingerprint: sourceAudit.fingerprint,
      counts: { tasks: plan.tasks.length, sections: plan.sections.length, knowledge: plan.knowledge.length },
      operations: [
        ...plan.tasks.map(({ kind, sourceId, parentSourceId, idempotencyKey }) =>
          ({ kind, sourceId, parentSourceId, idempotencyKey })),
        ...plan.sections.map(({ kind, sourceId, placement, idempotencyKey }) =>
          ({ kind, sourceId, placement, idempotencyKey })),
        ...plan.knowledge.map(({ kind, sourceId, placement, idempotencyKey }) =>
          ({ kind, sourceId, placement, idempotencyKey }))
      ]
    }, null, 2)}\n`);
    return;
  }

  const ledgerStore = new FileLedgerStore(options.ledger);
  const existingLedger = await ledgerStore.load();
  const result = await runOfflineMigration({
    snapshot,
    config,
    target,
    ledger: existingLedger,
    onCheckpoint: async ({ target: currentTarget, ledger }) => {
      // Target first, ledger second: if the second write is interrupted, a rerun
      // recovers the target record by deterministic idempotency key.
      await currentTarget.save(options.target);
      await ledgerStore.save(ledger);
    }
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: 'offline-apply',
    counts: {
      tasks: result.plan.tasks.length,
      sections: result.plan.sections.length,
      knowledge: result.plan.knowledge.length
    },
    stats: result.stats,
    complete: result.ledger.complete
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: asIssue(error) }, null, 2)}\n`);
  process.exitCode = 1;
});
