import { describe, expect, it } from 'vitest';

import type { GroupActivationStatusClockWork } from '@shared-server/rallar-system/group-state/activation-status-clock-outbox-entry.ts';
import { computeUpdateGroupActivationStatus } from '@shared-server/rallar-system/group-state/mutation/aggregate/compute-update-group-activation-status.ts';
import type { GroupMutationCommand, GroupMutationRead } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { toUpdateGroupActivationStatusCommand } from '@shared-server/rallar-system/group-state/to-update-group-activation-status-command.ts';
import { resolveGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import {
    RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE,
    RtcTopologySnapshotRepository
} from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { computeGroupTopologyFromAuthority } from '@shared-server/rallar-system/topology/planning/compute-group-topology-from-authority.ts';
import type { GroupTopologyPlanningAuthority } from '@shared-server/rallar-system/topology/planning/group-topology-planning-authority.ts';
import { planRallarRtcTopologySnapshot } from '@shared-server/rallar-system/topology/planning/plan-rallar-rtc-topology-snapshot.ts';
import { createRtcTopologyWorkHandler } from '@shared-server/rallar-system/topology/replay/work/create-rtc-topology-work-handler.ts';
import {
    petitionGroupActivationStatus,
    type PetitionGroupActivationStatusInput
} from '@shared-server/rallar-system/topology/replay/work/group-activation-status-observer.ts';
import {
    computeCoalescedRtcTopologyGroupRevisionWork,
    toCoalescedGroupRevisionKey
} from '@shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import {
    computeAuthorityTopologyInputFingerprint,
    computeRtcTopologyInputFingerprintWrite,
    RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE
} from '@shared-server/rallar-system/topology/replay/work/rtc-topology-input-fingerprint.ts';
import { createGroupTopologyRuntimeOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import { toCanonicalGroupRef, type Group } from '@shared/api/group-types.ts';
import { InMemoryQueueBox } from '@shared/mod.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { FakeRuntimeStateRepository } from '../../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createAppInboxTestDatabase } from '../../../app-inbox/test-support/app-inbox-test-database.ts';
import { createMutationFacts, createMutationRead } from '../../../group-state/group-state-concurrency-test-fixtures.ts';
import { createRtcTopologyGroupSnapshot, createRtcTopologyRttMeasurement } from '../../rtc-topology-test-fixtures.ts';

