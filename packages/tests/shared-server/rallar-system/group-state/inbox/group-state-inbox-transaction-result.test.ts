import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { decodeAppInboxEnqueue } from '@shared-server/rallar-system/app-inbox/app-inbox-command-decoding.ts';
import { AppInboxType, type AppInboxExecutionMetadata } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { computeAppInboxCompletion, validateAppInboxCompletion } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-completion-computation.ts';
import type { AppInboxMutationTransactionWriter } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import type { GroupMutationPreparation } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { GroupStateInboxHandler } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts';
import { decodeGroupStateWritten } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result-codec.ts';
import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { createGroupStateTransactionBoundaryHarness } from './group-state-transaction-boundary-fixture.ts';

const EXPECTED_CREATE_GROUP_DURABLE_JSON = '{"status":"created","result":{"snapshot":' +
    '{"causalRevision":{"groupRevision":1,"presenceRevision":0},' +
    '"group":{"applicationId":"ar-eye-hunter","workspaceId":"default",' +
    '"groupId":"transaction-boundary-room","slug":null,' +
    '"displayName":"Transaction boundary room","description":null,"kind":"room",' +
    '"status":"active","joinMode":"open","maxMembers":null,' +
    '"maxSessionsPerMember":null,"metadata":{},"activeMemberCount":1,' +
    '"ownerPrincipalId":"owner","snapshotVersion":1,"metadataVersion":1,' +
    '"rosterVersion":1,"presenceVersion":0,"created":{"atEpochMs":1785628800000,' +
    '"actor":{"kind":"session","sessionId":"owner-session","principalId":"owner"},' +
    '"reason":null,"traceId":null,"requestId":"create-transaction-boundary-room"},' +
    '"updated":{"atEpochMs":1785628800000,"actor":{"kind":"session",' +
    '"sessionId":"owner-session","principalId":"owner"},"reason":null,' +
    '"traceId":null,"requestId":"create-transaction-boundary-room"},' +
    '"archived":null,"deleted":null,"expiresAtEpochMs":null,' +
    '"emptySinceEpochMs":null,"purgeAfterEpochMs":null,' +
    '"lifecycleState":"active","formationEpoch":0,"formationAttemptCount":0,"lastFormationOutcome":null,"establishmentStartedAtEpochMs":null,"formationElectorate":["owner"],"acceptedLayoutIdentity":null,"transportState":"flowing"},"members":[' +
    '{"applicationId":"ar-eye-hunter","workspaceId":"default",' +
    '"groupId":"transaction-boundary-room","principalId":"owner","role":"owner",' +
    '"status":"active","joined":{"atEpochMs":1785628800000,' +
    '"actor":{"kind":"session","sessionId":"owner-session","principalId":"owner"},' +
    '"reason":null,"traceId":null,"requestId":"create-transaction-boundary-room"},' +
    '"updated":{"atEpochMs":1785628800000,"actor":{"kind":"session",' +
    '"sessionId":"owner-session","principalId":"owner"},"reason":null,' +
    '"traceId":null,"requestId":"create-transaction-boundary-room"},"left":null,' +
    '"removed":null,"banned":null,"invitedByPrincipalId":null,' +
    '"invitationExpiresAtEpochMs":null}],"activeSessions":[],"memberCount":1,' +
    '"onlineMemberCount":0},"event":{"applicationId":"ar-eye-hunter",' +
    '"workspaceId":"default","groupId":"transaction-boundary-room",' +
    '"eventId":"group-event:3e85b5e31f6a320e249e7fd18bf180c7ce3a15825453b7549a25897e91bc41c7",' +
    '"eventType":"group-created","snapshotVersion":1,' +
    '"causalRevision":{"groupRevision":1,"presenceRevision":0},' +
    '"occurredAtEpochMs":1785628800000,"actor":{"kind":"session",' +
    '"sessionId":"owner-session","principalId":"owner"},"reason":null,' +
    '"traceId":null,"requestId":"create-transaction-boundary-room","payload":{}}}}';

