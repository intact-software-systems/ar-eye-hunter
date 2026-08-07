import { describe, expect, it } from 'vitest';

import { computeAuthMutation } from '@shared-server/rallar-system/auth/mutation/compute/compute-auth-mutation.ts';

const session = {
  clientId: 'client-1',
  username: 'alice',
  sessionId: 'session-1',
  accessTokenDigest: 'access-token-digest',
  issuedAtEpochMs: 1_000,
  expiresAtEpochMs: 2_000,
} as const;
const command = {
  version: 1,
  kind: 'logout-session',
  requestId: 'logout-request',
  capturedAtEpochMs: 1_001,
  expected: session,
} as const;

describe('auth logout outbox', () => {
  it('preserves the exact logout outbox and omits it for an absent-session no-op', () => {
    const computed = computeAuthMutation({
      command,
      read: {
        kind: 'logout-session',
        byToken: entry(session, 'token-digest=access-token-digest'),
        bySession: entry(session, 'session=session-1'),
        expiredByTokenEntry: null,
        expiredBySessionEntry: null,
      },
      facts: { kind: command.kind },
      serviceId: 'auth-service',
    });
    const outbox = computed.logoutOutbox;
    if (!outbox) throw new Error('Expected logout outbox');

    expect(Object.keys(outbox)).toEqual([
      'key',
      'resource',
      'typeId',
      'status',
      'audit',
      'dequeueAudit',
    ]);
    expect(outbox.key).toEqual({
      topicId: 'auth.session.logout',
      resourceId: 'logout-request',
      contextId: 'session-1',
    });
    expect(outbox.resource).toBe(
      '{"id":{"v":2,"msgId":"auth-logout:logout-request","ts":1001,"senderId":"auth-service"},"route":{"topicId":"auth.session.logout","resourceId":"logout-request","contextId":"session-1"},"targets":{"mode":"unicast","toPeerId":"session-1"},"constraints":{"expiresAtMs":2000},"payload":{"typeId":"auth.session.logout.v1","contentType":"application/json","resource":"{\\"sessionId\\":\\"session-1\\",\\"closeCode\\":1000,\\"reason\\":\\"auth-logout\\"}"},"audit":{"createdBy":"auth-service","createdTs":1001}}',
    );
    expect(outbox.typeId).toBe('WS_OUTBOX');
    expect(outbox.status).toBe('NEW');
    expect(Object.keys(outbox.audit)).toEqual(['date', 'createdBy', 'createdTs', 'expiryTs']);
    expect(outbox.audit.createdBy).toBe('auth-service');
    expect(outbox.audit.createdTs.toString()).toBe('1970-01-01T00:00:01.001');
    expect(outbox.audit.expiryTs.toString()).toBe('1970-01-01T00:00:02Z');
    expect(outbox.dequeueAudit).toEqual({ attempts: 0 });

    const noOp = computeAuthMutation({
      command,
      read: {
        kind: 'logout-session',
        byToken: null,
        bySession: null,
        expiredByTokenEntry: null,
        expiredBySessionEntry: null,
      },
      facts: { kind: command.kind },
      serviceId: 'auth-service',
    });

    expect(noOp.outcome).toBe('no-op');
    expect(noOp.logoutOutbox).toBeNull();
  });
});

function entry<T>(value: T, key: string) {
  return {
    entry: {
      key,
      value: JSON.stringify(value),
      expireAtTimestamp: 2_000,
      updatedTimestamp: '1970-01-01T00:00:01.000Z',
      revision: 0,
    },
    value,
  };
}
