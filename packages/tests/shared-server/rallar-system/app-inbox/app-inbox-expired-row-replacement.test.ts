import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { createAuthMutationService } from '@shared-server/rallar-system/auth/auth-mutation-service.ts';
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { AppAuthInboxService } from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import type { JsonWireObject, JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { createTestClientStateRepository, createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createClientStatePhaseTestDriver, failNextClientStateTestOutboxWrite } from '../client-state/client-state-test-runtime.ts';
import { createAppInboxTestResilience, TestResourceInbox, TestResourceInboxResults } from './test-support/app-inbox-resource-fixtures.ts';
import { createAppInboxTestDatabase } from './test-support/app-inbox-test-database.ts';

const SCOPE = { applicationId: 'app-1', workspaceId: 'workspace-1' };

describe('AppInbox expired row replacement', () => {
    it('replaces an expired client session by CAS and rolls back a later failure', async () => {
        const nowEpochMs = 10_000;
        const runtime = new FakeRuntimeStateRepository();
        const service = createClientStatePhaseTestDriver(runtime, () => nowEpochMs);
        await service.upsertPrincipal(SCOPE, 'alice', {
            username: 'alice',
            requestId: 'seed-principal'
        });
        await service.upsertInstance(SCOPE, 'alice', 'browser', {
            platform: 'web',
            requestId: 'seed-instance'
        });
        await service.connectSession(SCOPE, 'alice', 'browser', 'session-1', {
            generationId: 'generation-1',
            connectedAtEpochMs: nowEpochMs,
            expiresAtEpochMs: nowEpochMs + 1_000,
            requestId: 'seed-session'
        });
        const [seeded] = await runtime.findAllEntries('client-state:sessions');
        if (!seeded) {
            throw new Error('Expected seeded client session');
        }
        await runtime.upsert('client-state:sessions', seeded.key, seeded.value, nowEpochMs - 1);
        const expired = await runtime.findEntry('client-state:sessions', seeded.key);
        expect(expired?.revision).toBe(seeded.revision + 1);
        await expect(
            createTestClientStateRepository(runtime).findSession({
                ...SCOPE,
                principalId: 'alice',
                clientInstanceId: 'browser',
                sessionId: 'session-1'
            })
        ).resolves.toBeUndefined();

        failNextClientStateTestOutboxWrite(runtime);
        const replacement = {
            generationId: 'generation-2',
            connectedAtEpochMs: nowEpochMs,
            expiresAtEpochMs: nowEpochMs + 2_000,
            requestId: 'replace-session'
        };
        await expect(
            service.connectSession(SCOPE, 'alice', 'browser', 'session-1', replacement)
        ).rejects.toThrow(/outbox collision/u);
        expect(await runtime.findEntry('client-state:sessions', seeded.key)).toEqual(expired);
        await service.connectSession(SCOPE, 'alice', 'browser', 'session-1', replacement);

        const replaced = await runtime.findEntry('client-state:sessions', seeded.key);
        if (!expired || !replaced) {
            throw new Error('Expected expired client session replacement');
        }
        expect(replaced).toMatchObject({ revision: expired.revision + 1 });
        expect(readJsonObject(replaced.value, 'Replaced client session')).toMatchObject({
            generationId: 'generation-2',
            generationVersion: 1
        });
    });

    it('atomically replaces both expired auth session indexes after a CAS conflict', async () => {
        const nowEpochMs = Date.now();
        const runtime = new FakeRuntimeStateRepository();
        const queue = new TestResourceInbox();
        const results = new TestResourceInboxResults();
        const reader = new InboxQueueReader(queue);
        const credentialIssuer = createHmacAuthCredentialIssuer('expired-auth-secret-0123456789abcdef');
        let rollbackCount = 0;
        let rollbackPreservedExpiredIndexes = false;
        const service = new AppAuthInboxService(
            {
                inboxQueueReader: reader,
                resourceInboxRepository: queue,
                resourceInboxResultsRepository: results,
                database: createAppInboxTestDatabase(queue, results, {
                    runtimeRepository: runtime,
                    onTransactionRollback: async () => {
                        rollbackCount += 1;
                        const rolledBack = await Promise.all([
                            runtime.findAllEntries('auth-sessions:by-token'),
                            runtime.findAllEntries('auth-sessions:by-session')
                        ]);
                        rollbackPreservedExpiredIndexes = rolledBack[0][0]?.revision === 0 && rolledBack[1][0]?.revision === 0;
                    }
                }),
                authMutationService: createAuthMutationService({
                    runtimeRepository: runtime,
                    serviceId: 'expired-auth-service'
                }),
                credentialIssuer: credentialIssuer
            },
            {
                serviceId: 'expired-auth-service'
            }
        );
        const requestId = 'replace-expired-auth-session';
        const sessionId = `session-${
            (
                await hashAuthSecret(JSON.stringify(['session', requestId, 'alice', 'client-1']))
            ).slice(0, 24)
        }`;
        const accessToken = await credentialIssuer.issueAccessToken(sessionId);
        const accessTokenDigest = await hashAuthSecret(accessToken);
        const oldSession = {
            clientId: 'client-1',
            username: 'alice',
            sessionId,
            accessTokenDigest,
            issuedAtEpochMs: nowEpochMs - 10_000,
            expiresAtEpochMs: nowEpochMs - 1
        };
        const sessions = new AuthSessionRepository(runtime);
        await sessions.insertSessionByTokenDigest(oldSession);
        await sessions.insertSessionBySessionId(oldSession);
        const before = await Promise.all([
            runtime.findAllEntries('auth-sessions:by-token'),
            runtime.findAllEntries('auth-sessions:by-session')
        ]);
        expect(before[0][0]?.revision).toBe(0);
        expect(before[1][0]?.revision).toBe(0);

        let conflictInjected = false;
        runtime.beforeConditionalWrite = async (operation, namespace, key) => {
            if (
                !conflictInjected &&
                operation === 'upsertIfRevision' &&
                namespace === 'auth-sessions:by-session'
            ) {
                conflictInjected = true;
                const current = await runtime.findEntry(namespace, key);
                if (!current) {
                    throw new Error('Expected expired auth session index');
                }
                await runtime.upsert(namespace, key, current.value, current.expireAtTimestamp);
            }
        };
        const pending = service.issueSession({
            requestId,
            clientId: 'client-1',
            username: 'alice',
            ttlMs: 60_000,
            authority: {
                kind: 'static-client',
                clientId: 'client-1',
                normalizedUsername: 'alice'
            }
        });
        await queue.waitForEntryCount();
        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createAppInboxTestResilience(1)
        );
        const [afterFirstDequeue] = await queue.readEntries();
        if (afterFirstDequeue?.status === EntityStatus.RETRY) {
            await new Promise((resolve) => setTimeout(resolve, 2));
            await reader.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                createAppInboxTestResilience()
            );
        }
        await expect(pending).resolves.toMatchObject({
            right: { sessionId, accessToken }
        });
        const after = await Promise.all([
            runtime.findAllEntries('auth-sessions:by-token'),
            runtime.findAllEntries('auth-sessions:by-session')
        ]);
        expect(after[0][0]?.revision).toBe(1);
        expect(after[1][0]?.revision).toBe(1);
        expect(rollbackCount).toBe(1);
        expect(rollbackPreservedExpiredIndexes).toBe(true);
        expect((await queue.readEntries())[0]).toMatchObject({
            status: EntityStatus.COMPLETED,
            dequeueAudit: { attempts: 2 }
        });
    });

    it(
        'atomically recreates an expired group and its summary ' + 'after a summary CAS conflict',
        async () => {
            const nowEpochMs = Date.now();
            const runtime = new FakeRuntimeStateRepository();
            const queue = new TestResourceInbox();
            const results = new TestResourceInboxResults();
            const reader = new InboxQueueReader(queue);
            const sessions = new AuthSessionRepository(runtime);
            const owner = {
                clientId: 'owner',
                username: 'owner',
                sessionId: 'owner-session',
                accessToken: 'owner-token',
                issuedAtEpochMs: nowEpochMs - 1_000,
                expiresAtEpochMs: nowEpochMs + 60_000
            };
            await sessions.putSession(owner);
            let expiredGroupRevision = -1;
            let oldSummaryRevision = -1;
            let rollbackPreservedPredecessors = false;
            const database = createAppInboxTestDatabase(queue, results, {
                runtimeRepository: runtime,
                onTransactionRollback: async () => {
                    const [group] = await runtime.findAllEntries('group-state:groups');
                    const [summary] = await runtime.findAllEntries('group-state:presence-summaries');
                    rollbackPreservedPredecessors = group?.revision === expiredGroupRevision && summary?.revision === oldSummaryRevision;
                }
            });
            const groupState = createGroupStateService({
                runtimeRepository: runtime,
                groupStateEventStore: database.groupEventStore,
                serviceId: 'expired-group-service',
                readPlannedLayoutRow: async () => null,
                readAcceptedLayoutRow: async () => null,
                now: () => nowEpochMs,
                authSessionRepository: sessions
            });
            const service = new GroupStateInboxService(
                {
                    inboxQueueReader: reader,
                    resourceInboxRepository: queue,
                    resourceInboxResultsRepository: results,
                    database: database,
                    groupStateService: groupState
                },
                {
                    serviceId: 'expired-group-service'
                }
            );
            const create = async (requestId: string, displayName: string) => {
                const minimumEntries = (await queue.getAllKeys()).length + 1;
                const pending = service.processAuthenticatedGroupEntryUntilCompletion(
                    {
                        type: AppInboxType.GROUP_CREATE,
                        resourceId: requestId,
                        contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:room-1`,
                        senderId: owner.clientId,
                        data: {
                            scope: SCOPE,
                            request: {
                                groupId: 'room-1',
                                displayName,
                                kind: 'room',
                                joinMode: 'open',
                                createdByPrincipalId: owner.clientId,
                                actorPrincipalId: owner.clientId,
                                actorSessionId: owner.sessionId,
                                requestId
                            }
                        }
                    },
                    owner
                );
                await queue.waitForEntryCount(minimumEntries);
                return { pending };
            };

            const seeded = await create('seed-group', 'Old room');
            await reader.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                createAppInboxTestResilience()
            );
            await expect(seeded.pending).resolves.toMatchObject({
                right: { status: 'created' }
            });
            const [groupBeforeExpiry] = await runtime.findAllEntries('group-state:groups');
            const [summaryBefore] = await runtime.findAllEntries('group-state:presence-summaries');
            if (!groupBeforeExpiry || !summaryBefore) {
                throw new Error('Expected seeded group and presence summary');
            }
            const [staleWorkEntry] = database.outboxEntries.values();
            if (!staleWorkEntry) {
                throw new Error('Expected seeded presence-summary work');
            }
            const staleAcceptedGroupRevision = readStaleAcceptedGroupRevision(staleWorkEntry.resource);
            await runtime.upsert(
                'group-state:groups',
                groupBeforeExpiry.key,
                groupBeforeExpiry.value,
                nowEpochMs - 1
            );
            const expiredGroup = await runtime.findEntry('group-state:groups', groupBeforeExpiry.key);
            if (!expiredGroup) {
                throw new Error('Expected expired group predecessor');
            }
            expiredGroupRevision = expiredGroup.revision;
            oldSummaryRevision = summaryBefore.revision;
            await expect(
                createTestGroupStateRepository(runtime).findGroup({
                    ...SCOPE,
                    groupId: 'room-1'
                })
            ).resolves.toBeUndefined();

            let conflictInjected = false;
            runtime.beforeConditionalWrite = async (operation, namespace, key) => {
                if (
                    !conflictInjected &&
                    operation === 'upsertIfRevision' &&
                    namespace === 'group-state:presence-summaries'
                ) {
                    conflictInjected = true;
                    const current = await runtime.findEntry(namespace, key);
                    if (!current) {
                        throw new Error('Expected old group presence summary');
                    }
                    await runtime.upsert(namespace, key, current.value, current.expireAtTimestamp);
                }
            };
            const replacement = await create('replace-group', 'New room');
            await reader.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                createAppInboxTestResilience(1)
            );
            const afterFirst = (await queue.readEntries()).find(
                (entry) => entry.status === EntityStatus.RETRY || entry.dequeueAudit.attempts > 1
            );
            if (afterFirst?.status === EntityStatus.RETRY) {
                await new Promise((resolve) => setTimeout(resolve, 2));
                await reader.dequeueInbox(
                    InboxQueueReader.INBOX_DEQUEUE_TYPES,
                    createAppInboxTestResilience()
                );
            }
            await expect(replacement.pending).resolves.toMatchObject({
                right: { status: 'created' }
            });

            const [replacedGroup] = await runtime.findAllEntries('group-state:groups');
            const [replacedSummary] = await runtime.findAllEntries('group-state:presence-summaries');
            if (!replacedGroup || !replacedSummary) {
                throw new Error('Expected group and presence summary replacements');
            }
            const groupValue = readJsonObject(replacedGroup.value, 'Replaced group');
            const summaryValue = readJsonObject(replacedSummary.value, 'Replaced presence summary');
            const snapshotVersion = requireNonNegativeInteger(
                groupValue.snapshotVersion,
                'Replaced group snapshotVersion'
            );
            const summaryCausalRevision = requireJsonObject(
                summaryValue.causalRevision,
                'Replaced presence summary causalRevision'
            );
            const replacementReceipt = (await runtime.findAllEntries('group-state:idempotent'))
                .map((entry) => readJsonObject(entry.value, 'Group idempotency entry'))
                .find(
                    (entry) =>
                        requireJsonObject(entry.receipt, 'Group idempotency receipt').requestId ===
                            'replace-group'
                );
            expect(replacedGroup?.revision).toBe(expiredGroupRevision + 1);
            expect(replacedSummary?.revision).toBe(oldSummaryRevision + 1);
            expect(groupValue).toMatchObject({ displayName: 'New room' });
            expect(summaryValue).toMatchObject({
                activePrincipalIds: [],
                activeSessionIds: [],
                causalRevision: { groupRevision: snapshotVersion }
            });
            expect(replacementReceipt).toMatchObject({
                receipt: {
                    requestId: 'replace-group',
                    attemptCount: 2,
                    acceptedStorageRevision: expiredGroupRevision + 1,
                    causalRevision: summaryCausalRevision
                }
            });
            expect(database.groupEventStore.events.at(-1)).toMatchObject({
                requestId: 'replace-group',
                causalRevision: summaryCausalRevision
            });
            expect(rollbackPreservedPredecessors).toBe(true);
            expect(database.groupEventStore.events).toHaveLength(2);
            expect(database.outboxEntries.size).toBe(2);
            expect(
                (await queue.readEntries()).some(
                    (entry) => entry.status === EntityStatus.COMPLETED && entry.dequeueAudit.attempts === 2
                )
            ).toBe(true);
            expect(snapshotVersion).toBeGreaterThan(staleAcceptedGroupRevision);
        }
    );
});

function readStaleAcceptedGroupRevision(resource: string): number {
    const message = readJsonObject(resource, 'Presence-summary outbox message');
    const payload = requireJsonObject(message.payload, 'Presence-summary outbox payload');
    if (typeof payload.resource !== 'string') {
        throw new TypeError('Presence-summary outbox payload resource must be a string');
    }
    const work = readJsonObject(payload.resource, 'Presence-summary work');
    const data = requireJsonObject(work.data, 'Presence-summary work data');
    const acceptedCausalRevision = requireJsonObject(
        data.acceptedCausalRevision,
        'Presence-summary accepted causal revision'
    );
    return requireNonNegativeInteger(
        acceptedCausalRevision.groupRevision,
        'Presence-summary accepted group revision'
    );
}

function readJsonObject(value: string, label: string): JsonWireObject {
    const parsed: JsonWireValue = JSON.parse(value);
    return requireJsonObject(parsed, label);
}

function requireJsonObject(value: JsonWireValue, label: string): JsonWireObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value as JsonWireObject;
}

function requireNonNegativeInteger(value: JsonWireValue, label: string): number {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new TypeError(`${label} must be a non-negative safe integer`);
    }
    return Number(value);
}