describe('group-state AppInbox transaction result boundary', () => {
    it('persists the real durable result without installing a snapshot in the summary cache', async () => {
        const harness = await createGroupStateTransactionBoundaryHarness();

        const created = await harness.handler.processGroupStateMutation(harness.context);
        if (!('status' in created) || created.status !== 'created') {
            throw new TypeError('createGroup must resolve to a created group-state write.');
        }

        const persisted = await harness.results.findByKey(harness.context.entry.key);
        expect(persisted?.status).toBe(EntityStatus.COMPLETED);
        expect(persisted?.resource).toBe(EXPECTED_CREATE_GROUP_DURABLE_JSON);
        expect(persisted?.resource).not.toContain('committedSnapshot');
        if (!persisted) {
            throw new TypeError('Expected the completed group-state result entry.');
        }
        const decodedDurableResult = decodeGroupStateWritten(
            decodeJsonWireValue(JSON.parse(persisted.resource), 'Persisted group-state result')
        );
        expect(decodedDurableResult).toEqual(created);
        expect(harness.transactionWriter.read(harness.context)).toEqual({
            state: 'transaction-finalized',
            status: EntityStatus.COMPLETED,
            result: created
        });
        expect(harness.observedSnapshots).toEqual([]);
        expect(harness.readWakeCount()).toBe(1);
        expect(harness.outboxEntries.size).toBe(1);
    });

    it('records one formation mutation metric only after the commit succeeds', async () => {
        const harness = await createGroupStateTransactionBoundaryHarness();

        expect(harness.formationMutationEvents).toEqual([]);
        await harness.handler.processGroupStateMutation(harness.context);

        expect(harness.formationMutationEvents).toEqual([{ operation: 'createGroup', outcome: 'write' }]);
    });

    it('rejects predecessor fields in prepared facts before starting the mutation transaction', async () => {
        const harness = await createGroupStateTransactionBoundaryHarness();
        const authority = requireJsonWireObject(
            harness.context.enqueue.authority,
            'Prepared authority'
        );
        const facts = requireJsonWireObject(authority.facts, 'Prepared facts');
        const malformedContext = {
            ...harness.context,
            enqueue: {
                ...harness.context.enqueue,
                authority: {
                    ...authority,
                    facts: { ...facts, predecessorAttemptCount: 1 }
                }
            }
        };

        await expect(
            harness.handler.processGroupStateMutation(malformedContext)
        ).rejects.toThrow('App inbox prepared group mutation is malformed.');
        expect(harness.reachedStages).toEqual([]);
        expect(await harness.repository.readSnapshot(harness.groupRef)).toBeUndefined();
    });

    it('persists an inactive presence result once without active mutation effects', async () => {
        const actions: string[] = [];
        const transactionWriter: AppInboxMutationTransactionWriter = {
            readCompletionFacts: (context) => ({ entry: context.entry, completedAtEpochMs: 2_000 }),
            writeMutation: async (_context, computed, write) => {
                actions.push('inactive-transaction');
                await write(createUnusedTransaction());
                return computed.durableResult;
            },
            writeMutationWithAfterCommitResult: () =>
                Promise.reject(
                    new Error('Inactive presence must not enter the active mutation transaction')
                )
        };
        const handler = new GroupStateInboxHandler({
            prepareMutation: async () => {
                throw new Error('Inactive presence fixture must already be prepared.');
            },
            persistPreparation: async () => {
                throw new Error('Inactive presence fixture must not persist preparation.');
            },
            mutationService: {
                read: async () => {
                    throw new Error('Inactive presence must not read group mutation state');
                },
                compute: () => {
                    throw new Error('Inactive presence must not compute a group mutation');
                },
                validate: () => {
                    throw new Error('Inactive presence must not validate a group mutation');
                },
                write: async () => {
                    throw new Error('Inactive presence must not write group mutation state');
                }
            },
            resultReader: {
                readSnapshot: async () => undefined,
                readEvent: async () => undefined
            },
            sessionGenerationLifecycle: {
                read: async (identity) => ({
                    identity,
                    key: 'closed-lifecycle',
                    revision: null,
                    persistedExpireAtEpochMs: null,
                    state: null
                }),
                isObservedAtClosed: () => true,
                isGenerationClosed: () => true,
                computeClosed: () => {
                    throw new Error('Presence connect must not compute a close state');
                },
                computeConnectGuard: () => {
                    throw new Error('Inactive presence must not compute a connect guard');
                },
                validateClosed: () => {
                    throw new Error('Inactive presence must not validate a close state');
                },
                validateConnectGuard: () => {
                    throw new Error('Inactive presence must not validate a connect guard');
                },
                write: async () => {
                    throw new Error('Inactive presence must not write lifecycle state');
                }
            },
            transactionWriter,
            wakeQueue: () => actions.push('wake')
        });
        const result = await handler.processGroupStateMutation(inactiveConnectContext());
        expect(JSON.stringify(result)).toBe('{"status":"inactive","sessionId":"inactive-session","generationId":"inactive-generation"}');
        expect(actions).toEqual(['inactive-transaction']);
    });

    it('keeps the existing durable-only writer result and serialization unchanged', async () => {
        const harness = await createGroupStateTransactionBoundaryHarness();
        const durableResult = {
            status: 'durable-only',
            result: { value: 0, omitted: null }
        } as const;
        const input = {
            ...harness.transactionWriter.readCompletionFacts(harness.context),
            durableResult,
            status: EntityStatus.COMPLETED
        } as const;
        const computed = computeAppInboxCompletion(input);
        expect(validateAppInboxCompletion(input, computed)).toEqual([]);

        const returned = await harness.transactionWriter.writeMutation(
            harness.context,
            computed,
            async () => {}
        );
        const persisted = await harness.results.findByKey(harness.context.entry.key);

        expectTypeOf(returned).toEqualTypeOf<typeof durableResult>();
        expect(returned).toBe(durableResult);
        expect(persisted?.resource).toBe('{"status":"durable-only","result":{"value":0,"omitted":null}}');
        expect(harness.transactionWriter.read(harness.context)).toEqual({
            state: 'transaction-finalized',
            status: EntityStatus.COMPLETED,
            result: durableResult
        });
    });

    it('infers durable and after-commit results independently from data-only metadata', async () => {
        const harness = await createGroupStateTransactionBoundaryHarness();
        const durableResult = { status: 'accepted', revision: 2 } as const;
        const afterCommitResult = { observed: true } as const;
        const input = {
            ...harness.transactionWriter.readCompletionFacts(harness.context),
            durableResult,
            status: EntityStatus.COMPLETED
        } as const;
        const computed = computeAppInboxCompletion(input);
        expect(validateAppInboxCompletion(input, computed)).toEqual([]);

        const returned = await harness.transactionWriter.writeMutationWithAfterCommitResult(
            harness.context,
            computed,
            async () => afterCommitResult
        );

        expectTypeOf(returned.durableResult).toEqualTypeOf<typeof durableResult>();
        expectTypeOf(returned.afterCommitResult).toEqualTypeOf<typeof afterCommitResult>();
        expect(returned.durableResult).toBe(durableResult);
        expect(returned.afterCommitResult).toBe(afterCommitResult);
        expect((await harness.results.findByKey(harness.context.entry.key))?.resource)
            .toBe('{"status":"accepted","revision":2}');
    });
});

