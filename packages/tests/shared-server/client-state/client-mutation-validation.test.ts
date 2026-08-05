import { describe, expect, it } from 'vitest';

import { ClientMutationRejectedError } from '@shared-server/rallar-system/client-state/client-state-validation-primitives.ts';
import { validateClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-command.ts';
import { validateClientMutationRequest } from '@shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-request.ts';
import {
  ClientMutationRejectedError as LegacyClientMutationRejectedError,
  validateClientMutationCommand as legacyValidateClientMutationCommand,
} from '@shared-server/rallar-system/services/client-state-mutations.ts';

describe('client mutation validation', () => {
  it('preserves request validation order and exact rejection details', () => {
    expectRejected(
      () =>
        validateClientMutationRequest('connectSession', {
          generationId: '',
          unexpected: true,
        }),
      'Client connectSession request.unexpected is not allowed',
    );
    expectRejected(
      () =>
        validateClientMutationRequest('connectSession', {
          generationId: 'generation-1',
          connectedAtEpochMs: 2_000,
          lastHeartbeatAtEpochMs: 1_000,
        }),
      'Client connect lastHeartbeatAtEpochMs must not predate connectedAtEpochMs',
    );
  });

  it('preserves command root-before-input validation order', () => {
    expectRejected(
      () =>
        validateClientMutationCommand({
          operation: 'heartbeatSession',
          commandId: '',
          requestId: null,
          aggregateRef: {},
          facts: {},
          authority: {},
          input: {},
        }),
      'Client mutation commandId must be a non-empty string',
    );
  });

  it('preserves issued-session authority expiry validation', () => {
    expectRejected(
      () =>
        validateClientMutationCommand({
          operation: 'upsertPrincipal',
          commandId: 'command-1',
          requestId: null,
          aggregateRef: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId: 'alice',
          },
          facts: validFacts(),
          authority: {
            kind: 'issued-session',
            version: 1,
            principalId: 'alice',
            sessionId: 'auth-session',
            sessionIssuedAtEpochMs: 2_000,
            sessionExpiresAtEpochMs: 2_000,
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            operation: 'upsertPrincipal',
          },
          input: {},
        }),
      'Client mutation authority expiry must follow issuance',
    );
  });

  it('keeps the legacy validator and error constructor identities canonical', () => {
    expect(legacyValidateClientMutationCommand).toBe(validateClientMutationCommand);
    expect(LegacyClientMutationRejectedError).toBe(ClientMutationRejectedError);
  });

  it('keeps closed mutation inventories owned by the lower contract module', async () => {
    const contracts =
      (await import('@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts')) as Record<
        string,
        unknown
      >;
    const compatibility =
      (await import('@shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-operation-input.ts')) as Record<
        string,
        unknown
      >;

    for (const [inventory, values] of [
      [
        'CLIENT_MUTATION_OPERATIONS',
        [
          'upsertPrincipal',
          'upsertInstance',
          'connectSession',
          'connectAuthorisedWsSession',
          'heartbeatSession',
          'disconnectSession',
          'disconnectAuthorisedWsSession',
          'expireSession',
        ],
      ],
      ['CLIENT_PRINCIPAL_STATUSES', ['active', 'disabled', 'deleted']],
      ['CLIENT_INSTANCE_STATUSES', ['active', 'revoked', 'retired']],
      ['CLIENT_SESSION_STATUSES', ['active', 'disconnected', 'expired']],
      ['CLIENT_PRESENCE_STATES', ['online', 'offline', 'away', 'busy']],
      ['CLIENT_PLATFORMS', ['web', 'ios', 'android', 'desktop', 'server', 'unknown']],
      ['CLIENT_TRANSPORTS', ['ws', 'http', 'rtc', 'unknown']],
      [
        'CLIENT_EVENT_TYPES',
        [
          'principal-created',
          'principal-updated',
          'principal-disabled',
          'principal-deleted',
          'instance-registered',
          'instance-updated',
          'instance-revoked',
          'session-authenticated',
          'session-connected',
          'session-heartbeat',
          'session-disconnected',
          'session-expired',
        ],
      ],
    ] as const) {
      expect(contracts[inventory], inventory).toBeDefined();
      expect([...(contracts[inventory] as ReadonlySet<string>)], inventory).toEqual(values);
      expect(compatibility[inventory], inventory).toBe(contracts[inventory]);
    }
  });
});

function expectRejected(action: () => void, message: string): void {
  try {
    action();
    throw new Error('Expected client mutation rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(ClientMutationRejectedError);
    expect(error).toMatchObject({
      name: 'ClientMutationRejectedError',
      code: 'client-mutation-rejected',
      status: 400,
      message,
    });
  }
}

function validFacts() {
  return {
    nowEpochMs: 1_000,
    serviceId: 'client-state',
    eventId: 'event-1',
    commandHash: `sha256:${'0'.repeat(64)}`,
    attemptCount: 1,
    expireAtEpochMs: 2_000,
  };
}
