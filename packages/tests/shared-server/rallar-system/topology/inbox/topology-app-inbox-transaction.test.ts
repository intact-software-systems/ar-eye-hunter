import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppInboxTransactionWriter } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import {
    computeTopologyConfigMutationAttempt,
    validateTopologyConfigMutationAttempt
} from '@shared-server/rallar-system/topology/config/group-topology-config-mutation-service.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { createAppInboxTestDatabase } from '../../app-inbox/test-support/app-inbox-test-database.ts';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';

import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';

import { createGroupTopologyMutationOwners } from '@shared-server/rallar-system/topology/mutation/create-group-topology-mutation-owners.ts';
import { createGroupTopologyRuntimeOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';

import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';

import { decodeAppInboxEnqueue } from '@shared-server/rallar-system/app-inbox/app-inbox-command-decoding.ts';
import { type AppInboxEnqueueInput, type AppInboxExecutionMetadata } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { RtcTopologyOutboxWriter } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-writer.ts';

import { createAuthenticatedTopologyEnqueue } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-authority.ts';
import {
    toTopologyAppInboxCommand,
    toTopologyAppInboxType,
    toTopologyConfigMutationCommand,
    toTopologyHttpMutationSemanticHash
} from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts';
import type { TopologyAppInboxCommand } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-contracts.ts';
import { TopologyAppInboxHandler, type TopologyAppInboxMutationOwners } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-handler.ts';
import { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';
import { authSession } from '../../group-state/group-state-test-runtime.ts';
import {
    createAuthorityHarness,
    createResilience,
    createRoom,
    SCOPE,
    waitForQueueEntry,
    type AuthorityHarness
} from '../../group-state/inbox/group-state-inbox-test-runtime.ts';

const GROUP_REF: GroupRef = {
    ...SCOPE,
    groupId: 'topology-room'
};
const topologyServices = new WeakMap<AuthorityHarness, TopologyInboxService>();

afterEach(() => vi.restoreAllMocks());

describe('topology AppInbox transaction and idempotency', () => {
    for (const operation of ['putConfig', 'reconfigureTopology'] as const) {
        for (const stage of ['resource-result-replace', 'reservation-finish'] as const) {
            it(`rolls back ${operation} on ${stage} failure and completes only on queue redelivery`, async () => {
                const harness = await createAuthorityHarness(['owner']);
                await createRoom(harness, GROUP_REF.groupId, 'Topology room');
                const before = new Map(harness.runtimeRepository.data);
                let fail = true;
                let wakes = 0;
                const database = createAppInboxTestDatabase(harness.queue, harness.results, {
                    runtimeRepository: harness.runtimeRepository,
                    onStage: (current) => {
                        if (current === stage && fail) {
                            throw new RuntimeStateWriteConflictError();
                        }
                    }
                });
                configureTopology(harness, () => {
                    wakes += 1;
                }, database);
                const command = operation === 'putConfig'
                    ? await topologyCommand('completion-rollback', 4)
                    : await reconfigureCommand('completion-rollback', { principalId: 'owner', sessionId: 'owner-session', capturedAtEpochMs: 1_000 });
                const enqueue = topologyEnqueue(command);
                const completionAttempts: number[] = [];
                const readCompletionFacts = AppInboxTransactionWriter.prototype.readCompletionFacts;
                vi.spyOn(AppInboxTransactionWriter.prototype, 'readCompletionFacts').mockImplementation(function (
                    this: AppInboxTransactionWriter,
                    context
                ) {
                    completionAttempts.push(context.entry.dequeueAudit.attempts);
                    return readCompletionFacts.call(this, context);
                });
                const terminalFailureResults: AppInboxFailure[] = [];
                const writeTerminalFailure = AppInboxTransactionWriter.prototype.writeTerminalFailure;
                vi.spyOn(AppInboxTransactionWriter.prototype, 'writeTerminalFailure').mockImplementation(async function (
                    this: AppInboxTransactionWriter,
                    context,
                    computed
                ) {
                    terminalFailureResults.push(computed.durableResult);
                    return await writeTerminalFailure.call(this, context, computed);
                });
                const pending = topologyServiceFor(harness).processAuthenticatedEntryUntilCompletion(enqueue, harness.sessions.owner);
                await waitForQueueEntry(harness.queue);
                wakes = 0;
                const reserveEntries = harness.queue.reserveEntries.bind(harness.queue);
                let allowDelivery = true;
                vi.spyOn(harness.queue, 'reserveEntries').mockImplementation(async (...args) => {
                    if (!allowDelivery) {
                        return new Map();
                    }
                    const reserved = await reserveEntries(...args);
                    if (reserved.size > 0) {
                        allowDelivery = false;
                    }
                    return reserved;
                });
                vi.spyOn(console, 'error').mockImplementation(() => undefined);

                await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

                expect(harness.runtimeRepository.data).toEqual(before);
                expect(database.outboxEntries.size).toBe(0);
                expect(wakes).toBe(0);
                expect(terminalFailureResults).toEqual([]);
                expect(completionAttempts).toEqual([1]);
                const entry = (await harness.queueEntries()).find((item) => item.key.resourceId === command.requestId)!;
                expect(await harness.results.findByKey(entry.key)).toBeUndefined();

                fail = false;
                allowDelivery = true;
                await new Promise((resolve) => setTimeout(resolve, 5));
                await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

                expect((await pending).right).toMatchObject(
                    operation === 'putConfig'
                        ? { receipt: { outcome: 'applied', attemptCount: 2 } }
                        : { status: 'queued' }
                );
                expect(completionAttempts).toEqual([1, 2]);
                expect(await harness.queue.getItem(entry.key)).toMatchObject({ status: EntityStatus.COMPLETED });
                expect(database.outboxEntries.size).toBe(1);
                expect(wakes).toBe(1);
            });
        }
    }

    it('coalesces concurrent identical commands into one durable mutation and result', async () => {
        let queueWakeCount = 0;
        const wakeQueue = vi.fn(() => {
            queueWakeCount += 1;
        });
        const harness = await createAuthorityHarness(['owner'], { wakeQueue });
        await createRoom(harness, GROUP_REF.groupId, 'Topology room');
        const repository = configureTopology(harness, wakeQueue);
        wakeQueue.mockClear();
        queueWakeCount = 0;
        const initialOutboxCount = harness.database.outboxEntries.size;
        const command = await topologyCommand('same-request', 4);
        const enqueue = topologyEnqueue(command);

        const first = topologyServiceFor(harness).processAuthenticatedEntryUntilCompletion(
            enqueue,
            harness.sessions.owner
        );
        await waitForQueueEntry(harness.queue);
        const second = topologyServiceFor(harness).processAuthenticatedEntryUntilCompletion(
            structuredClone(enqueue),
            harness.sessions.owner
        );
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(firstResult).toEqual(secondResult);
        expect(firstResult.right).toMatchObject({
            receipt: { requestId: command.requestId, outcome: 'applied' }
        });
        expect(await repository.findMutationRecord(GROUP_REF, command.requestId)).toMatchObject({
            requestId: command.requestId,
            commandHash: command.commandHash
        });
        expect(harness.database.outboxEntries.size).toBe(initialOutboxCount + 1);
        expect(queueWakeCount).toBeGreaterThan(0);
    });

    it('rejects concurrent reuse of one queue identity with divergent command content', async () => {
        const harness = await createAuthorityHarness(['owner']);
        await createRoom(harness, GROUP_REF.groupId, 'Topology room');
        configureTopology(harness);
        const firstCommand = await topologyCommand('divergent-request', 4);
        const secondCommand = await topologyCommand('divergent-request', 7);
        const first = topologyServiceFor(harness).processAuthenticatedEntryUntilCompletion(
            topologyEnqueue(firstCommand),
            harness.sessions.owner
        );
        await waitForQueueEntry(harness.queue);

        await expect(
            topologyServiceFor(harness).processAuthenticatedEntryUntilCompletion(
                topologyEnqueue(secondCommand),
                harness.sessions.owner
            )
        ).rejects.toMatchObject({ code: 'app-inbox-idempotency-conflict' });
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        await expect(first).resolves.toMatchObject({ right: expect.any(Object) });
    });

    it('validates equal concurrent HTTP config contenders and materializes one winner', async () => {
        const harness = await createAuthorityHarness(['owner']);
        await createRoom(harness, GROUP_REF.groupId, 'Topology room');
        configureTopology(harness);
        const readIssuedAuthSession = harness.groupStateService.readIssuedAuthSession.bind(
            harness.groupStateService
        );
        let sessionReadCount = 0;
        vi.spyOn(harness.groupStateService, 'readIssuedAuthSession').mockImplementation(
            async (...args) => {
                sessionReadCount += 1;
                return await readIssuedAuthSession(...args);
            }
        );
        let firstMaterializationCount = 0;
        const firstMaterialize = vi.fn(async () => {
            firstMaterializationCount += 1;
            return await topologyCommand('reserved-config-request', 4);
        });
        const renewed = authSession({
            clientId: 'owner',
            sessionId: 'owner-concurrent-session',
            accessToken: 'owner-concurrent-token',
            nowEpochMs: harness.nowEpochMs
        });
        await harness.authSessions.putSession(renewed);
        let secondMaterializationCount = 0;
        const secondMaterialize = vi.fn(
            async () => {
                secondMaterializationCount += 1;
                return await topologyCommand('reserved-config-request', 4, {
                    principalId: renewed.clientId,
                    sessionId: renewed.sessionId,
                    capturedAtEpochMs: 2_000
                });
            }
        );
        const first = topologyServiceFor(harness).processAuthenticatedHttpEntryUntilCompletionResult(
            await configReservation({ callerId: 'owner', requestId: 'reserved-config-request', degreeLimit: 4, materialize: firstMaterialize }),
            harness.sessions.owner
        );
        const second = topologyServiceFor(harness).processAuthenticatedHttpEntryUntilCompletionResult(
            await configReservation({ callerId: 'owner', requestId: 'reserved-config-request', degreeLimit: 4, materialize: secondMaterialize }),
            renewed
        );
        await waitForQueueEntry(harness.queue);
        await vi.waitFor(() => {
            expect(sessionReadCount).toBe(2);
            expect(firstMaterializationCount + secondMaterializationCount).toBe(1);
        });
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(secondResult).toEqual(firstResult);
        expect(firstMaterializationCount + secondMaterializationCount).toBe(1);
    });

    it('replays strict HTTP graph config through renewed credentials', async () => {
        const harness = await createAuthorityHarness(['owner']);
        await createRoom(harness, GROUP_REF.groupId, 'Topology room');
        configureTopology(harness);
        let materializationCount = 0;
        const materialize = vi.fn(async () => {
            materializationCount += 1;
            return await topologyCommand('renewed-config-request', 4);
        });
        const first = topologyServiceFor(harness).processAuthenticatedHttpEntryUntilCompletionResult(
            await configReservation({ callerId: 'owner', requestId: 'renewed-config-request', degreeLimit: 4, materialize: materialize }),
            harness.sessions.owner
        );
        await waitForQueueEntry(harness.queue);
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        const firstResult = await first;

        const renewed = authSession({
            clientId: 'owner',
            sessionId: 'owner-reserved-session',
            accessToken: 'owner-reserved-token',
            nowEpochMs: harness.nowEpochMs
        });
        await harness.authSessions.putSession(renewed);
        let replayMaterializationCount = 0;
        const replayMaterialize = vi.fn(
            async () => {
                replayMaterializationCount += 1;
                return await topologyCommand('renewed-config-request', 4, {
                    principalId: renewed.clientId,
                    sessionId: renewed.sessionId,
                    capturedAtEpochMs: 2_000
                });
            }
        );
        await expect(
            topologyServiceFor(harness).processAuthenticatedHttpEntryUntilCompletionResult(
                await configReservation({ callerId: 'owner', requestId: 'renewed-config-request', degreeLimit: 4, materialize: replayMaterialize }),
                renewed
            )
        ).resolves.toEqual(firstResult);
        expect(materializationCount).toBe(1);
        expect(replayMaterializationCount).toBe(0);
    });

    it('isolates graph topology queue identity by stable principal', async () => {
        const harness = await createAuthorityHarness(['owner', 'other']);
        await createRoom(harness, GROUP_REF.groupId, 'Topology room');
        configureTopology(harness);
        const owner = topologyServiceFor(harness).processAuthenticatedHttpEntryUntilCompletionResult(
            await configReservation({
                callerId: 'owner',
                requestId: 'shared-graph-request',
                degreeLimit: 4,
                materialize: async () => await topologyCommand('shared-graph-request', 4)
            }),
            harness.sessions.owner
        );
        const other = topologyServiceFor(harness).processAuthenticatedHttpEntryUntilCompletionResult(
            await configReservation({
                callerId: 'other',
                requestId: 'shared-graph-request',
                degreeLimit: 4,
                materialize: async () =>
                    await topologyCommand('shared-graph-request', 4, {
                        principalId: 'other',
                        sessionId: 'other-session',
                        capturedAtEpochMs: 1_000
                    })
            }),
            harness.sessions.other
        );
        await vi.waitFor(async () => {
            const entries = (await harness.queueEntries()).filter(
                (entry) => entry.key.resourceId === 'shared-graph-request'
            );
            expect(entries).toHaveLength(2);
            expect(new Set(entries.map((entry) => entry.key.contextId)).size).toBe(2);
        });
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        const settled = await Promise.allSettled([owner, other]);
        expect(settled).not.toContainEqual(
            expect.objectContaining({
                reason: expect.objectContaining({ code: 'app-inbox-idempotency-conflict' })
            })
        );
    });

    it('materializes admin recompute facts once and isolates different principals', async () => {
        const harness = await createAuthorityHarness(['owner', 'other']);
        await createRoom(harness, GROUP_REF.groupId, 'Topology room');
        configureTopology(harness);
        let materializationCount = 0;
        const materialize = vi.fn(async () => {
            materializationCount += 1;
            return await reconfigureCommand('shared-admin-request', { principalId: 'owner', sessionId: 'owner-session', capturedAtEpochMs: 1_000 });
        });
        const first = topologyServiceFor(harness).processAuthenticatedHttpEntryUntilCompletionResult(
            await adminReconfigureReservation('owner', materialize),
            harness.sessions.owner
        );
        await waitForQueueEntry(harness.queue);
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        const firstResult = await first;

        const renewed = authSession({
            clientId: 'owner',
            sessionId: 'owner-renewed-session',
            accessToken: 'owner-renewed-token',
            nowEpochMs: harness.nowEpochMs
        });
        await harness.authSessions.putSession(renewed);
        let replayMaterializationCount = 0;
        const replayMaterialize = vi.fn(
            async () => {
                replayMaterializationCount += 1;
                return await reconfigureCommand('shared-admin-request', {
                    principalId: renewed.clientId,
                    sessionId: renewed.sessionId,
                    capturedAtEpochMs: 2_000
                });
            }
        );
        await expect(
            topologyServiceFor(harness).processAuthenticatedHttpEntryUntilCompletionResult(
                await adminReconfigureReservation('owner', replayMaterialize),
                renewed
            )
        ).resolves.toEqual(firstResult);
        expect(materializationCount).toBe(1);
        expect(replayMaterializationCount).toBe(0);

        let otherMaterializationCount = 0;
        const otherMaterialize = vi.fn(async () => {
            otherMaterializationCount += 1;
            return await reconfigureCommand('shared-admin-request', { principalId: 'other', sessionId: 'other-session', capturedAtEpochMs: 3_000 });
        });
        const other = topologyServiceFor(harness).processAuthenticatedHttpEntryUntilCompletionResult(
            await adminReconfigureReservation('other', otherMaterialize),
            harness.sessions.other
        );
        await vi.waitFor(async () => {
            const entries = (await harness.queueEntries()).filter(
                (entry) => entry.key.resourceId === 'shared-admin-request'
            );
            expect(entries).toHaveLength(2);
            expect(new Set(entries.map((entry) => entry.key.contextId)).size).toBe(2);
        });
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        await Promise.allSettled([other]);
        expect(otherMaterializationCount).toBe(1);
    });

    it('rolls back topology state when the RTC APP_OUTBOX write collides', async () => {
        let queueWakeCount = 0;
        const wakeQueue = vi.fn(() => {
            queueWakeCount += 1;
        });
        const harness = await createAuthorityHarness(['owner'], { wakeQueue });
        await createRoom(harness, GROUP_REF.groupId, 'Topology room');
        const repository = new GroupTopologyConfigRepository(harness.runtimeRepository);
        const management = topologyManagement(harness, repository);
        wakeQueue.mockClear();
        queueWakeCount = 0;
        const initialOutboxCount = harness.database.outboxEntries.size;
        const command = await topologyCommand('collision-request', 5);
        const mutationCommand = toTopologyConfigMutationCommand(command);
        const mutation = management.mutationOwners.configMutationService;
        const read = await mutation.read(mutationCommand);
        const attempt = {
            commandHash: command.commandHash,
            capturedAtEpochMs: command.capturedAtEpochMs,
            count: 1
        };
        const computed = computeTopologyConfigMutationAttempt(mutationCommand, read, attempt);
        expect(validateTopologyConfigMutationAttempt({ command: mutationCommand, read, attempt }, computed)).toEqual([]);
        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            throw new Error('Expected a topology config write');
        }
        const expectedEntry = computed.outboxWrite.entry;
        const collisionEntry = {
            ...expectedEntry,
            resource: `${expectedEntry.resource}\n`
        };
        expect(collisionEntry.key).toEqual(expectedEntry.key);
        expect(collisionEntry.resource).not.toBe(expectedEntry.resource);
        await harness.database.begin(async (transaction) => {
            await createPSqlResourceInboxRepository(transaction).entries.writeIfAbsentOrMatch(collisionEntry);
        });
        expect(harness.database.outboxEntries.size).toBe(initialOutboxCount + 1);
        const enqueue = await createAuthenticatedTopologyEnqueue({
            enqueue: topologyEnqueue(command),
            claimedAuthority: harness.sessions.owner,
            groupStateService: harness.groupStateService,
            nowEpochMs: () => harness.nowEpochMs
        });
        const wireEnqueue = decodeAppInboxEnqueue(enqueue);
        const message = newALUntargetedMessage(
            'topology-transaction-test',
            newALRoute(
                requireTopologyIdentity(wireEnqueue.topicId, 'topicId'),
                requireTopologyIdentity(wireEnqueue.contextId, 'contextId'),
                requireTopologyIdentity(wireEnqueue.resourceId, 'resourceId')
            ),
            wireEnqueue.type,
            wireEnqueue
        );
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(
            message,
            EnqueuedType.APP_INBOX
        );
        const handler = new TopologyAppInboxHandler({
            groupStateService: harness.groupStateService,
            nowEpochMs: () => harness.nowEpochMs,
            wakeQueue,
            transactionWriter: {
                readCompletionFacts: (context) => ({ entry: context.entry, completedAtEpochMs: harness.nowEpochMs }),
                writeMutation: async (_context, computed, write) => {
                    await harness.database.begin(write);
                    return computed.durableResult;
                }
            }
        });

        await expect(
            handler.processMutation(
                {
                    enqueue: wireEnqueue,
                    message,
                    entry: { ...entry, status: EntityStatus.RESERVED, dequeueAudit: { ...entry.dequeueAudit, attempts: 1 } }
                } satisfies AppInboxExecutionMetadata,
                management.mutationOwners
            )
        ).rejects.toMatchObject({ code: 'resource-inbox-invariant-corruption' });
        expect(await repository.findConfig(GROUP_REF)).toBeUndefined();
        expect(await repository.findMutationRecord(GROUP_REF, command.requestId)).toBeUndefined();
        expect(harness.database.outboxEntries.size).toBe(initialOutboxCount + 1);
        expect(
            [...harness.database.outboxEntries.values()].find(
                (entry) => entry.key.resourceId === collisionEntry.key.resourceId
            )
        ).toMatchObject({ key: collisionEntry.key, resource: collisionEntry.resource });
        expect(queueWakeCount).toBe(0);
    });
});

function configureTopology(
    harness: AuthorityHarness,
    wakeQueue?: () => void,
    database: AuthorityHarness['database'] = harness.database
): GroupTopologyConfigRepository {
    const repository = new GroupTopologyConfigRepository(harness.runtimeRepository);
    const management = topologyManagement(harness, repository);
    topologyServices.set(
        harness,
        new TopologyInboxService(
            {
                inboxQueueReader: harness.reader,
                resourceInboxRepository: harness.queue,
                resourceInboxResultsRepository: harness.results,
                database,
                groupStateService: harness.groupStateService,
                mutationOwners: management.mutationOwners
            },
            {
                serviceId: 'server-12345678',
                wakeOwningQueue: wakeQueue
            }
        )
    );
    return repository;
}

function topologyServiceFor(harness: AuthorityHarness): TopologyInboxService {
    const service = topologyServices.get(harness);
    if (!service) {
        throw new TypeError('Topology inbox service is not configured for this harness');
    }
    return service;
}

function topologyManagement(
    harness: AuthorityHarness,
    repository: GroupTopologyConfigRepository
): TopologyTestOwners {
    const runtimeOwners = createGroupTopologyRuntimeOwners({
        findGroupSnapshotByRef: (ref) => harness.groupStateService.readSnapshot(ref),
        readCurrentGroupSnapshot: async (ref) => await harness.repository.readSnapshot(ref),
        readRttMeasurements: () => [],
        configRepository: repository,
        topologyService: new RallarRtcTopologyService()
    });
    const mutationOwners = createGroupTopologyMutationOwners({
        groupStateRepository: harness.repository,
        configRepository: repository,
        planning: runtimeOwners.planning,
        nowEpochMs: () => harness.nowEpochMs,
        isPlatformAdmin: (principalId) => principalId === 'owner' || principalId === 'other',
        outboxWriter: new RtcTopologyOutboxWriter({ recordWrite: () => undefined })
    });
    return {
        mutationOwners: {
            configMutationService: mutationOwners.configMutation,
            reconfigureMutation: mutationOwners.reconfigureMutation
        }
    };
}

interface TopologyTestOwners {
    readonly mutationOwners: TopologyAppInboxMutationOwners;
}

interface TopologyCommandFacts {
    readonly principalId: string;
    readonly sessionId: string;
    readonly capturedAtEpochMs: number;
}

async function topologyCommand(
    requestId: string,
    degreeLimit: number,
    facts: TopologyCommandFacts = {
        principalId: 'owner',
        sessionId: 'owner-session',
        capturedAtEpochMs: 1_000
    }
): Promise<TopologyAppInboxCommand> {
    return await toTopologyAppInboxCommand({
        actor: {
            principalId: facts.principalId,
            sessionId: facts.sessionId
        },
        groupRef: GROUP_REF,
        requestId,
        capturedAtEpochMs: facts.capturedAtEpochMs,
        payload: {
            operation: 'putConfig',
            config: { topologyKind: 'tree', degreeLimit }
        }
    });
}

async function reconfigureCommand(
    requestId: string,
    facts: TopologyCommandFacts
): Promise<TopologyAppInboxCommand> {
    return await toTopologyAppInboxCommand({
        actor: { principalId: facts.principalId, sessionId: facts.sessionId },
        groupRef: GROUP_REF,
        requestId,
        capturedAtEpochMs: facts.capturedAtEpochMs,
        payload: { operation: 'reconfigureTopology', requestOptions: {}, publish: true }
    });
}

async function adminReconfigureReservation(
    callerId: string,
    materialize: TopologyInboxService.HttpCommandReservation['materialize']
): Promise<TopologyInboxService.HttpCommandReservation> {
    return {
        operation: 'reconfigureTopology' as const,
        requestId: 'shared-admin-request',
        callerId,
        groupRef: GROUP_REF,
        semanticHash: await toTopologyHttpMutationSemanticHash({
            principalId: callerId,
            groupRef: GROUP_REF,
            requestId: 'shared-admin-request',
            payload: { operation: 'reconfigureTopology', requestOptions: {}, publish: true }
        }),
        materialize
    };
}

interface ConfigReservationInput {
    readonly callerId: string;
    readonly requestId: string;
    readonly degreeLimit: number;
    readonly materialize: TopologyInboxService.HttpCommandReservation['materialize'];
}

async function configReservation(
    input: ConfigReservationInput
): Promise<TopologyInboxService.HttpCommandReservation> {
    const { callerId, requestId, degreeLimit, materialize } = input;
    return {
        operation: 'putConfig' as const,
        requestId,
        callerId,
        groupRef: GROUP_REF,
        semanticHash: await toTopologyHttpMutationSemanticHash({
            principalId: callerId,
            groupRef: GROUP_REF,
            requestId,
            payload: { operation: 'putConfig', config: { topologyKind: 'tree', degreeLimit } }
        }),
        materialize
    };
}

function topologyEnqueue(command: TopologyAppInboxCommand): AppInboxEnqueueInput {
    const type = toTopologyAppInboxType(command.operation);
    return {
        type,
        topicId: type,
        resourceId: command.requestId,
        contextId: `application=${GROUP_REF.applicationId}:workspace=${GROUP_REF.workspaceId}:` +
            `group=${GROUP_REF.groupId}:caller=${command.actor.principalId}`,
        senderId: command.actor.principalId,
        data: command
    };
}

function requireTopologyIdentity(value: string | undefined, field: string): string {
    if (value === undefined || value.length === 0) {
        throw new TypeError(`Topology transaction ${field} is required`);
    }
    return value;
}