describe('activation status series settlement', () => {
    it.each(['basis', 'epoch'] as const)('petitions and publishes once for a new %s with no evidence', async (change) => {
        const fixture = createFixture(change, false);
        const petition = await observe(fixture);
        expect(petition.commands).toHaveLength(1);
        expect(petition.clocks).toEqual([]);
        const command = petition.commands[0];
        if (command.operation !== 'updateGroupActivationStatus') {
            throw new Error('Expected activation petition');
        }
        expect(command.input).toMatchObject({ expectedFormationEpoch: 2, expectedLayout: fixture.basis, evidenceWatermark: null });
        const computed = computeUpdateGroupActivationStatus(command, fixture.read, createMutationFacts());
        if (computed.outcome !== 'write' || computed.guard.kind !== 'group' || computed.guard.operation !== 'update') {
            throw new Error('Expected new-series group publication');
        }
        expect(computed.event.eventType).toBe('group-activation-status-changed');
        expect(computed.guard.value).toMatchObject({
            snapshotVersion: 11,
            activationStatus: { condition: 'active', formationEpoch: 2, coverageBasisLayoutIdentity: fixture.basis }
        });
        const settled = {
            ...fixture,
            read: { ...fixture.read, group: { ...fixture.read.group!, value: computed.guard.value } },
            authority: { ...fixture.authority, group: { ...fixture.authority.group, group: computed.guard.value } }
        };
        expect(await observe(settled)).toEqual({ commands: [], clocks: [] });
        expect(computeUpdateGroupActivationStatus(command, settled.read, createMutationFacts()).outcome).toBe('no-op');
    });

    it('completes the status-only automatic follow-up without advancing planned or accepted identity', async () => {
        const fixture = createFixture('basis', false);
        let current = fixture.authority.group;
        const runtime = new FakeRuntimeStateRepository();
        const snapshots = new RtcTopologySnapshotRepository(runtime);
        const accepted = new RtcTopologySnapshotRepository(runtime, RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE);
        const executions = new RtcTopologyExecutionRepository(runtime);
        const queue = new InMemoryQueueBox();
        const outboxQueueReader = new OutboxQueueReader(queue);
        const database = createAppInboxTestDatabase(queue, { replace: async (entry) => entry }, { runtimeRepository: runtime });
        const planning = createGroupTopologyRuntimeOwners({
            findGroupSnapshotByRef: () => current,
            readCurrentGroupSnapshot: async () => current,
            readRttMeasurements: () => [],
            topologyService: new RallarRtcTopologyService({ rttReplanMinimumLayoutAgeMs: 15_000, now: () => 2_000 }),
            topologySnapshotRepository: snapshots
        }).planning;
        const authority = await planning.readTopologyPlanningAuthority({ groupRef: toCanonicalGroupRef(current.group) });
        const plan = computeGroupTopologyFromAuthority(authority, undefined, { intent: 'full-rebuild', origin: 'automatic' });
        if (plan.action !== 'planned') {
            throw new Error('Expected persisted initial layout');
        }
        const basis = toGroupLayoutIdentity(plan.snapshot);
        current = { ...current, group: { ...current.group, acceptedLayoutIdentity: basis } };
        await snapshots.commitSnapshotGuard(plan.snapshot, null);
        await accepted.commitSnapshotGuard(plan.snapshot, null);
        const fingerprint = computeRtcTopologyInputFingerprintWrite(current.group, computeAuthorityTopologyInputFingerprint(authority));
        await runtime.upsert(RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE, fingerprint.key, fingerprint.value, Date.parse(fingerprint.expireAtIsoTimestamp));
        const publications: string[] = [];
        const handler = createRtcTopologyWorkHandler({
            nowEpochMs: () => 2_000,
            finishedRetentionMs: 3_600_000,
            outboxQueueReader,
            database,
            topologyPlanning: planning,
            executionRepository: executions,
            activationStatus: {
                readLifecyclePolicy: async () => fixture.read.lifecyclePolicy!,
                armStatusClock: async () => {
                    throw new Error('Zero-evidence status must not arm a clock');
                },
                submitCommand: async (command) => {
                    if (command.operation !== 'updateGroupActivationStatus') {
                        throw new Error('Expected activation command');
                    }
                    const computed = computeUpdateGroupActivationStatus(
                        command,
                        { ...fixture.read, group: { ...fixture.read.group!, value: current.group } },
                        createMutationFacts()
                    );
                    if (computed.outcome === 'write' && computed.guard.kind === 'group' && computed.guard.operation === 'update') {
                        publications.push(computed.event.eventType);
                        current = { ...current, group: computed.guard.value, causalRevision: computed.receipt.causalRevision };
                    }
                }
            }
        });
        for (let delivery = 0; delivery < 2; delivery++) {
            const work = computeCoalescedRtcTopologyGroupRevisionWork({
                traceId: 'trace-group-activation-series-settlement',
                aggregateRef: toCanonicalGroupRef(current.group),
                groupSnapshot: current,
                requestedAtEpochMs: 2_000 + delivery,
                expireAtEpochMs: Date.now() + 60_000,
                timing: { window: { debounceMs: 0, maxWaitMs: 0 }, replanNotBeforeEpochMs: null, expectedMembersArrived: false },
                senderId: 'status-follow-up',
                origin: 'automatic',
                previousEntry: await queue.getItem(toCoalescedGroupRevisionKey(current.group)) ?? null
            });
            if (work.expectedEntry === null) {
                await queue.enqueueIfAbsent(work.entryWrite.entry);
            }
            else {
                await queue.replaceIfObserved(work.expectedEntry, work.entryWrite.entry);
            }
            const reserved = await queue.reserveEntries({
                typeIds: OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
                statusIds: new Set([EntityStatus.NEW]),
                reservationInput: 1
            });
            const entry = [...reserved.values()][0];
            if (entry === undefined) {
                throw new Error('Expected automatic follow-up reservation');
            }
            await handler.onMessage(decodePersistedALMessage(entry.resource), entry);
            expect((await queue.getItem(entry.key))?.status).toBe(EntityStatus.COMPLETED);
        }
        expect(publications).toEqual(['group-activation-status-changed']);
        expect(current.group.snapshotVersion).toBe(11);
        expect(current.group.activationStatus).toMatchObject({ condition: 'active', formationEpoch: 2, coverageBasisLayoutIdentity: basis });
        expect(current.group.acceptedLayoutIdentity).toEqual(basis);
        expect(await snapshots.findSnapshot(current.group)).toEqual(plan.snapshot);
        expect(await accepted.findSnapshot(current.group)).toEqual(plan.snapshot);
        expect([...database.outboxEntries.values()]).toEqual([]);
    });

    it('publishes a confirmed dwell without arming an evidence-expiry clock', async () => {
        const fixture = withPartialStarCoverage(createFixture('basis', true));
        const result = await observe(fixture, { satisfied: true, dueAtEpochMs: 2_000 });
        expect(result.commands).toEqual([expect.objectContaining({
            input: expect.objectContaining({ coverageRate: 0.92, evidenceWatermark: null, dwellSatisfied: true })
        })]);
        expect(result.clocks).toEqual([]);
    });

    it('publishes immediate evidence and arms its expiry in the same series', async () => {
        const fixture = withPartialStarCoverage(createFixture('basis', false));
        const result = await observe(fixture);
        expect(result.commands).toEqual([expect.objectContaining({
            input: expect.objectContaining({ coverageRate: 0.92, evidenceWatermark: { version: 23, createdAtEpochMs: 23 }, dwellSatisfied: false })
        })]);
        expect(result.clocks).toEqual([expect.objectContaining({ kind: 'evidence-expiry', formationEpoch: 2, coverageBasisLayoutIdentity: fixture.basis })]);
    });

    it('suppresses a same-series zero-evidence petition', async () => {
        expect(await observe(createFixture('same', false))).toEqual({ commands: [], clocks: [] });
    });

    it.each(['basis', 'epoch', 'same'] as const)('isolates authoritative hysteresis for %s', (change) => {
        const fixture = createFixture(change, true);
        const command = toUpdateGroupActivationStatusCommand({
            groupRef: toCanonicalGroupRef(fixture.authority.group.group),
            formationEpoch: 2,
            coverageBasisLayoutIdentity: fixture.basis,
            coverageRate: 0.92,
            evidenceWatermark: null,
            dwell: null
        });
        if (command.operation !== 'updateGroupActivationStatus') {
            throw new Error('Expected activation command');
        }
        const computed = computeUpdateGroupActivationStatus(command, fixture.read, createMutationFacts());
        if (change === 'same') {
            expect(computed.outcome).toBe('no-op');
        }
        else {
            expect(computed.outcome).toBe('write');
            expect(
                computed.outcome === 'write' && computed.guard.kind === 'group' && computed.guard.operation === 'update' &&
                    computed.guard.value.activationStatus?.condition
            ).toBe('initialising');
        }
    });

    it.each(['basis', 'epoch', 'same'] as const)('isolates observer hysteresis for %s', async (change) => {
        const fixture = createFixture(change, true);
        const measured = withPartialStarCoverage(fixture);
        const petition = await observe(measured);
        expect(petition.commands).toEqual([]);
        expect(petition.clocks).toEqual([
            expect.objectContaining({
                kind: change === 'same' ? 'evidence-expiry' : 'dwell',
                formationEpoch: 2,
                coverageBasisLayoutIdentity: fixture.basis,
                candidateCondition: change === 'same' ? null : 'degraded'
            })
        ]);
    });
});

