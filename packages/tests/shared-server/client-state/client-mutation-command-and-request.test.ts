import { describe, expect, it } from 'vitest';

import type { StateScope } from '@shared/api/state-types.ts';
import {
  toClientMutationCommand,
  toConnectCommandInput,
  toExpiryCommandInput,
  toUpsertPrincipalCommandInput,
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import {
  toClientMutationIssuedSessionAuthority,
  toClientMutationSystemAuthority,
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import { hashMutationCommand } from '@shared-server/rallar-system/services/mutation-command-identity.ts';
import {
  toClientMutationCommand as legacyToClientMutationCommand,
  toConnectCommandInput as legacyToConnectCommandInput,
} from '@shared-server/rallar-system/services/client-state-service.ts';

const scope: StateScope = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
};

describe('client mutation command and request projection', () => {
  it('preserves principal defaults, omissions, and owned collection clones', () => {
    const roles = ['member'];
    const metadata = { theme: 'dark', nested: { enabled: true } };
    const command = toUpsertPrincipalCommandInput(
      scope,
      'alice',
      { username: 'alice', roles, metadata },
      'fallback-command',
    );

    roles.push('admin');
    metadata.nested.enabled = false;

    expect(command).toEqual({
      operation: 'upsertPrincipal',
      aggregateRef: { ...scope, principalId: 'alice' },
      commandId: 'fallback-command',
      requestId: null,
      input: {
        username: 'alice',
        displayName: null,
        avatarUrl: null,
        status: null,
        authProvider: null,
        externalSubjectId: null,
        roles: ['member'],
        metadata: { theme: 'dark', nested: { enabled: true } },
        lastSeenAtEpochMs: null,
        actorPrincipalId: null,
        actorSessionId: null,
        reason: null,
        traceId: null,
      },
    });
  });

  it('hashes the exact input and authority before adding persisted facts', async () => {
    const input = toConnectCommandInput(
      'connectSession',
      scope,
      'alice',
      'browser',
      'session-1',
      { generationId: 'generation-1', requestId: 'connect-1' },
      'fallback-command',
      { capabilities: ['rtc'], principalRoles: ['member'] },
    );
    const authority = toClientMutationIssuedSessionAuthority(
      {
        clientId: 'alice',
        sessionId: 'auth-session',
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: 9_000,
      },
      scope,
      'connectSession',
    );
    const facts = {
      nowEpochMs: 2_000,
      serviceId: 'client-state',
      eventId: 'event-1',
      attemptCount: 1,
      expireAtEpochMs: 10_000,
    };

    const command = await toClientMutationCommand(input, facts, authority);

    expect(command.facts).toEqual({
      ...facts,
      commandHash: await hashMutationCommand({ ...input, authority }),
    });
    expect(command.input.instanceCapabilities).toEqual(['rtc']);
    expect(command.input.principalRoles).toEqual(['member']);
  });

  it('preserves deterministic expiry identity and system authority', () => {
    expect(
      toExpiryCommandInput({
        ...scope,
        principalId: 'alice',
        clientInstanceId: 'browser',
        sessionId: 'session-1',
        generationId: 'generation-1',
        generationVersion: 3,
        observedExpiresAtEpochMs: 12_000,
      }),
    ).toMatchObject({
      operation: 'expireSession',
      commandId: 'expire-client-session:session-1:generation-1:3:12000',
      requestId: 'expire-client-session:session-1:generation-1:3:12000',
      input: {
        expiresAtEpochMs: 12_000,
        actorPrincipalId: 'alice',
        actorSessionId: 'session-1',
        reason: 'expired',
      },
    });
    expect(toClientMutationSystemAuthority('client-state')).toEqual({
      kind: 'system',
      version: 1,
      serviceId: 'client-state',
      operation: 'expireSession',
    });
  });

  it('keeps legacy command exports as the canonical function identities', () => {
    expect(legacyToClientMutationCommand).toBe(toClientMutationCommand);
    expect(legacyToConnectCommandInput).toBe(toConnectCommandInput);
  });
});