const INACTIVE_CONNECT_AUTHORITY: GroupMutationPreparation = {
    authorityProof: {
        version: 1,
        principalId: 'owner',
        sessionId: 'inactive-session',
        sessionIssuedAtEpochMs: 1_000,
        sessionExpiresAtEpochMs: 61_000,
        commandMac: 'a'.repeat(64)
    },
    descriptor: {
        operation: 'connectPresence',
        scope: {
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default'
        },
        groupId: 'inactive-group',
        targetPrincipalId: null,
        sessionId: 'inactive-session',
        request: {
            requestId: 'inactive-request',
            actorPrincipalId: 'owner',
            actorSessionId: 'inactive-session',
            principalId: 'owner',
            generationId: 'inactive-generation',
            connectedAtEpochMs: 1_000,
            lastHeartbeatAtEpochMs: 1_000,
            expiresAtEpochMs: 61_000
        }
    },
    command: {
        operation: 'connectPresence',
        aggregateRef: {
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            groupId: 'inactive-group'
        },
        commandId: 'inactive-command',
        requestId: 'inactive-request',
        sessionId: 'inactive-session',
        input: {
            principalId: 'owner',
            generationId: 'inactive-generation',
            connectedAtEpochMs: 1_000,
            lastHeartbeatAtEpochMs: 1_000,
            expiresAtEpochMs: 61_000,
            actorPrincipalId: 'owner',
            actorSessionId: 'inactive-session',
            reason: null,
            traceId: null
        }
    },
    facts: {
        nowEpochMs: 2_000,
        expireAtEpochMs: 604_802_000,
        serviceId: 'server-1',
        eventId: 'event-1',
        commandHash: `sha256:${'a'.repeat(64)}`,
        resolvedJoinCode: null,
        joinCodeVerifier: null,
        internalAuthority: 'none',
        authenticatedAuthority: { principalId: 'owner', sessionId: 'inactive-session' }
    },
    causalToken: 'causal-token',
    queueResourceId: 'inactive-queue-resource'
};

