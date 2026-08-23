import { describe, expect, it, vi } from 'vitest';

import type { GroupRef } from '@shared/api/group-types.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import { ResourceInboxRepository } from '@shared-server/queuebox/postgres/resource-inbox-repository.ts';

import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';

import { createGroupTopologyOwners, type GroupTopologyOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-owners.ts';

import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';

import { AppInboxType, type AppInboxMessageContext } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-client.ts';
import { computeRtcTopologyEntry } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';

import { createAuthenticatedTopologyEnqueue } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-authority.ts';
import {
    toTopologyAppInboxCommand,
    toTopologyConfigMutationCommand,
    toTopologyHttpMutationSemanticHash
} from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts';
import { TopologyAppInboxHandler, type TopologyAppInboxMutationOwners } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-handler.ts';
import { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';
import { authSession } from './group-state/group-state-test-runtime.ts';
import {
    createAuthorityHarness,
    createResilience,
    createRoom,
    SCOPE,
    waitForQueueEntry,
    type AuthorityHarness
} from './group-state/inbox/group-state-inbox-test-runtime.ts';

const GROUP_REF: GroupRef = {
    ...SCOPE,
    groupId: 'topology-room'
};
const topologyServices = new WeakMap<AuthorityHarness, TopologyInboxService>();

describe('topology AppInbox transaction and idempotency', () => {
    it('coalesces concurrent identical commands into one durable mutation and result', async () => {
        const wakeQueue = vi.fn();
        const harness = await createAuthorityHarness(['owner'], { wakeQueue });
        await createRoom(harness, GROUP_REF.groupId, 'Topology room');
        const repository = configureTopology(harness, wakeQueue);
        wakeQueue.mockClear();
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
        expect(wakeQueue).toHaveBeenCalled();
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
        const readSession = vi.spyOn(harness.groupStateService, 'readIssuedAuthSession');
        const firstMaterialize = vi.fn(async () => await topologyCommand('reserved-config-request', 4));
        const renewed = authSession({
            clientId: 'owner',
            sessionId: 'owner-concurrent-session',
            accessToken: 'owner-concurrent-token',
            nowEpochMs: harness.nowEpochMs
        });
        await harness.authSessions.putSession(renewed);
        const secondMaterialize = vi.fn(
            async () =>
                await topologyCommand('reserved-config-request', 4, {
                    principalId: renewed.clientId,
                    sessionId: renewed.sessionId,
                    capturedAtEpochMs: 2_000
                })
        );
        const first = topologyServiceFor(harness).processAuthenticatedHttpEntryUntilCompletionResult(
            await configReservation('owner', 'reserved-config-request', 4, firstMaterialize),
            harness.sessions.owner
        );
        const second = topologyServiceFor(harness).processAuthenticatedHttpEntryUntilCompletionResult(
            await configReservation('owner', 'reserved-config-request', 4, secondMaterialize),
            renewed
        );
        await waitForQueueEntry(harness.queue);
        await vi.waitFor(() => {
            expect(readSession).toHaveBeenCalledTimes(2);
            expect(firstMaterialize.mock.calls.length + secondMaterialize.mock.calls.length).toBe(1);
        });
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(secondResult).toEqual(firstResult);
        expect(firstMaterialize.mock.calls.length + secondMaterialize.mock.calls.length).toBe(1);
    });

    it('replays strict HTTP graph config through renewed credentials', async () => {
        const harness = await createAuthorityHarness(['owner']);
        await createRoom(harness, GROUP_REF.groupId, 'Topology room');
        configureTopology(harness);
        const materialize = vi.fn(async () => await topologyCommand('renewed-config-request', 4));
        const first = topologyServiceFor(harness).processAuthenticatedHttpEntryUntilCompletionResult(
            await configReservation('owner', 'renewed-config-request', 4, materialize),
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
        const replayMaterialize = vi.fn(
            async () =>
                await topologyCommand('renewed-config-request', 4, {
                    principalId: renewed.clientId,
                    sessionId: renewed.sessionId,
                    capturedAtEpochMs: 2_000
                })
        );
        await expect(
            topologyServiceFor(harness).processAuthenticatedHttpEntryUntilCompletionResult(
                await configReservation('owner', 'renewed-config-request', 4, replayMaterialize),
                renewed
            )
        ).resolves.toEqual(firstResult);
        expect(materialize).toHaveBeenCalledOnce();
        expect(replayMaterialize).not.toHaveBeenCalled();
    });

    it('isolates graph topology queue identity by stable principal', async () => {
        const harness = await createAuthorityHarness(['owner', 'other']);
        await createRoom(harness, GROUP_REF.groupId, 'Topology room');
        configureTopology(harness);
        const owner = topologyServiceFor(harness).processAuthenticatedHttpEntryUntilCompletionResult(
            await configReservation(
                'owner',
                'shared-graph-request',
                4,
                async () => await topologyCommand('shared-graph-request', 4)
            ),
            harness.sessions.owner
        );
        const other = topologyServiceFor(harness).processAuthenticatedHttpEntryUntilCompletionResult(
            await configReservation(
                'other',
                'shared-graph-request',
                4,
                async () =>
                    await topologyCommand('shared-graph-request', 4, {
                        principalId: 'other',
                        sessionId: 'other-session',
                        capturedAtEpochMs: 1_000
                    })
            ),
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
        const materialize = vi.fn(
            async () => await reconfigureCommand('shared-admin-request', 'owner', 'owner-session', 1_000)
        );
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
        const replayMaterialize = vi.fn(
            async () =>
                await reconfigureCommand(
                    'shared-admin-request',
                    renewed.clientId,
                    renewed.sessionId,
                    2_000
                )
        );
        await expect(
            topologyServiceFor(harness).processAuthenticatedHttpEntryUntilCompletionResult(
                await adminReconfigureReservation('owner', replayMaterialize),
                renewed
            )
        ).resolves.toEqual(firstResult);
        expect(materialize).toHaveBeenCalledOnce();
        expect(replayMaterialize).not.toHaveBeenCalled();

        const otherMaterialize = vi.fn(
            async () => await reconfigureCommand('shared-admin-request', 'other', 'other-session', 3_000)
        );
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
        expect(otherMaterialize).toHaveBeenCalledOnce();
    });

    it('rolls back topology state when the RTC APP_OUTBOX write collides', async () => {
        const wakeQueue = vi.fn();
        const harness = await createAuthorityHarness(['owner'], { wakeQueue });
        await createRoom(harness, GROUP_REF.groupId, 'Topology room');
        const repository = new GroupTopologyConfigRepository(harness.runtimeRepository);
        const management = topologyManagement(harness, repository);
        wakeQueue.mockClear();
        const initialOutboxCount = harness.database.outboxEntries.size;
        const command = await topologyCommand('collision-request', 5);
        const mutationCommand = toTopologyConfigMutationCommand(command);
        const mutation = management.configMutation!;
        const preparation = await mutation.prepare({
            command: mutationCommand,
            commandHash: command.commandHash,
            capturedAtEpochMs: command.capturedAtEpochMs
        });
        const read = await mutation.read(mutationCommand);
        const computed = mutation.compute(preparation, read, 1);
        mutation.validate(preparation, read, 1, computed);
        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            throw new Error('Expected a topology config write');
        }
        const expectedEntry = computeRtcTopologyEntry(computed.outbox);
        const collisionEntry = computeRtcTopologyEntry({
            ...computed.outbox,
            publish: !computed.outbox.publish
        });
        expect(collisionEntry.key).toEqual(expectedEntry.key);
        expect(collisionEntry.resource).not.toBe(expectedEntry.resource);
        await harness.database.begin(async (transaction) => {
            await new ResourceInboxRepository(transaction).writeIfAbsentOrMatch(collisionEntry);
        });
        expect(harness.database.outboxEntries.size).toBe(initialOutboxCount + 1);
        const enqueue = await createAuthenticatedTopologyEnqueue({
            enqueue: topologyEnqueue(command),
            claimedAuthority: harness.sessions.owner,
            groupStateService: harness.groupStateService,
            nowEpochMs: () => harness.nowEpochMs
        });
        const handler = new TopologyAppInboxHandler({
            groupStateService: harness.groupStateService,
            nowEpochMs: () => harness.nowEpochMs,
            wakeQueue,
            transactionWriter: {
                writeMutation: async (_context, write) => await harness.database.begin(write)
            }
        });

        await expect(
            handler.processMutation(
                {
                    enqueue,
                    entry: { dequeueAudit: { attempts: 1 } }
                } as AppInboxMessageContext,
                topologyMutationOwners(management)
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
        expect(wakeQueue).not.toHaveBeenCalled();
    });
});

function configureTopology(
    harness: AuthorityHarness,
    wakeQueue?: () => void
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
                database: harness.database,
                groupStateService: harness.groupStateService,
                mutationOwners: topologyMutationOwners(management)
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
): GroupTopologyOwners {
    return createGroupTopologyOwners({
        findGroupSnapshotByRef: (ref) => harness.groupStateService.readSnapshot(ref),
        groupStateRepository: harness.repository,
        configRepository: repository,
        topologyService: new RallarRtcTopologyService(),
        processRttReader: () => [],
        adminPrincipalIds: new Set(['owner', 'other']),
        now: () => harness.nowEpochMs,
        serviceId: 'server-12345678'
    });
}

function topologyMutationOwners(
    management: GroupTopologyOwners
): TopologyAppInboxMutationOwners {
    if (!management.configMutation || !management.reconfigureMutation) {
        throw new TypeError('Expected complete topology mutation owners');
    }
    return {
        configMutationService: management.configMutation,
        reconfigureMutation: management.reconfigureMutation
    };
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
) {
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
    principalId: string,
    sessionId: string,
    capturedAtEpochMs: number
) {
    return await toTopologyAppInboxCommand({
        actor: { principalId, sessionId },
        groupRef: GROUP_REF,
        requestId,
        capturedAtEpochMs,
        payload: { operation: 'reconfigureTopology', requestOptions: {}, publish: true }
    });
}

async function adminReconfigureReservation(
    callerId: string,
    materialize: () => ReturnType<typeof reconfigureCommand>
) {
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

async function configReservation(
    callerId: string,
    requestId: string,
    degreeLimit: number,
    materialize: () => ReturnType<typeof topologyCommand>
) {
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

function topologyEnqueue(command: Awaited<ReturnType<typeof topologyCommand>>) {
    return {
        type: AppInboxType.TOPOLOGY_CONFIG_PUT,
        topicId: AppInboxType.TOPOLOGY_CONFIG_PUT,
        resourceId: command.requestId,
        contextId: `application=${GROUP_REF.applicationId}:workspace=${GROUP_REF.workspaceId}:` +
            `group=${GROUP_REF.groupId}:caller=${command.actor.principalId}`,
        senderId: command.actor.principalId,
        data: command
    };
}
