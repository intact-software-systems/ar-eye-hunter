import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import type { GroupStateMutationCommand } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import type { GroupPlannedLayoutRow } from '@shared-server/rallar-system/group-state/mutation/aggregate/compute-planned-layout-promotion.ts';
import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import {
    RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE,
    RtcTopologySnapshotRepository
} from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { createRtcTopologyWorkHandler } from '@shared-server/rallar-system/topology/replay/work/create-rtc-topology-work-handler.ts';
import { createTopologyPromotionWorkHandler } from '@shared-server/rallar-system/topology/replay/work/create-topology-promotion-work-handler.ts';
import {
    computeCoalescedRtcTopologyGroupRevisionWork,
    toCoalescedGroupRevisionKey
} from '@shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import { createGroupTopologyRuntimeOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { resolveBrowserRoomTransportTarget } from '@shared-web/browser/rooms/room-group-state-translation.ts';
import { resolveRtcRoomTransportState } from '@shared-web/browser/rtc/rtc-room-transport-status.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toNormalizedGroupLifecyclePolicy } from '@shared/api/group-lifecycle/to-normalized-group-lifecycle-policy.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { toOverlayInfoForSession, type RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { EntityStatus, InMemoryQueueBox } from '@shared/mod.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { assembleStateSnapshotMessages } from '../../../../../shared/state-snapshot-test-fixture.ts';
import { createAppInboxTestDatabase } from '../../../app-inbox/test-support/app-inbox-test-database.ts';
import { GroupBarrierRepository } from '../../../group-state/group-state-concurrency-test-runtime.ts';
import { createTestGroupStateService } from '../../../group-state/group-state-test-runtime.ts';
import { convergeSummaryForTest } from '../../../group-state/presence/group-presence-test-runtime.ts';

const REF: GroupRef = { applicationId: 'presence-app', workspaceId: 'default', groupId: 'same-session-return' };
const POLICY = toNormalizedGroupLifecyclePolicy({ preset: 'managed', admission: { mode: 'open' } });

describe('automatic topology presence convergence', () => {
    it.each([false, true])('publishes and accepts same-session return with changed config=%s without changing the graph', async (changeConfig) => {
        const fixture = new PresenceConvergenceFixture();
        await fixture.seed();
        const initial = await fixture.requirePlanned();
        expect(initial.sourceGroupStateCausalRevision.presenceRevision).toBe(3);
        expect(initial.version).toBe(2);
        expect((await fixture.accepted.findSnapshot(REF))?.sourceGroupStateCausalRevision.presenceRevision).toBe(3);
        const fingerprintBefore = await fixture.executions.readTopologyInputFingerprint(REF);
        const publishedBefore = fixture.database.outboxEntries.size;

        const returned = await fixture.departAndReturn();
        if (changeConfig) {
            await fixture.configs.commitConfig({
                groupRef: REF,
                config: { topologyKind: 'auto', degreeLimit: 5, treeMinSize: 6, meshMinSize: 16, meshParamK: 2 },
                version: 1,
                createdAtEpochMs: fixture.now,
                updatedAtEpochMs: fixture.now,
                updatedByPrincipalId: 'A',
                requestId: 'change-unused-tree-threshold'
            }, null);
        }
        const staleAccepted = await fixture.accepted.findSnapshot(REF);
        expect(staleAccepted).toBeDefined();
        expect(computeRoomState(returned, staleAccepted!)).toBe('idle');

        await fixture.drainTopology();
        await fixture.drainPromotions();

        const planned = await fixture.requirePlanned();
        const accepted = await fixture.accepted.findSnapshot(REF);
        const current = await fixture.readGroup();
        expect.soft(planned.sourceGroupStateCausalRevision.presenceRevision).toBe(5);
        expect.soft(accepted?.sourceGroupStateCausalRevision.presenceRevision).toBe(5);
        expect.soft(current.group.acceptedLayoutIdentity?.presenceRevision).toBe(5);
        expect.soft(planned.version).toBe(initial.version);
        expect.soft(planned.nextHopsBySessionId).toEqual(initial.nextHopsBySessionId);
        const publications = assembleStateSnapshotMessages(
            [...fixture.database.outboxEntries.values()]
                .filter((entry) => entry.typeId === 'WS_OUTBOX')
                .map((entry) => decodePersistedALMessage(entry.resource)),
            REF,
            fixture.now
        ).map((message) => JSON.parse(message.resource));
        expect.soft(publications).toContainEqual(expect.objectContaining({
            sourceGroupStateCausalRevision: expect.objectContaining({ presenceRevision: 5 }),
            version: initial.version
        }));
        expect.soft(fixture.database.outboxEntries.size).toBeGreaterThan(publishedBefore);
        expect.soft(computeRoomState(current, accepted!)).toBe('open');
        const fingerprintAfter = await fixture.executions.readTopologyInputFingerprint(REF);
        expect(fingerprintAfter === fingerprintBefore).toBe(!changeConfig);
    });

    it.each(['outbox', 'commit'] as const)('rolls back a presence refresh on %s failure and converges on queue redelivery', async (failure) => {
        const fixture = new PresenceConvergenceFixture();
        await fixture.seed();
        const initial = await fixture.requirePlanned();
        const outboxBefore = [...fixture.database.outboxEntries];
        await fixture.departAndReturn();
        fixture.failure = failure;

        await expect(fixture.drainTopology()).rejects.toThrow(failure === 'commit' ? 'Injected commit failure' : 'outbox collision');

        expect(await fixture.requirePlanned()).toEqual(initial);
        expect((await fixture.accepted.findSnapshot(REF))?.sourceGroupStateCausalRevision.presenceRevision).toBe(3);
        expect([...fixture.database.outboxEntries]).toEqual(outboxBefore);
        expect((await fixture.queue.getItem(toCoalescedGroupRevisionKey(REF)))?.status).toBe(EntityStatus.RESERVED);
        fixture.failure = null;

        await fixture.redeliver();
        await fixture.drainPromotions();

        expect((await fixture.requirePlanned()).sourceGroupStateCausalRevision.presenceRevision).toBe(5);
        expect((await fixture.accepted.findSnapshot(REF))?.sourceGroupStateCausalRevision.presenceRevision).toBe(5);
    });

    it('preserves an incomparable tuple reason without writing and rereads a newer winner on redelivery', async () => {
        const fixture = new PresenceConvergenceFixture();
        await fixture.seed();
        const returned = await fixture.departAndReturn();
        const initial = await fixture.snapshots.findSnapshotEntry(REF);
        if (initial === undefined) {
            throw new Error('Expected the current planned row');
        }
        const incomparable = {
            ...initial.value,
            sourceGroupStateCausalRevision: { groupRevision: returned.causalRevision.groupRevision + 1, presenceRevision: 3 }
        };
        expect(await fixture.snapshots.commitSnapshotGuard(incomparable, initial.entry.revision)).toMatchObject({ status: 'accepted' });
        const outboxBefore = [...fixture.database.outboxEntries];
        const begin = fixture.database.begin;
        const readMutation = fixture.executions.readTopologyMutation.bind(fixture.executions);
        let transactions = 0;
        let reads = 0;
        fixture.database.begin = async (write) => {
            transactions += 1;
            return await begin(write);
        };
        fixture.executions.readTopologyMutation = async (ref, workId) => {
            reads += 1;
            return await readMutation(ref, workId);
        };

        await expect.soft(fixture.drainTopology()).rejects.toMatchObject({
            name: 'RuntimeStateWriteConflictError',
            cause: { outcome: 'retry', reason: 'incomparable-causal-revision' }
        });
        expect(transactions).toBe(0);
        expect(reads).toBe(1);
        expect(await fixture.requirePlanned()).toEqual(incomparable);
        expect([...fixture.database.outboxEntries]).toEqual(outboxBefore);
        expect((await fixture.queue.getItem(toCoalescedGroupRevisionKey(REF)))?.status).toBe(EntityStatus.RESERVED);

        const winner = { ...incomparable, sourceGroupStateCausalRevision: { ...incomparable.sourceGroupStateCausalRevision, presenceRevision: 5 } };
        expect(await fixture.snapshots.commitSnapshotGuard(winner, initial.entry.revision + 1)).toMatchObject({ status: 'accepted' });
        await fixture.redeliver();

        expect(reads).toBe(2);
        expect(transactions).toBe(1);
        expect(await fixture.requirePlanned()).toEqual(winner);
        expect([...fixture.database.outboxEntries]).toEqual(outboxBefore);
    });

    it('rejects a stale conditional write and rereads the winner on outer queue redelivery', async () => {
        const fixture = new PresenceConvergenceFixture();
        await fixture.seed();
        await fixture.departAndReturn();
        const initial = await fixture.snapshots.findSnapshotEntry(REF);
        if (initial === undefined) {
            throw new Error('Expected the current planned row');
        }
        const begin = fixture.database.begin;
        let attempts = 0;
        fixture.database.begin = async (write) => {
            attempts += 1;
            if (attempts === 1) {
                expect(await fixture.snapshots.commitSnapshotGuard(initial.value, initial.entry.revision))
                    .toMatchObject({ status: 'accepted' });
            }
            return await begin(write);
        };

        await expect(fixture.drainTopology()).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        expect(attempts).toBe(1);
        expect((await fixture.snapshots.findSnapshotEntry(REF))?.entry.revision).toBe(initial.entry.revision + 1);
        expect((await fixture.requirePlanned()).sourceGroupStateCausalRevision.presenceRevision).toBe(3);

        await fixture.redeliver();
        await fixture.drainPromotions();

        expect((await fixture.requirePlanned()).sourceGroupStateCausalRevision.presenceRevision).toBe(5);
        expect((await fixture.accepted.findSnapshot(REF))?.sourceGroupStateCausalRevision.presenceRevision).toBe(5);
    });
});

class PresenceConvergenceFixture {
    failure: 'outbox' | 'commit' | null = null;
    readonly now = Date.now();
    readonly runtime = new GroupBarrierRepository();
    readonly repository = createTestGroupStateRepository(this.runtime);
    readonly queue = new InMemoryQueueBox();
    readonly outboxQueueReader = new OutboxQueueReader(this.queue);
    readonly snapshots = new RtcTopologySnapshotRepository(this.runtime);
    readonly accepted = new RtcTopologySnapshotRepository(this.runtime, RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE);
    readonly executions = new RtcTopologyExecutionRepository(this.runtime);
    readonly configs = new GroupTopologyConfigRepository(this.runtime);
    readonly database = createAppInboxTestDatabase(this.queue, { replace: async (entry) => entry }, {
        runtimeRepository: this.runtime,
        shouldFailOutboxWrite: () => this.failure === 'outbox',
        onStage: (stage) => {
            if (stage === 'transaction-commit-return' && this.failure === 'commit') {
                throw new Error('Injected commit failure');
            }
        }
    });
    readonly service = createTestGroupStateService({
        runtimeRepository: this.runtime,
        now: () => this.now,
        randomId: () => crypto.randomUUID(),
        serviceId: 'presence-test',
        readPlannedLayoutRow: async (ref) => toLayoutRow(await this.snapshots.findSnapshotEntry(ref)),
        readAcceptedLayoutRow: async (ref) => toLayoutRow(await this.accepted.findSnapshotEntry(ref))
    });
    readonly summary = new GroupPresenceSummaryWork({
        outboxQueueReader: this.outboxQueueReader,
        runtimeRepository: this.runtime,
        now: () => this.now,
        serviceId: 'presence-test',
        recomputeDebounceMs: 0,
        recomputeMaxWaitMs: 0
    });
    readonly planning = createGroupTopologyRuntimeOwners({
        findGroupSnapshotByRef: async (ref) => await this.repository.readSnapshot(ref),
        readCurrentGroupSnapshot: async (ref) => await this.repository.readSnapshot(ref),
        readRttMeasurements: () => [],
        readLifecyclePolicy: async (ref) => await this.repository.readLifecyclePolicy(ref),
        configRepository: this.configs,
        topologySnapshotRepository: this.snapshots,
        topologyService: new RallarRtcTopologyService({ now: () => this.now })
    }).planning;
    readonly handler = createRtcTopologyWorkHandler({
        nowEpochMs: () => this.now,
        outboxQueueReader: this.outboxQueueReader,
        database: this.database,
        topologyPlanning: this.planning,
        executionRepository: this.executions,
        topologyPublication: {
            findCurrentGroup: async (ref) => await this.repository.findGroup(ref) ?? null,
            readLifecyclePolicy: async (ref) => await this.repository.readLifecyclePolicy(ref)
        }
    });
    readonly promotion = createTopologyPromotionWorkHandler({
        nowEpochMs: () => this.now,
        submitCommand: async (command) => await this.applyPromotion(command)
    });
    private readonly promoted = new Set<string>();

    async seed(): Promise<void> {
        await this.service.createGroup(REF, {
            groupId: REF.groupId,
            displayName: 'Same-session room',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: 'A',
            lifecyclePolicy: POLICY,
            requestId: 'create-room'
        });
        for (const principalId of ['B', 'C']) {
            await this.service.upsertMember(REF, REF.groupId, principalId, {
                status: 'active',
                actorPrincipalId: 'A',
                requestId: `join-${principalId}`
            });
        }
        const created = await this.readGroup();
        await this.repository.putGroup({ ...created.group, lifecycleState: 'active' });
        for (const sessionId of ['A', 'B', 'C']) {
            await this.connect(sessionId, `${sessionId}-first`);
            const current = await this.convergePresence(`initial-${sessionId}`);
            if (sessionId === 'B') {
                await this.enqueue(current, 'commanded');
                await this.drainTopology();
                await this.drainPromotions();
            }
        }
        await this.enqueue(await this.convergePresence('initial'), 'commanded');
        await this.drainTopology();
        await this.drainPromotions();
    }

    async departAndReturn(): Promise<GroupSnapshot> {
        await this.service.disconnectPresenceSession(REF, REF.groupId, 'C', {
            principalId: 'C',
            actorPrincipalId: 'C',
            generationId: 'C-first',
            connectionGenerationId: 'ws-C-first',
            requestId: 'depart-C'
        });
        const departure = await this.convergePresence('departure');
        expect(departure.causalRevision.presenceRevision).toBe(4);
        await this.enqueue(departure, 'automatic');
        await this.connect('C', 'C-return');
        const returned = await this.convergePresence('return');
        expect(returned.causalRevision.presenceRevision).toBe(5);
        expect(returned.activeSessions.map((session) => session.sessionId)).toEqual(['A', 'B', 'C']);
        await this.enqueue(returned, 'automatic');
        return returned;
    }

    async redeliver(): Promise<void> {
        const entries = await this.queue.reserveTimeoutEntries({
            typeIds: OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
            reservationInput: { maxToReserve: 1, maxAttempts: 2 },
            timeSinceStartTs: Temporal.Duration.from({ milliseconds: 0 })
        });
        expect(entries.size).toBe(1);
        const entry = [...entries.values()][0];
        expect(entry.dequeueAudit.attempts).toBe(2);
        await this.handler.onMessage(decodePersistedALMessage(entry.resource), entry);
        expect((await this.queue.getItem(entry.key))?.status).toBe(EntityStatus.COMPLETED);
    }

    async connect(sessionId: string, generationId: string): Promise<void> {
        await this.service.connectPresenceSession(REF, REF.groupId, sessionId, {
            principalId: sessionId,
            actorPrincipalId: sessionId,
            generationId,
            connectionGenerationId: `ws-${generationId}`,
            expiresAtEpochMs: this.now + 60_000,
            requestId: `connect-${generationId}`
        });
    }

    async convergePresence(commandId: string): Promise<GroupSnapshot> {
        await convergeSummaryForTest({ work: this.summary, runtime: this.runtime, ref: REF, commandId, nowEpochMs: this.now });
        return await this.readGroup();
    }

    async readGroup(): Promise<GroupSnapshot> {
        const group = await this.repository.readSnapshot(REF);
        if (group === undefined) {
            throw new Error('Expected the seeded group');
        }
        return group;
    }

    async enqueue(group: GroupSnapshot, origin: 'automatic' | 'commanded'): Promise<void> {
        const work = computeCoalescedRtcTopologyGroupRevisionWork({
            aggregateRef: REF,
            groupSnapshot: group,
            origin,
            requestedAtEpochMs: this.now - 2_000,
            expireAtEpochMs: this.now + 60_000,
            timing: { window: { debounceMs: 500, maxWaitMs: 5_000 }, replanNotBeforeEpochMs: null },
            senderId: 'presence-test',
            previousEntry: await this.queue.getItem(toCoalescedGroupRevisionKey(REF)) ?? null
        });
        if (work.expectedEntry === null) {
            await this.queue.enqueueIfAbsent(work.entryWrite.entry);
        }
        else {
            expect(await this.queue.replaceIfObserved(work.expectedEntry, work.entryWrite.entry)).not.toBeNull();
        }
    }

    async drainTopology(): Promise<void> {
        const entries = await this.queue.reserveEntries({
            typeIds: OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
            statusIds: new Set([EntityStatus.NEW, EntityStatus.RETRY]),
            reservationInput: 1
        });
        expect(entries.size).toBe(1);
        const entry = [...entries.values()][0];
        await this.handler.onMessage(decodePersistedALMessage(entry.resource), entry);
        expect((await this.queue.getItem(entry.key))?.status).toBe(EntityStatus.COMPLETED);
    }

    async drainPromotions(): Promise<void> {
        for (const [key, entry] of this.database.outboxEntries) {
            if (!this.promoted.has(key) && entry.key.topicId === 'app-outbox.topology-promotion') {
                await this.promotion.onMessage(decodePersistedALMessage(entry.resource), entry);
                this.promoted.add(key);
            }
        }
    }

    async applyPromotion(command: GroupMutationCommand): Promise<void> {
        const ingress = await this.service.captureTopologyPublicationMutationIngress(command, this.now);
        const mutation: GroupStateMutationCommand = {
            authorityProof: null,
            descriptor: null,
            command: ingress.command,
            facts: { ...ingress.facts, attemptCount: 1 }
        };
        const read = await this.service.read(mutation);
        const computed = this.service.compute(mutation, read);
        expect(this.service.validate(mutation, read, computed)).toEqual([]);
        if (computed.outcome !== 'write') {
            throw new Error(`Promotion must write, received ${computed.outcome}`);
        }
        await this.database.begin(async (transaction) => await this.service.write(transaction, computed));
    }

    async requirePlanned(): Promise<RallarOverlayTopologySnapshot> {
        const planned = await this.snapshots.findSnapshot(REF);
        if (planned === undefined) {
            throw new Error('Expected the planned layout');
        }
        return planned;
    }
}

function toLayoutRow(
    entry: Awaited<ReturnType<RtcTopologySnapshotRepository['findSnapshotEntry']>>
): GroupPlannedLayoutRow | null {
    return entry === undefined ? null : { snapshot: entry.value, revision: entry.entry.revision };
}

function computeRoomState(group: GroupSnapshot, accepted: RallarOverlayTopologySnapshot) {
    const target = resolveBrowserRoomTransportTarget({
        sessionId: 'A',
        snapshot: group,
        acceptedOverlay: toOverlayInfoForSession(accepted, 'A')
    });
    return resolveRtcRoomTransportState({
        mode: 'lazy',
        hasAcceptedLayout: target.acceptedLayoutCoversCurrentPresence,
        transportState: target.transportState,
        desiredPeerCount: target.peerIds.length,
        knownPeerCount: 2,
        activePeerCount: 2,
        readyPeerCount: 2,
        failedPeerCount: 0,
        minReadyPeers: 2
    });
}
