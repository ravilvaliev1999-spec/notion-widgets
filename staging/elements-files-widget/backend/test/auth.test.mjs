import test from 'node:test';
import assert from 'node:assert/strict';
import { issueTaskToken, signToken, verifyToken } from '../lib/auth.mjs';

const secret = '0123456789abcdef0123456789abcdef';
const taskId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const dataSourceId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

test('task token round-trips and is scoped to one task', () => {
  const token = issueTaskToken(taskId, dataSourceId, secret, 60);
  const payload = verifyToken(token, secret, { aud: 'widget', taskId });
  assert.equal(payload.taskId, taskId);
  assert.equal(payload.dataSourceId, dataSourceId);
  assert.throws(() => verifyToken(token, secret, { aud: 'widget', taskId: 'cccccccccccccccccccccccccccccccc' }), { code: 'wrong_task' });
});

test('tampered and expired tokens fail closed', () => {
  const token = issueTaskToken(taskId, dataSourceId, secret, 60);
  assert.throws(() => verifyToken(token + 'x', secret, { aud: 'widget' }), { code: 'invalid_token' });
  const expired = signToken({ aud: 'widget', taskId }, secret, -1);
  assert.throws(() => verifyToken(expired, secret, { aud: 'widget' }), { code: 'expired_token' });
});