function inactiveConnectContext(): AppInboxExecutionMetadata {
    const enqueue = decodeAppInboxEnqueue({
        type: AppInboxType.GROUP_PRESENCE_CONNECT,
        resourceId: 'inactive-command',
        contextId: 'inactive-group',
        authority: INACTIVE_CONNECT_AUTHORITY,
        data: { requestId: 'inactive-request' }
    });
    const createdAt = Temporal.Instant.fromEpochMilliseconds(1_000);
    const entry: ResourceEntry = {
        key: {
            topicId: 'app-inbox.group-state',
            resourceId: 'inactive-command',
            contextId: 'inactive-group'
        },
        resource: JSON.stringify(enqueue),
        typeId: AppInboxType.GROUP_PRESENCE_CONNECT,
        status: EntityStatus.RESERVED,
        audit: {
            date: createdAt.toZonedDateTimeISO('UTC').toPlainTime(),
            createdBy: 'server-1',
            createdTs: createdAt.toZonedDateTimeISO('UTC').toPlainDateTime(),
            expiryTs: Temporal.Instant.fromEpochMilliseconds(604_802_000)
        },
        dequeueAudit: { attempts: 1, startTs: createdAt }
    };
    return {
        enqueue,
        entry,
        message: newALUntargetedMessage(
            'server-1',
            newALRoute(entry.key.topicId, entry.key.contextId, entry.key.resourceId),
            entry.typeId,
            enqueue
        )
    };
}

function createUnusedTransaction(): PSqlSql {
    const transaction: PSqlSql = Object.assign(
        <Result>(
            _stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
            ..._values: readonly PSqlParameter[]
        ): Promise<Result> =>
            Promise.reject(
                new Error('Inactive presence must not execute SQL through its result callback')
            ),
        {
            begin: <Result>(_run: (sql: PSqlSql) => Promise<Result>): Promise<Result> =>
                Promise.reject(
                    new Error('Inactive presence must not start a nested SQL transaction')
                )
        }
    );
    return transaction;
}

function requireJsonWireObject(
    value: JsonWireValue | undefined,
    label: string
): JsonWireObject {
    if (
        value === null || value === undefined || typeof value !== 'object' ||
        Array.isArray(value)
    ) {
        throw new TypeError(`${label} must be an object`);
    }
    return value as JsonWireObject;
}
