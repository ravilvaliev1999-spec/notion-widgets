import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { link, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { makeEnv, makeSourceSnapshot, makeTargetState } from './helpers.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));

async function fixtureFiles(snapshot = makeSourceSnapshot()) {
  const directory = await mkdtemp(join(tmpdir(), 'elements-migration-'));
  const source = join(directory, 'source.json');
  const target = join(directory, 'target.json');
  const ledger = join(directory, 'ledger.json');
  await writeFile(source, JSON.stringify(snapshot), 'utf8');
  await writeFile(target, JSON.stringify(makeTargetState()), 'utf8');
  return { directory, source, target, ledger };
}

async function rejectsWithCode(args, env, expectedCode) {
  await assert.rejects(execute(process.execPath, [cli, ...args], { env }), (error) => {
    const output = JSON.parse(error.stderr);
    return output.error.code === expectedCode;
  });
}

test('CLI audit is offline and dry-run by default', async () => {
  const files = await fixtureFiles();
  const { stdout } = await execute(process.execPath, [cli, 'audit', '--source', files.source, '--target', files.target], {
    env: makeEnv()
  });
  const output = JSON.parse(stdout);
  assert.equal(output.ok, true);
  assert.equal(output.mode, 'offline-audit');
  assert.equal(output.dryRun, true);
  assert.deepEqual(output.counts, { tasks: 128, sections: 0, knowledge: 16 });
});

test('CLI apply refuses the default DRY_RUN=true before changing target', async () => {
  const files = await fixtureFiles();
  const before = await readFile(files.target, 'utf8');
  await assert.rejects(execute(process.execPath, [
    cli, 'apply', '--source', files.source, '--target', files.target, '--ledger', files.ledger
  ], { env: makeEnv({ WRITE_GATE: 'open' }) }), (error) => {
    const output = JSON.parse(error.stderr);
    return output.error.code === 'dry_run_enabled';
  });
  assert.equal(await readFile(files.target, 'utf8'), before);
});

test('CLI plan exposes topological sections and generalized placement', async () => {
  const snapshot = makeSourceSnapshot({ sectionCount: 1 });
  delete snapshot.knowledge[0].sourceTaskId;
  snapshot.knowledge[0].sourceSectionId = snapshot.sections[0].id;
  const files = await fixtureFiles(snapshot);
  const { stdout } = await execute(process.execPath, [
    cli, 'plan', '--source', files.source, '--target', files.target
  ], { env: makeEnv({ MIGRATION_EXPECTED_SECTIONS: '1' }) });
  const output = JSON.parse(stdout);
  assert.deepEqual(output.counts, { tasks: 128, sections: 1, knowledge: 16 });
  const section = output.operations.find((operation) => operation.kind === 'section');
  const knowledge = output.operations.find((operation) => operation.kind === 'knowledge' &&
    operation.sourceId === snapshot.knowledge[0].id);
  assert.deepEqual(section.placement, {
    mode: 'direct',
    kind: 'task',
    sourceId: snapshot.tasks[0].id
  });
  assert.deepEqual(knowledge.placement, {
    mode: 'direct',
    kind: 'section',
    sourceId: snapshot.sections[0].id
  });
});

test('CLI offline apply checkpoints ledger and is idempotent on rerun', async () => {
  const files = await fixtureFiles();
  const env = makeEnv({ WRITE_GATE: 'open', DRY_RUN: 'false' });
  let result = await execute(process.execPath, [
    cli, 'apply', '--source', files.source, '--target', files.target, '--ledger', files.ledger
  ], { env });
  let output = JSON.parse(result.stdout);
  assert.equal(output.stats.created, 144);
  assert.equal(output.complete, true);

  result = await execute(process.execPath, [
    cli, 'apply', '--source', files.source, '--target', files.target, '--ledger', files.ledger
  ], { env });
  output = JSON.parse(result.stdout);
  assert.equal(output.stats.created, 0);
  assert.equal(output.stats.skipped, 144);
  const target = JSON.parse(await readFile(files.target, 'utf8'));
  const ledger = JSON.parse(await readFile(files.ledger, 'utf8'));
  assert.equal(target.records.length, 144);
  assert.equal(Object.keys(ledger.entries.knowledge).length, 16);
});

test('CLI resolves a missing target path without mistaking it for the source', async () => {
  const files = await fixtureFiles();
  const missingTarget = join(files.directory, 'new-target.json');
  await rejectsWithCode([
    'audit', '--source', files.source, '--target', missingTarget
  ], makeEnv(), 'ENOENT');
});

test('CLI rejects a case-only source/target alias on Windows', {
  skip: process.platform !== 'win32'
}, async () => {
  const files = await fixtureFiles();
  const caseAlias = join(files.directory, 'SOURCE.JSON');
  await rejectsWithCode([
    'audit', '--source', files.source, '--target', caseAlias
  ], makeEnv(), 'source_write_collision');
});

test('CLI rejects a symlink source/target alias when symlinks are available', async (context) => {
  const files = await fixtureFiles();
  const alias = join(files.directory, 'source-symlink.json');
  try {
    await symlink(files.source, alias, 'file');
  } catch (error) {
    if (error && ['EACCES', 'EPERM', 'ENOSYS'].includes(error.code)) {
      context.skip(`symlinks unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await rejectsWithCode([
    'audit', '--source', files.source, '--target', alias
  ], makeEnv(), 'source_write_collision');
});

test('CLI rejects a hard-linked target/ledger alias before apply', async (context) => {
  const files = await fixtureFiles();
  const ledgerAlias = join(files.directory, 'target-hardlink.json');
  try {
    await link(files.target, ledgerAlias);
  } catch (error) {
    if (error && ['EACCES', 'EPERM', 'ENOSYS', 'EXDEV'].includes(error.code)) {
      context.skip(`hard links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const before = await readFile(files.target, 'utf8');
  await rejectsWithCode([
    'apply', '--source', files.source, '--target', files.target, '--ledger', ledgerAlias
  ], makeEnv({ WRITE_GATE: 'open', DRY_RUN: 'false' }), 'target_ledger_collision');
  assert.equal(await readFile(files.target, 'utf8'), before);
});

test('CLI rejects a hard-linked source/ledger alias before apply', async (context) => {
  const files = await fixtureFiles();
  const ledgerAlias = join(files.directory, 'source-hardlink.json');
  try {
    await link(files.source, ledgerAlias);
  } catch (error) {
    if (error && ['EACCES', 'EPERM', 'ENOSYS', 'EXDEV'].includes(error.code)) {
      context.skip(`hard links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const before = await readFile(files.target, 'utf8');
  await rejectsWithCode([
    'apply', '--source', files.source, '--target', files.target, '--ledger', ledgerAlias
  ], makeEnv({ WRITE_GATE: 'open', DRY_RUN: 'false' }), 'source_write_collision');
  assert.equal(await readFile(files.target, 'utf8'), before);
});

test('CLI rejects a Windows junction alias when junctions are available', {
  skip: process.platform !== 'win32'
}, async (context) => {
  const files = await fixtureFiles();
  const junction = join(files.directory, 'directory-junction');
  try {
    await symlink(files.directory, junction, 'junction');
  } catch (error) {
    if (error && ['EACCES', 'EPERM', 'ENOSYS'].includes(error.code)) {
      context.skip(`junctions unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await rejectsWithCode([
    'audit', '--source', files.source, '--target', join(junction, 'source.json')
  ], makeEnv(), 'source_write_collision');
});