function createFixture(change: 'basis' | 'epoch' | 'same', managed: boolean) {
    const base = createMutationRead();
    if (base.group === null) {
        throw new Error('Expected fixture group');
    }
    const group = createRtcTopologyGroupSnapshot(base.group.value.groupId, ['center', ...Array.from({ length: 25 }, (_, index) => `spoke-${index}`)]);
    const authority: GroupTopologyPlanningAuthority = {
        group: { ...group, group: { ...group.group, lifecycleState: 'active', formationEpoch: 2 } },
        config: resolveGroupTopologyConfig({ serverOptions: { topologyKind: 'star' } }),
        kindHysteresisWidths: { meshExitWidth: 1, treeExitWidth: 1 },
        rttReportingDegreeLimit: 5,
        rttMeasurements: [],
        rttReplanMinimumLayoutAgeMs: 15_000,
        replanning: 'auto',
        nowEpochMs: 2_000
    };
    const spokes = group.activeSessions.slice(1).map(({ sessionId }) => sessionId);
    const plan = planRallarRtcTopologySnapshot({
        group: authority.group,
        topology: 'star',
        degreeLimit: 25,
        nextHopsBySessionId: { center: spokes, ...Object.fromEntries(spokes.map((sessionId) => [sessionId, ['center']])) },
        nowEpochMs: 2_000
    });
    const basis = toGroupLayoutIdentity(plan.snapshot);
    const current: Group = {
        ...authority.group.group,
        snapshotVersion: 10,
        acceptedLayoutIdentity: basis,
        activationStatus: {
            condition: 'active' as const,
            coverageRate: 1,
            coverageBasisLayoutIdentity: change === 'basis' ? { ...basis, groupRevision: basis.groupRevision - 1 } : basis,
            formationEpoch: change === 'epoch' ? 1 : 2,
            evidenceWatermark: null,
            publishedAtEpochMs: 1_000
        }
    };
    const read: GroupMutationRead = {
        ...base,
        group: { ...base.group, value: current },
        lifecyclePolicy: { status: 'present', policy: resolveGroupLifecyclePolicyPreset(managed ? 'managed' : 'optimistic') }
    };
    return {
        read,
        authority: { ...authority, group: { ...authority.group, group: current, causalRevision: { groupRevision: 10, presenceRevision: 0 } } },
        planned: plan.snapshot,
        basis
    };
}

async function observe(fixture: ReturnType<typeof createFixture>, dwell: PetitionGroupActivationStatusInput['dwell'] = null) {
    const commands: GroupMutationCommand[] = [];
    const clocks: GroupActivationStatusClockWork[] = [];
    await petitionGroupActivationStatus({
        dependencies: {
            activationStatus: {
                readLifecyclePolicy: async () => fixture.read.lifecyclePolicy!,
                submitCommand: async (command) => {
                    commands.push(command);
                },
                armStatusClock: async (work) => {
                    clocks.push(work);
                }
            }
        },
        authority: fixture.authority,
        planned: fixture.planned,
        dwell
    });
    return { commands, clocks };
}

function withPartialStarCoverage(fixture: ReturnType<typeof createFixture>) {
    const rttMeasurements = Array.from({ length: 23 }, (_, index) =>
        createRtcTopologyRttMeasurement({
            sessionIdFrom: 'center',
            sessionIdTo: `spoke-${index}`,
            rttMs: 1,
            version: index + 1
        }));
    return { ...fixture, authority: { ...fixture.authority, rttMeasurements } };
}
