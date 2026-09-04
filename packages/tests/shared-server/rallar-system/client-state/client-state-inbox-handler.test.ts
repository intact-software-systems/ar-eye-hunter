import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import {
    AppInboxType,
    type AppInboxEnqueueInput,
    type AppInboxMessageContext
} from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { encodeAppInboxResult } from '@shared-server/rallar-system/app-inbox/app-inbox-registration-codecs.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { PersistedAuthSession } from '@shared-server/rallar-system/auth/persistence/persisted-auth-session.ts';
import {
    CLIENT_EXPIRED_SESSION_PAGE_SIZE,
    type ClientExpiredSessionPageInput,
    type ClientStateWritten
} from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import type {
    ClientAuthorisedWsSessionConnectAppInboxPayload,
    ClientAuthorisedWsSessionDisconnectAppInboxPayload
} from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts';
import {
    toAuthorisedWsClientConnectEnqueue,
    toAuthorisedWsClientConnection,
    toAuthorisedWsClientDisconnectEnqueue
} from '@shared-server/rallar-system/client-state/inbox/authorised-ws-client-app-inbox.ts';
import { ClientStateInboxHandler } from '@shared-server/rallar-system/client-state/inbox/client-state-inbox-handler.ts';
import type { AuthorisedWsClientMutationResult } from '@shared-server/rallar-system/client-state/inbox/client-state-inbox-result-codec.ts';
import {
    toClientMutationIssuedSessionAuthority,
    toClientMutationSystemAuthority
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import type {
    ClientMutationCommand,
    ClientMutationRead
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import { toUpsertClientPrincipalMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-upsert-client-principal-mutation-input.ts';
import type { ClientSessionExpiryCandidate } from '@shared-server/rallar-system/presence/session-expiry.ts';
import {
    computeWsSessionConnectGuard,
    computeWsSessionGenerationClosed,
    isWsSessionGenerationClosed,
    toWsSessionLifecycleKey,
    type WsSessionGenerationLifecycleRead,
    type WsSessionHighWaterIdentity
} from '@shared-server/rallar-system/websocket/ws-session-generation-computation.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { readClientExpiryTestEnqueueData } from './app-client-inbox-expiry-fixtures.ts';

const NOW_EPOCH_MS = 1_000;
const SERVICE_ID = 'client-inbox-phase-test';
const SCOPE = { applicationId: 'app-1', workspaceId: 'workspace-1' } as const;
const SESSION: IssuedAuthSession = {
    clientId: 'alice',
    username: 'alice',
    sessionId: 'alice-session',
    accessToken: 'secret',
    issuedAtEpochMs: 500,
    expiresAtEpochMs: 10_000
};
const CONNECTION = toAuthorisedWsClientConnection({
    authSession: SESSION,
    generationId: 'generation-1',
    input: {
        ...SCOPE,
        clientInstanceId: 'browser',
        connectedAtEpochMs: 600,
        expiresAtEpochMs: 9_000
    }
});

describe('ClientStateInboxHandler phases', () => {
    it.each([
        { generationClosed: false, label: 'active', writes: true },
        { generationClosed: true, label: 'inactive', writes: false }
    ])('keeps every authorised connect $label path read-compute-validate-write ordered', async ({
        generationClosed,
        writes
    }) => {
        const fixture = createHandlerFixture({ generationClosed, sessionPresent: true });
        const context = createContext<AuthorisedWsClientMutationResult>(
            toAuthorisedWsClientConnectEnqueue({
                authSession: SESSION,
                generationId: CONNECTION.generationId,
                input: {
                    ...SCOPE,
                    clientInstanceId: CONNECTION.clientInstanceId,
                    connectedAtEpochMs: CONNECTION.generationStartedAtEpochMs,
                    expiresAtEpochMs: CONNECTION.expiresAtEpochMs
                }
            })
        );

        await fixture.handler.processAuthorisedWsConnect(CONNECTION, context);

        expect(fixture.actions).toEqual(
            writes
                ? [
                    'completion.read',
                    'lifecycle.read',
                    'domain.read',
                    'domain.compute',
                    'lifecycle.compute-connect',
                    'mutation.compute',
                    'domain.validate',
                    'mutation.validate',
                    'transaction',
                    'lifecycle.write',
                    'domain.write',
                    'commit',
                    'mutation.write',
                    'observe'
                ]
                : [
                    'completion.read',
                    'lifecycle.read',
                    'domain.read',
                    'mutation.compute',
                    'mutation.validate',
                    'transaction',
                    'commit'
                ]
        );
    });

    it.each([
        { sessionPresent: true, label: 'existing-session', writesDomain: true },
        { sessionPresent: false, label: 'missing-session', writesDomain: false }
    ])('keeps every authorised disconnect $label path read-compute-validate-write ordered', async ({
        sessionPresent,
        writesDomain
    }) => {
        const fixture = createHandlerFixture({ generationClosed: false, sessionPresent });
        const input: ClientAuthorisedWsSessionDisconnectAppInboxPayload = {
            connection: CONNECTION,
            disconnectedAtEpochMs: 800,
            reason: 'socket-closed'
        };
        const context = createContext<AuthorisedWsClientMutationResult>(
            toAuthorisedWsClientDisconnectEnqueue(input)
        );

        await fixture.handler.processAuthorisedWsDisconnect(input, context);

        expect(fixture.actions).toEqual(
            writesDomain
                ? [
                    'completion.read',
                    'lifecycle.read',
                    'domain.read',
                    'domain.compute',
                    'lifecycle.compute-close',
                    'mutation.compute',
                    'domain.validate',
                    'mutation.validate',
                    'transaction',
                    'lifecycle.write',
                    'domain.write',
                    'commit',
                    'mutation.write',
                    'observe'
                ]
                : [
                    'completion.read',
                    'lifecycle.read',
                    'domain.read',
                    'lifecycle.compute-close',
                    'mutation.compute',
                    'mutation.validate',
                    'transaction',
                    'lifecycle.write',
                    'commit'
                ]
        );
    });

    it('reads every expiry candidate before computing and validates the aggregate before writing', async () => {
        const candidates = [expiryCandidate('session-1'), expiryCandidate('session-2')];
        const fixture = createHandlerFixture({
            generationClosed: false,
            sessionPresent: true,
            expiryCandidates: candidates
        });
        const context = createContext<readonly ClientStateWritten[]>({
            type: AppInboxType.CLIENT_EXPIRED_SESSIONS,
            resourceId: 'expire-client-sessions',
            contextId: 'expire-client-sessions',
            senderId: SERVICE_ID,
            authority: toClientMutationSystemAuthority(SERVICE_ID),
            data: { atEpochMs: NOW_EPOCH_MS, afterKey: null }
        });

        await fixture.handler.processExpiredSessionCommands(context, {
            atEpochMs: NOW_EPOCH_MS,
            afterKey: null
        });

        expect(fixture.actions).toEqual([
            'completion.read',
            'expiry.read',
            'domain.read',
            'domain.read',
            'domain.compute',
            'domain.compute',
            'mutation.compute',
            'domain.validate',
            'domain.validate',
            'mutation.validate',
            'transaction',
            'domain.write',
            'domain.write',
            'commit',
            'mutation.write',
            'mutation.write',
            'observe',
            'observe'
        ]);
    });

    it('bounds expiry writes per outer attempt and performs no inner conflict retry', async () => {
        const pageSize = CLIENT_EXPIRED_SESSION_PAGE_SIZE;
        const fixture = createHandlerFixture({
            generationClosed: false,
            sessionPresent: true,
            expiryCandidates: Array.from(
                { length: pageSize },
                (_, index) => expiryCandidate(`session-${index}`)
            ),
            nextAfterKey: 'next-session-page',
            failFirstExpiryTransactionAtWrite: pageSize
        });
        const input = { atEpochMs: NOW_EPOCH_MS, afterKey: null } as const;
        const context = createContext<readonly ClientStateWritten[]>({
            type: AppInboxType.CLIENT_EXPIRED_SESSIONS,
            resourceId: 'bounded-expire-client-sessions',
            contextId: 'expire-client-sessions',
            senderId: SERVICE_ID,
            authority: toClientMutationSystemAuthority(SERVICE_ID),
            data: input
        });

        await expect(
            fixture.handler.processExpiredSessionCommands(context, input)
        ).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);

        expect(fixture.pageReadCount()).toBe(1);
        expect(fixture.pageReads).toEqual([input]);
        expect(fixture.writesByTransaction).toEqual([pageSize]);
        expect(fixture.continuationWriteCount()).toBe(0);

        await expect(
            fixture.handler.processExpiredSessionCommands(context, input)
        ).resolves.toHaveLength(pageSize);

        expect(fixture.pageReadCount()).toBe(2);
        expect(fixture.pageReads).toEqual([input, input]);
        expect(fixture.writesByTransaction).toEqual([pageSize, pageSize]);
        expect(
            fixture.writesByTransaction.every((writes) => writes <= pageSize)
        ).toBe(true);
        expect(fixture.continuationWriteCount()).toBe(1);
        expect(fixture.continuationEntries).toHaveLength(1);
        expect(fixture.continuationEntries[0]?.key.resourceId).toBe(
            toAppQueueKey({
                topicId: AppInboxType.CLIENT_EXPIRED_SESSIONS,
                resourceId: `expire-client-sessions:${NOW_EPOCH_MS}:next-session-page`,
                contextId: 'expire-client-sessions'
            }).resourceId
        );
        expect(
            readClientExpiryTestEnqueueData<ClientExpiredSessionPageInput>(
                fixture.continuationEntries[0]!
            )
        ).toEqual({ atEpochMs: NOW_EPOCH_MS, afterKey: 'next-session-page' });
    });

    it('keeps the ordinary command path read-compute-validate-write ordered', async () => {
        const fixture = createHandlerFixture({ generationClosed: false, sessionPresent: true });
        const context = createContext<ClientStateWritten>({
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: 'upsert-alice',
            contextId: 'app-1:workspace-1:alice',
            senderId: 'alice',
            authority: toClientMutationIssuedSessionAuthority(
                SESSION,
                SCOPE,
                'upsertPrincipal'
            ),
            data: {}
        });

        await fixture.handler.processCommand(
            context,
            toUpsertClientPrincipalMutationInput({
                scope: SCOPE,
                principalId: 'alice',
                request: { username: 'alice', requestId: 'upsert-alice' },
                defaultCommandId: 'upsert-alice'
            })
        );

        expect(fixture.actions).toEqual([
            'completion.read',
            'domain.read',
            'domain.compute',
            'mutation.compute',
            'domain.validate',
            'mutation.validate',
            'transaction',
            'domain.write',
            'commit',
            'mutation.write',
            'observe'
        ]);
    });
});

interface HandlerFixtureOptions {
    readonly expiryCandidates?: readonly ClientSessionExpiryCandidate[];
    readonly failFirstExpiryTransactionAtWrite?: number;
    readonly generationClosed: boolean;
    readonly nextAfterKey?: string | null;
    readonly sessionPresent: boolean;
}

function createHandlerFixture(options: HandlerFixtureOptions): {
    readonly actions: string[];
    readonly continuationEntries: readonly ResourceEntry[];
    readonly continuationWriteCount: () => number;
    readonly handler: ClientStateInboxHandler;
    readonly pageReads: readonly ClientExpiredSessionPageInput[];
    readonly pageReadCount: () => number;
    readonly writesByTransaction: number[];
} {
    const actions: string[] = [];
    const continuationEntries: ResourceEntry[] = [];
    const pageReads: ClientExpiredSessionPageInput[] = [];
    const writesByTransaction: number[] = [];
    let continuationWriteCount = 0;
    let pageReadCount = 0;
    const mutationService = {
        read: async (command: ClientMutationCommand): Promise<ClientMutationRead> => {
            actions.push('domain.read');
            return {
                authoritySession: command.authority.kind === 'issued-session'
                    ? persistedSession(command)
                    : null,
                idempotency: null,
                principal: null,
                instance: null,
                session: options.sessionPresent ? ({} as never) : null,
                expiredSessionEntry: null,
                snapshot: null,
                receiptEvent: null
            };
        },
        compute: (command: ClientMutationCommand) => {
            actions.push('domain.compute');
            return {
                outcome: 'write',
                receipt: { commandId: command.commandId },
                snapshot: { commandId: command.commandId },
                event: null
            } as never;
        },
        validate: () => {
            actions.push('domain.validate');
        },
        write: async () => {
            actions.push('domain.write');
            const transactionIndex = writesByTransaction.length - 1;
            writesByTransaction[transactionIndex] = (writesByTransaction[transactionIndex] ?? 0) + 1;
            if (
                writesByTransaction.length === 1 &&
                writesByTransaction[transactionIndex] ===
                    options.failFirstExpiryTransactionAtWrite
            ) {
                throw new RuntimeStateWriteConflictError();
            }
            return {} as never;
        }
    };
    const handler = new ClientStateInboxHandler({
        mutationService,
        sessionGenerationLifecycle: {
            read: async (identity) => {
                actions.push('lifecycle.read');
                return lifecycleRead(identity, options.generationClosed);
            },
            isGenerationClosed: isWsSessionGenerationClosed,
            isObservedAtClosed: () => false,
            computeClosed: (facts, read) => {
                actions.push('lifecycle.compute-close');
                return computeWsSessionGenerationClosed(facts, read);
            },
            computeConnectGuard: (facts, read) => {
                actions.push('lifecycle.compute-connect');
                return computeWsSessionConnectGuard(facts, read);
            },
            write: async () => {
                actions.push('lifecycle.write');
            }
        },
        expiryCandidates: {
            readExpiredSessionPage: async (input) => {
                actions.push('expiry.read');
                pageReadCount += 1;
                pageReads.push(input);
                return {
                    candidates: options.expiryCandidates ?? [],
                    nextAfterKey: options.nextAfterKey ?? null
                };
            }
        },
        expiryContinuationWriter: {
            write: async (_transaction, computed) => {
                actions.push('continuation.write');
                continuationWriteCount += 1;
                continuationEntries.push(computed.entry);
            }
        },
        snapshotObserver: {
            observeSnapshot: async (snapshot) => {
                actions.push('observe');
                return snapshot;
            }
        },
        transactionWriter: {
            readCompletionFacts: (context) => {
                actions.push('completion.read');
                return { entry: context.entry, completedAtEpochMs: NOW_EPOCH_MS };
            },
            writeComputedMutation: async (_context, computed, write) => {
                actions.push('transaction');
                writesByTransaction.push(0);
                await write({} as PSqlSql);
                actions.push('commit');
                return computed.durableResult;
            }
        },
        mutationTiming: {
            serviceId: SERVICE_ID,
            sink: (event) => actions.push(event.operation)
        },
        wakeQueue: () => actions.push('wake'),
        serviceId: SERVICE_ID
    });
    return {
        actions,
        continuationEntries,
        continuationWriteCount: () => continuationWriteCount,
        handler,
        pageReads,
        pageReadCount: () => pageReadCount,
        writesByTransaction
    };
}

function persistedSession(command: ClientMutationCommand): PersistedAuthSession {
    if (command.authority.kind !== 'issued-session') {
        throw new TypeError('Expected issued-session command authority');
    }
    return {
        clientId: command.authority.principalId,
        username: command.authority.principalId,
        sessionId: command.authority.sessionId,
        accessTokenDigest: 'sha256:test',
        issuedAtEpochMs: command.authority.sessionIssuedAtEpochMs,
        expiresAtEpochMs: command.authority.sessionExpiresAtEpochMs
    };
}

function lifecycleRead(
    identity: WsSessionHighWaterIdentity,
    generationClosed: boolean
): WsSessionGenerationLifecycleRead {
    return {
        identity,
        key: toWsSessionLifecycleKey(identity),
        revision: generationClosed ? 0 : null,
        persistedExpireAtEpochMs: generationClosed ? CONNECTION.expiresAtEpochMs : null,
        state: generationClosed
            ? {
                version: 3,
                status: 'closed',
                ...identity,
                generationId: CONNECTION.generationId,
                generationStartedAtEpochMs: CONNECTION.generationStartedAtEpochMs,
                disconnectedAtEpochMs: 800,
                reason: 'already-closed',
                expireAtEpochMs: CONNECTION.expiresAtEpochMs
            }
            : null
    };
}

function expiryCandidate(sessionId: string): ClientSessionExpiryCandidate {
    return {
        ...SCOPE,
        principalId: 'alice',
        clientInstanceId: 'browser',
        sessionId,
        generationId: `generation-${sessionId}`,
        generationVersion: 1,
        observedExpiresAtEpochMs: 900
    };
}

function createContext<Result>(
    enqueue: AppInboxEnqueueInput
): AppInboxMessageContext<Result> {
    const resourceId = enqueue.resourceId ?? 'client-handler-test';
    const entry: ResourceEntry = {
        key: {
            topicId: enqueue.topicId ?? 'app-inbox.client-state',
            resourceId,
            contextId: enqueue.contextId ?? 'client-handler-test'
        },
        resource: JSON.stringify(enqueue),
        typeId: EnqueuedType.APP_INBOX,
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: SERVICE_ID,
            createdTs: Temporal.PlainDateTime.from('2026-08-05T12:00:00'),
            expiryTs: NEVER_EXPIRE_TS
        },
        status: EntityStatus.RESERVED,
        dequeueAudit: { attempts: 1 }
    };
    return {
        enqueue,
        message: {
            id: {
                v: 2,
                msgId: resourceId,
                ts: NOW_EPOCH_MS,
                senderId: enqueue.senderId ?? SERVICE_ID
            },
            route: { ...entry.key },
            payload: {
                typeId: enqueue.type,
                contentType: 'application/json',
                resource: entry.resource
            }
        },
        entry,
        encodeResult: (result) => encodeAppInboxResult(result, 'Client handler test result')
    };
}
