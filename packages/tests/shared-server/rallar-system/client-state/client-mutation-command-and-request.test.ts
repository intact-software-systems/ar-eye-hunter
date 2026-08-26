import { describe, expect, expectTypeOf, it } from 'vitest';

import {
    toClientMutationIssuedSessionAuthority,
    toClientMutationSystemAuthority
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import { toClientMutationCommand, type ClientMutationPersistedFacts } from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import { toConnectClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-connect-client-session-mutation-input.ts';
import { toExpireClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-expire-client-session-mutation-input.ts';
import { toUpsertClientPrincipalMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-upsert-client-principal-mutation-input.ts';
import { validateClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-command.ts';
import { clientStateInstanceStorageKey } from '@shared-server/rallar-system/client-state/persistence/client-state-instance-storage-key.ts';
import {
    clientStatePrincipalStorageKey,
    decodeClientPrincipalStorageKey
} from '@shared-server/rallar-system/client-state/persistence/client-state-principal-storage-key.ts';
import { clientStateSessionStorageKey } from '@shared-server/rallar-system/client-state/persistence/client-state-session-storage-key.ts';
import { ClientMutationRejectedError } from '@shared-server/rallar-system/client-state/validation/client-mutation-rejection.ts';
import { decodeJsonWireValue, hashMutationCommand } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { ClientSession } from '@shared/api/client-types.ts';
import type { ConnectClientSessionRequest } from '@shared/api/state-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { clientMutationPrincipalRef as principalRef, invalidSessionCommand, validFacts } from './client-mutation-validation-test-fixtures.ts';

const scope: StateScope = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
};

describe('client mutation command and request projection', () => {
    it('preserves principal defaults, omissions, and owned collection clones', () => {
        const roles = ['member'];
        const metadata = { theme: 'dark', nested: { enabled: true } };
        const command = toUpsertClientPrincipalMutationInput({
            scope,
            principalId: 'alice',
            request: { username: 'alice', roles, metadata },
            defaultCommandId: 'fallback-command'
        });

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
                traceId: null
            }
        });
    });

    it('rejects non-JSON principal metadata before command identity is computed', () => {
        expect(() =>
            Reflect.apply(toUpsertClientPrincipalMutationInput, undefined, [{
                scope,
                principalId: 'alice',
                request: { username: 'alice', metadata: { createdAt: new Date(0) } },
                defaultCommandId: 'principal-invalid-metadata'
            }])
        ).toThrow(ClientMutationRejectedError);
    });

    it('hashes the exact input and authority before adding persisted facts', async () => {
        const input = toConnectClientSessionMutationInput({
            operation: 'connectSession',
            scope,
            principalId: 'alice',
            clientInstanceId: 'browser',
            sessionId: 'session-1',
            request: { generationId: 'generation-1', requestId: 'connect-1' },
            defaultCommandId: 'fallback-command',
            identityDefaults: { capabilities: ['rtc'], principalRoles: ['member'] }
        });
        const authority = toClientMutationIssuedSessionAuthority(
            {
                clientId: 'alice',
                accessToken: 'alice-token',
                username: 'alice',
                sessionId: 'auth-session',
                issuedAtEpochMs: 1_000,
                expiresAtEpochMs: 9_000
            },
            scope,
            'connectSession'
        );
        const facts: ClientMutationPersistedFacts = {
            nowEpochMs: 2_000,
            serviceId: 'client-state',
            eventId: 'event-1',
            attemptCount: 1,
            expireAtEpochMs: 10_000
        };

        const command = await toClientMutationCommand(input, facts, authority);
        if (command.operation !== 'connectSession') {
            throw new Error(`Expected a connectSession command, received ${command.operation}`);
        }

        expect(command.facts).toEqual({
            ...facts,
            commandHash: await hashMutationCommand(
                decodeJsonWireValue({ ...input, authority }, 'Client mutation command identity')
            )
        });
        expect(command.input.instanceCapabilities).toEqual(['rtc']);
        expect(command.input.principalRoles).toEqual(['member']);
    });

    it('preserves deterministic expiry identity and system authority', () => {
        expect(
            toExpireClientSessionMutationInput({
                ...scope,
                principalId: 'alice',
                clientInstanceId: 'browser',
                sessionId: 'session-1',
                generationId: 'generation-1',
                generationVersion: 3,
                observedExpiresAtEpochMs: 12_000
            })
        ).toMatchObject({
            operation: 'expireSession',
            commandId: 'expire-client-session:session-1:generation-1:3:12000',
            requestId: 'expire-client-session:session-1:generation-1:3:12000',
            input: {
                expiresAtEpochMs: 12_000,
                actorPrincipalId: 'alice',
                actorSessionId: 'session-1',
                reason: 'expired'
            }
        });
        expect(toClientMutationSystemAuthority('client-state')).toEqual({
            kind: 'system',
            version: 1,
            serviceId: 'client-state',
            operation: 'expireSession'
        });
    });
});

describe('client mutation command contracts', () => {
    it('keeps canonical encoded keys stable', () => {
        const principal = {
            applicationId: 'app:/%',
            workspaceId: '_',
            principalId: 'alice smith'
        };
        const principalKey = clientStatePrincipalStorageKey(principal);

        expect(principalKey).toBe('app=app%3A%2F%25:ws=_:principal=alice%20smith');
        expect(decodeClientPrincipalStorageKey(principalKey)).toEqual(principal);
        expect(clientStateInstanceStorageKey({ ...principal, clientInstanceId: 'web/1' })).toBe(
            `${principalKey}:instance=web%2F1`
        );
        expect(
            clientStateSessionStorageKey({
                ...principal,
                clientInstanceId: 'web/1',
                sessionId: 'session:1'
            })
        ).toBe(`${principalKey}:instance=web%2F1:session=session%3A1`);
    });

    it('requires generation identity and exposes no caller command hash', () => {
        expectTypeOf<ConnectClientSessionRequest>().toHaveProperty('generationId');
        expectTypeOf<ConnectClientSessionRequest>().not.toHaveProperty('commandHash');
        expectTypeOf<ClientSession>().toHaveProperty('generationVersion');
    });

    it('rejects malformed authoritative command shapes for every client branch before compute or hash', () => {
        for (const command of malformedAuthoritativeCommands()) {
            expect(() => validateClientMutationCommand(command)).toThrow(ClientMutationRejectedError);
        }
    });
});

const malformedCommandBase = {
    aggregateRef: principalRef('alice'),
    commandId: 'command-1',
    requestId: 'command-1',
    facts: validFacts()
} as const;
const malformedCommandActor = {
    actorPrincipalId: null,
    actorSessionId: null,
    reason: null,
    traceId: null
} as const;

function malformedAuthoritativeCommands(): readonly unknown[] {
    return [
        [],
        malformedPrincipalCommand(),
        malformedInstanceCommand(),
        invalidSessionCommand(malformedCommandBase, malformedCommandActor, 'connectSession', {
            generationId: { forged: true }
        }),
        invalidSessionCommand(
            malformedCommandBase,
            malformedCommandActor,
            'connectAuthorisedWsSession',
            {
                transport: 'carrier-pigeon'
            }
        ),
        invalidSessionCommand(malformedCommandBase, malformedCommandActor, 'heartbeatSession', {
            lastHeartbeatAtEpochMs: -1
        }),
        invalidSessionCommand(malformedCommandBase, malformedCommandActor, 'disconnectSession', {
            actorPrincipalId: 42
        }),
        invalidSessionCommand(
            malformedCommandBase,
            malformedCommandActor,
            'disconnectAuthorisedWsSession',
            {
                reason: { nested: 'not-a-string' }
            }
        ),
        invalidSessionCommand(malformedCommandBase, malformedCommandActor, 'expireSession', {
            generationVersion: 0,
            observedExpiresAtEpochMs: Number.NaN
        })
    ];
}

function malformedPrincipalCommand() {
    return {
        ...malformedCommandBase,
        operation: 'upsertPrincipal',
        input: {
            ...malformedCommandActor,
            username: '',
            displayName: null,
            avatarUrl: null,
            status: 'impossible',
            authProvider: null,
            externalSubjectId: null,
            roles: [],
            metadata: {},
            lastSeenAtEpochMs: null
        }
    };
}

function malformedInstanceCommand() {
    return {
        ...malformedCommandBase,
        operation: 'upsertInstance',
        clientInstanceId: '',
        input: {
            ...malformedCommandActor,
            status: null,
            platform: 'browser',
            deviceLabel: null,
            appVersion: null,
            userAgent: null,
            capabilities: []
        }
    };
}
