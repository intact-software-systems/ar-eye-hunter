import assert from 'node:assert/strict';

import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
// deno-fmt-ignore
import type { CrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/\
crdt-mutation-contracts.ts';

import { createCrdtAdminMutations } from '../../../src/crdt/create-crdt-admin-mutations.ts';

const CAPTURED_AT_EPOCH_MS = 1_700_000_000_000;
const DOCUMENT: RallarCrdtDocumentRef = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  scope: 'room',
  documentType: 'checklist',
  documentId: 'document-1',
  roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' },
};
const ADMIN_SESSION: AuthSession = {
  clientId: 'admin-client',
  accessToken: 'token',
  username: 'admin',
  sessionId: 'admin-session',
  expiresAtEpochMs: CAPTURED_AT_EPOCH_MS + 60_000,
};

Deno.test('CRDT admin commands retain the complete AppInbox retry horizon', async () => {
  const commands: CrdtMutationCommand[] = [];
  const stopAfterCapture = new Error('command captured');
  let nextId = 0;
  const mutations = createCrdtAdminMutations({
    appCrdtInboxService: {
      writeCrdtCommandUntilCompletion: (command: CrdtMutationCommand) => {
        commands.push(command);
        return Promise.reject(stopAfterCapture);
      },
    },
    nowEpochMs: () => CAPTURED_AT_EPOCH_MS,
    createId: () => `generated-${nextId += 1}`,
    serviceId: 'server-1',
  });
  const cases = [
    {
      operation: 'compact' as const,
      request: { document: DOCUMENT, reason: 'maintenance' },
    },
    {
      operation: 'lifecycle' as const,
      request: { document: DOCUMENT, lifecycle: 'archived' },
    },
    {
      operation: 'erase' as const,
      request: { document: DOCUMENT, mode: 'destroy-document', reason: 'privacy' },
    },
  ];

  for (const testCase of cases) {
    await assert.rejects(
      mutations.writeCrdtAdminMutation({
        operation: testCase.operation,
        adminSession: ADMIN_SESSION,
        request: testCase.request,
      }),
      (error) => error === stopAfterCapture,
    );
  }

  assert.deepEqual(commands.map((command) => command.operation), [
    'compact',
    'lifecycle',
    'erase',
  ]);
  for (const command of commands) {
    assert.equal(command.capturedAtEpochMs, CAPTURED_AT_EPOCH_MS);
    assert.equal(
      command.expireAtEpochMs,
      resourceInboxRetryExpiryAtEpochMs(CAPTURED_AT_EPOCH_MS),
    );
    assert.deepEqual(command.actor, {
      actorId: ADMIN_SESSION.clientId,
      principalId: ADMIN_SESSION.username,
      sessionId: ADMIN_SESSION.sessionId,
      serverId: 'server-1',
    });
  }
});

Deno.test('CRDT admin lifecycle rejects its value before exact document validation', async () => {
  let clockReads = 0;
  let inboxWrites = 0;
  const mutations = createCrdtAdminMutations({
    appCrdtInboxService: {
      writeCrdtCommandUntilCompletion: () => {
        inboxWrites += 1;
        throw new Error('invalid command must not reach AppInbox');
      },
    },
    nowEpochMs: () => {
      clockReads += 1;
      return CAPTURED_AT_EPOCH_MS;
    },
    createId: () => 'invalid-lifecycle',
    serviceId: 'server-1',
  });

  await assert.rejects(
    mutations.writeCrdtAdminMutation({
      operation: 'lifecycle',
      adminSession: ADMIN_SESSION,
      request: {
        document: {
          applicationId: 'app-1',
          workspaceId: 'workspace-1',
          scope: 'room',
          documentType: 'checklist',
          documentId: 'document-1',
        },
        lifecycle: 'destroy',
      },
    }),
    (error) => error instanceof TypeError && error.message === 'CRDT lifecycle is invalid',
  );
  assert.equal(clockReads, 1);
  assert.equal(inboxWrites, 0);
});
