import { describe, expect, it } from 'vitest';

import { ClientMutationRejectedError } from '@shared-server/rallar-system/client-state/client-state-validation-primitives.ts';
import type {
    ClientMutationCommand,
    ClientMutationFacts,
    ClientMutationRead
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import { validateClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-command.ts';
import { validateClientMutationRequest } from '@shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-request.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { validateClientMutation } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts';

import { deepFreeze } from './client-mutation-concurrency-test-runtime.ts';
import {
    clientMutationPrincipalRef as principalRef,
    emptyClientMutationRead,
    validAuthority,
    validAuthoritySession
} from './client-mutation-validation-test-fixtures.ts';

describe('client mutation validation', () => {
    it('preserves request validation order and exact rejection details', () => {
        expectRejected(
            () =>
                validateClientMutationRequest('connectSession', {
                    generationId: '',
                    unexpected: true
                }),
            'Client connectSession request.unexpected is not allowed'
        );
        expectRejected(
            () =>
                validateClientMutationRequest('connectSession', {
                    generationId: 'generation-1',
                    connectedAtEpochMs: 2_000,
                    lastHeartbeatAtEpochMs: 1_000
                }),
            'Client connect lastHeartbeatAtEpochMs must not predate connectedAtEpochMs'
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
                    input: {}
                }),
            'Client mutation commandId must be a non-empty string'
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
                        principalId: 'alice'
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
                        operation: 'upsertPrincipal'
                    },
                    input: {}
                }),
            'Client mutation authority expiry must follow issuance'
        );
    });

    it('keeps closed mutation inventories owned by the contract module', async () => {
        const contracts = (await import('@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts')) as Record<string, unknown>;

        for (
            const [inventory, values] of [
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
                        'expireSession'
                    ]
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
                        'session-expired'
                    ]
                ]
            ] as const
        ) {
            expect(contracts[inventory], inventory).toBeDefined();
            expect([...(contracts[inventory] as ReadonlySet<string>)], inventory).toEqual(values);
        }
    });
});

function expectRejected(action: () => void, message: string): void {
    try {
        action();
        throw new Error('Expected client mutation rejection');
    }
    catch (error) {
        expect(error).toBeInstanceOf(ClientMutationRejectedError);
        expect(error).toMatchObject({
            name: 'ClientMutationRejectedError',
            code: 'client-mutation-rejected',
            status: 400,
            message
        });
    }
}

function validFacts(): ClientMutationFacts {
    return {
        nowEpochMs: 1_000,
        serviceId: 'client-state',
        eventId: 'event-1',
        commandHash: `sha256:${'0'.repeat(64)}`,
        attemptCount: 1,
        expireAtEpochMs: 2_000
    };
}

describe('client mutation computation determinism', () => {
    it('keeps pure compute and validation deterministic and side-effect free', () => {
        const command: ClientMutationCommand = deepFreeze({
            operation: 'upsertPrincipal',
            aggregateRef: principalRef('alice'),
            commandId: 'pure-command',
            requestId: 'pure-command',
            authority: validAuthority('upsertPrincipal'),
            facts: validFacts(),
            input: {
                username: 'alice',
                displayName: 'Alice',
                avatarUrl: null,
                status: null,
                authProvider: null,
                externalSubjectId: null,
                roles: [],
                metadata: {},
                lastSeenAtEpochMs: null,
                actorPrincipalId: null,
                actorSessionId: null,
                reason: null,
                traceId: null
            }
        });
        const read: ClientMutationRead = deepFreeze({
            authoritySession: validAuthoritySession(),
            idempotency: null,
            principal: null,
            instance: null,
            session: null,
            expiredSessionEntry: null,
            snapshot: null,
            receiptEvent: null
        });
        const first = computeClientMutation({ command, read });
        const second = computeClientMutation({ command, read });
        validateClientMutation({ command, read, computed: first });
        validateClientMutation({ command, read, computed: second });
        expect(second).toEqual(first);
        expect(command).toEqual(deepFreeze(structuredClone(command)));
        expect(read).toEqual(deepFreeze(structuredClone(read)));
    });
});
