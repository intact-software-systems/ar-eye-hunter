import { describe, expect, it } from 'vitest';

import type { GroupPresenceSummaryWorkRead } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-effects.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import { requireConditionalWrite } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { validateGroupStateDeltaEnvelope, type GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import type { GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { GroupBarrierRepository } from '../group-barrier-repository.ts';
import { groupRef, SCOPE } from '../mutation/group-mutation-test-runtime.ts';
import { createService, readSummaryWork, requireSnapshot, summaryReservationRead, toSummaryExpansion } from './group-presence-test-runtime.ts';

const BASE_EPOCH_MS = Date.now();

describe('group presence summary coalesced slices', () => {
    it('lists a session disconnected twice in one batch once among the removed ids', async () => {
        const runtime = new GroupBarrierRepository();
        const groupId = 'removed-twice-room';
        await seedOpenGroupWithMember(runtime, groupId, 'bob');
        const eventsBefore = await listEvents(runtime, groupId);
        await connect(runtime, { groupId, principalId: 'bob', generationId: 'generation-1', nowEpochMs: BASE_EPOCH_MS + 1_000 });
        await disconnect(runtime, { groupId, principalId: 'bob', generationId: 'generation-1', nowEpochMs: BASE_EPOCH_MS + 2_000 });
        await connect(runtime, { groupId, principalId: 'bob', generationId: 'generation-2', nowEpochMs: BASE_EPOCH_MS + 3_000 });
        await disconnect(runtime, { groupId, principalId: 'bob', generationId: 'generation-2', nowEpochMs: BASE_EPOCH_MS + 4_000 });

        const deltas = await expandBatch(runtime, groupId, eventsBefore.length);

        expect(deltas.map((delta) => delta.event.eventType)).toEqual([
            'session-connected',
            'session-disconnected',
            'session-connected',
            'session-disconnected'
        ]);
        expect(deltas[0]!.removedSessionIds).toEqual([sessionId(groupId, 'bob')]);
        for (const delta of deltas) {
            expect(() => validateGroupStateDeltaEnvelope(delta)).not.toThrow();
        }
    });

    it('carries the merged slice on the first delta in causal order and each later event\'s own slice', async () => {
        const runtime = new GroupBarrierRepository();
        const groupId = 'merged-slice-room';
        await seedOpenGroupWithMember(runtime, groupId, 'bob');
        const eventsBefore = await listEvents(runtime, groupId);
        await connect(runtime, { groupId, principalId: 'alice', generationId: 'generation-1', nowEpochMs: BASE_EPOCH_MS + 1_000 });
        await connect(runtime, { groupId, principalId: 'bob', generationId: 'generation-1', nowEpochMs: BASE_EPOCH_MS + 2_000 });
        await createService({ runtimeRepository: runtime, nowEpochMs: BASE_EPOCH_MS + 3_000, attemptCount: 1, injectedRandomId: undefined, timing: undefined })
            .joinGroup(SCOPE, groupId, {
                actorPrincipalId: 'carol',
                requestId: `join-${groupId}-carol`
            });
        await connect(runtime, { groupId, principalId: 'carol', generationId: 'generation-1', nowEpochMs: BASE_EPOCH_MS + 4_000 });

        const deltas = await expandBatch(runtime, groupId, eventsBefore.length);

        expect(deltas.map((delta) => delta.event.eventType)).toEqual([
            'session-connected',
            'session-connected',
            'member-joined',
            'session-connected'
        ]);
        expect(deltas.map((delta) => delta.event.causalRevision.groupRevision)).toEqual([
            eventsBefore.length,
            eventsBefore.length,
            eventsBefore.length + 1,
            eventsBefore.length + 1
        ]);
        expect(deltas.map(sliceOf)).toEqual([
            { members: ['carol'], sessions: ['alice', 'bob', 'carol'] },
            { members: [], sessions: ['bob'] },
            { members: ['carol'], sessions: [] },
            { members: [], sessions: ['carol'] }
        ]);
        const [first] = deltas;
        for (const delta of deltas) {
            expect(delta.predecessorCausalRevision).toEqual(first!.predecessorCausalRevision);
            expect(delta.resultingCausalRevision).toEqual(first!.resultingCausalRevision);
            expect(delta.activeSessionIds).toEqual(first!.activeSessionIds);
            expect(() => validateGroupStateDeltaEnvelope(delta)).not.toThrow();
        }
    });

    it('computeGroupStateDeltaEnvelope slices grants by the principals its events write', async () => {
        const runtime = new GroupBarrierRepository();
        const declared = 'declared-grant-room';
        await createService({ runtimeRepository: runtime, nowEpochMs: BASE_EPOCH_MS, attemptCount: 1, injectedRandomId: undefined, timing: undefined })
            .createGroup(SCOPE, {
                groupId: declared,
                displayName: declared,
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'alice',
                publicationGrants: { 'room.feed': { publish: true, subscribe: true } },
                requestId: `seed-${declared}`
            });
        const revoked = 'revoked-grant-room';
        await seedOpenGroupWithMember(runtime, revoked, 'bob');
        const revokedBefore = await listEvents(runtime, revoked);
        await setFeedPublish(runtime, { groupId: revoked, publish: true, nowEpochMs: BASE_EPOCH_MS + 1_000 });
        await setFeedPublish(runtime, { groupId: revoked, publish: false, nowEpochMs: BASE_EPOCH_MS + 2_000 });
        const departed = 'departed-grant-room';
        await seedOpenGroupWithMember(runtime, departed, 'bob');
        await setFeedPublish(runtime, { groupId: departed, publish: true, nowEpochMs: BASE_EPOCH_MS + 1_000 });
        const departedBefore = await listEvents(runtime, departed);
        await createService({ runtimeRepository: runtime, nowEpochMs: BASE_EPOCH_MS + 2_000, attemptCount: 1, injectedRandomId: undefined, timing: undefined })
            .upsertMember(SCOPE, departed, 'bob', {
                status: 'left',
                actorPrincipalId: 'bob',
                requestId: `leave-${departed}-bob`
            });

        const [created] = await expandBatch(runtime, declared, 0);
        const revokedDeltas = await expandBatch(runtime, revoked, revokedBefore.length);
        const [left] = await expandBatch(runtime, departed, departedBefore.length);

        expect(created!.event.eventType).toBe('group-created');
        expect(grantSliceOf(created!)).toEqual({ granted: ['alice'], removed: [] });
        expect(created!.publicationGrants[0]!.topics).toEqual({ 'room.feed': { publish: true, subscribe: true } });
        expect(revokedDeltas.map((delta) => delta.event.eventType)).toEqual([
            'publication-grant-changed',
            'publication-grant-changed'
        ]);
        expect(revokedDeltas.map(grantSliceOf)).toEqual([
            { granted: [], removed: ['bob'] },
            { granted: [], removed: ['bob'] }
        ]);
        expect(left!.event.eventType).toBe('member-left');
        expect(grantSliceOf(left!)).toEqual({ granted: [], removed: ['bob'] });
        for (const delta of [created!, ...revokedDeltas, left!]) {
            expect(() => validateGroupStateDeltaEnvelope(delta)).not.toThrow();
        }
    });

    it('claims no write when a later grant committed between the batch\'s claim and its read', async () => {
        const { runtime, work, writeA, writeB } = await seedTwoGrantWrites('claim-read-race-room');

        // A's row was claimed alone, before B committed; A's read, after B committed, sees B's rows.
        const envelopeA = await expandAndCommitAlone(runtime, work, writeA);
        // B's row is claimed by the next tick, after A's expansion committed the summary.
        const envelopeB = await expandAndCommitAlone(runtime, work, writeB);

        expect(toUncoveredGrantWrites([writeA, writeB], [envelopeA, envelopeB])).toEqual([
            { eventId: writeA.eventId, uncovered: [] },
            { eventId: writeB.eventId, uncovered: [] }
        ]);
        expect([envelopeA, envelopeB].map(toStamps)).toEqual([
            { event: writeA.causalRevision, predecessor: writeB.causalRevision, resulting: writeB.causalRevision },
            { event: writeB.causalRevision, predecessor: writeB.causalRevision, resulting: writeB.causalRevision }
        ]);
    });

    it('ends the mirrored order, the later grant expanded first, with a write-nothing delta for the earlier event', async () => {
        const { runtime, work, writeA, writeB } = await seedTwoGrantWrites('mirrored-race-room');

        await expandAndCommitAlone(runtime, work, writeB);
        const envelopeA = await expandAndCommitAlone(runtime, work, writeA);

        expect(toStamps(envelopeA)).toEqual({
            event: writeA.causalRevision,
            predecessor: writeB.causalRevision,
            resulting: writeB.causalRevision
        });
    });

    it('claims no write when another session changed between the batch\'s claim and its read', async () => {
        const runtime = new GroupBarrierRepository();
        const groupId = 'session-race-room';
        await seedOpenGroupWithMember(runtime, groupId, 'bob');
        await connect(runtime, { groupId, principalId: 'bob', generationId: 'generation-1', nowEpochMs: BASE_EPOCH_MS + 1_000 });
        const work = createSummaryWork(runtime);
        const seedEvents = await listEvents(runtime, groupId);
        await expandAndCommitAlone(runtime, work, seedEvents.at(-1)!);
        const before = await requireSnapshot(runtime, groupId);
        await connect(runtime, { groupId, principalId: 'alice', generationId: 'generation-1', nowEpochMs: BASE_EPOCH_MS + 2_000 });
        await connect(runtime, { groupId, principalId: 'bob', generationId: 'generation-2', nowEpochMs: BASE_EPOCH_MS + 3_000 });
        const [writeA, writeB] = (await listEvents(runtime, groupId)).slice(seedEvents.length);

        const envelopes = [
            await expandAndCommitAlone(runtime, work, writeA!),
            await expandAndCommitAlone(runtime, work, writeB!)
        ];

        const after = await requireSnapshot(runtime, groupId);
        const changedSessionIds = before.activeSessions
            .filter((previous) =>
                after.activeSessions.some((session) => session.sessionId === previous.sessionId && session.generationId !== previous.generationId)
            )
            .map((previous) => previous.sessionId);
        expect(changedSessionIds).toEqual([sessionId(groupId, 'bob')]);
        expect(toUncoveredSessionChanges(changedSessionIds, envelopes)).toEqual(
            envelopes.map((envelope) => ({ eventId: envelope.event.eventId, uncovered: [] }))
        );
    });
});

interface UncoveredWrites {
    readonly eventId: string;
    readonly uncovered: readonly string[];
}

/**
 * Per envelope that claims a write (predecessor below resulting), in delivery order: the principals whose grant rows
 * were written at or below its resulting group revision but carried by neither it nor an earlier envelope. A consumer
 * that adopts the resulting revision without those rows holds that revision with the wrong content.
 */
function toUncoveredGrantWrites(
    writes: readonly GroupEvent[],
    envelopes: readonly GroupStateDeltaEnvelope[]
): readonly UncoveredWrites[] {
    const carried = new Set<string>();
    return envelopes.map((envelope) => {
        const slice = grantSliceOf(envelope);
        for (const principalId of [...slice.granted, ...slice.removed]) {
            carried.add(principalId);
        }
        const resultingGroupRevision = envelope.resultingCausalRevision.groupRevision;
        return {
            eventId: envelope.event.eventId,
            uncovered: claimsWrite(envelope)
                ? writes
                    .filter((write) => write.causalRevision.groupRevision <= resultingGroupRevision)
                    .map((write) => String(write.payload.principalId))
                    .filter((principalId) => !carried.has(principalId))
                : []
        };
    });
}

/**
 * Per envelope that claims a write, in delivery order: the sessions a consumer already holds whose record the server
 * changed, carried by neither it nor an earlier envelope. A consumer keeps its stale record for such a session.
 */
function toUncoveredSessionChanges(
    changedSessionIds: readonly string[],
    envelopes: readonly GroupStateDeltaEnvelope[]
): readonly UncoveredWrites[] {
    const carried = new Set<string>();
    return envelopes.map((envelope) => {
        for (const session of envelope.sessions) {
            carried.add(session.sessionId);
        }
        return {
            eventId: envelope.event.eventId,
            uncovered: claimsWrite(envelope)
                ? changedSessionIds.filter((sessionId) => envelope.activeSessionIds.includes(sessionId) && !carried.has(sessionId))
                : []
        };
    });
}

function claimsWrite(envelope: GroupStateDeltaEnvelope): boolean {
    const { predecessorCausalRevision: predecessor, resultingCausalRevision: resulting } = envelope;
    return predecessor.groupRevision !== resulting.groupRevision ||
        predecessor.presenceRevision !== resulting.presenceRevision;
}

function toStamps(envelope: GroupStateDeltaEnvelope) {
    return {
        event: envelope.event.causalRevision,
        predecessor: envelope.predecessorCausalRevision,
        resulting: envelope.resultingCausalRevision
    };
}

interface TwoGrantWrites {
    readonly runtime: GroupBarrierRepository;
    readonly work: GroupPresenceSummaryWork;
    readonly writeA: GroupEvent;
    readonly writeB: GroupEvent;
}

/** bob and carol members with the summary converged, then alice grants bob (A) and carol (B) publish on room.feed. */
async function seedTwoGrantWrites(groupId: string): Promise<TwoGrantWrites> {
    const runtime = new GroupBarrierRepository();
    await seedOpenGroupWithMember(runtime, groupId, 'bob');
    await createService({ runtimeRepository: runtime, nowEpochMs: BASE_EPOCH_MS, attemptCount: 1, injectedRandomId: undefined, timing: undefined })
        .upsertMember(SCOPE, groupId, 'carol', {
            status: 'active',
            actorPrincipalId: 'alice',
            requestId: `activate-${groupId}-carol`
        });
    const work = createSummaryWork(runtime);
    const seedEvents = await listEvents(runtime, groupId);
    await expandAndCommitAlone(runtime, work, seedEvents.at(-1)!);
    await grantFeedPublish(runtime, { groupId, principalId: 'bob', nowEpochMs: BASE_EPOCH_MS + 1_000 });
    await grantFeedPublish(runtime, { groupId, principalId: 'carol', nowEpochMs: BASE_EPOCH_MS + 2_000 });
    const [writeA, writeB] = (await listEvents(runtime, groupId)).slice(seedEvents.length);
    return { runtime, work, writeA: writeA!, writeB: writeB! };
}

interface FeedGrantStep {
    readonly groupId: string;
    readonly principalId: string;
    readonly nowEpochMs: number;
}

/** alice grants a member publish on room.feed. */
async function grantFeedPublish(runtime: GroupBarrierRepository, step: FeedGrantStep): Promise<void> {
    await createService({ runtimeRepository: runtime, nowEpochMs: step.nowEpochMs, attemptCount: 1, injectedRandomId: undefined, timing: undefined })
        .grantGroupPublication(SCOPE, step.groupId, step.principalId, {
            topicId: 'room.feed',
            publish: true,
            subscribe: false,
            actorPrincipalId: 'alice',
            requestId: `grant-${step.groupId}-${step.principalId}-feed`
        });
}

function createSummaryWork(runtime: GroupBarrierRepository): GroupPresenceSummaryWork {
    return new GroupPresenceSummaryWork({
        outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
        recomputeDebounceMs: 0,
        recomputeMaxWaitMs: 0,
        runtimeRepository: runtime,
        now: () => BASE_EPOCH_MS + 10_000,
        serviceId: 'summary-worker',
        senderPeerId: 'ws-server'
    });
}

/**
 * One event's work row expanded alone against the group as it reads now, its summary committed as the worker's write
 * transaction commits it; the delta it emits.
 */
async function expandAndCommitAlone(
    runtime: GroupBarrierRepository,
    work: GroupPresenceSummaryWork,
    event: GroupEvent
): Promise<GroupStateDeltaEnvelope> {
    const command = toSummaryCommand(event);
    const expansion = toSummaryExpansion(command, await readSummaryWork(work, command, BASE_EPOCH_MS + 10_000));
    const computed = work.compute(expansion);
    expect(work.validate(expansion, computed)).toEqual([]);
    const summary = computed.summary;
    if (summary.outcome === 'write') {
        await runtime.begin(async (transaction) => {
            const repository = createTestGroupStateRepository(transaction, runtime.groupStateEventStore);
            requireConditionalWrite(
                summary.operation === 'insert'
                    ? await repository.insertPresenceSummary(summary.summary)
                    : await repository.updatePresenceSummary(summary.summary, summary.expectedRevision)
            );
        });
    }
    return readDeltaEnvelope(computed.downstreamOutboxWrites[0]!.entry.resource);
}

function grantSliceOf(
    delta: GroupStateDeltaEnvelope
): Readonly<{ granted: readonly string[]; removed: readonly string[]; }> {
    return {
        granted: delta.publicationGrants.map((grant) => grant.principalId),
        removed: delta.removedPublicationGrantPrincipalIds
    };
}

interface FeedPublishStep {
    readonly groupId: string;
    readonly publish: boolean;
    readonly nowEpochMs: number;
}

/** alice grants bob publish on room.feed, or revokes it, leaving bob no other permission. */
async function setFeedPublish(runtime: GroupBarrierRepository, step: FeedPublishStep): Promise<void> {
    const service = createService({ runtimeRepository: runtime, nowEpochMs: step.nowEpochMs, attemptCount: 1, injectedRandomId: undefined, timing: undefined });
    const request = {
        topicId: 'room.feed',
        publish: true,
        subscribe: false,
        actorPrincipalId: 'alice',
        requestId: `${step.publish ? 'grant' : 'revoke'}-${step.groupId}-bob-feed`
    };
    await (step.publish
        ? service.grantGroupPublication(SCOPE, step.groupId, 'bob', request)
        : service.revokeGroupPublication(SCOPE, step.groupId, 'bob', request));
}

function sliceOf(delta: GroupStateDeltaEnvelope): Readonly<{ members: readonly string[]; sessions: readonly string[]; }> {
    return {
        members: delta.members.map((member) => member.principalId),
        sessions: delta.sessions.map((session) => session.principalId)
    };
}

function sessionId(groupId: string, principalId: string): string {
    return `${groupId}-${principalId}-session`;
}

async function seedOpenGroupWithMember(
    runtime: GroupBarrierRepository,
    groupId: string,
    principalId: string
): Promise<void> {
    const service = createService({ runtimeRepository: runtime, nowEpochMs: BASE_EPOCH_MS, attemptCount: 1, injectedRandomId: undefined, timing: undefined });
    await service.createGroup(SCOPE, {
        groupId,
        displayName: groupId,
        kind: 'room',
        joinMode: 'open',
        maxMembers: 10,
        createdByPrincipalId: 'alice',
        requestId: `seed-${groupId}`
    });
    await service.upsertMember(SCOPE, groupId, principalId, {
        status: 'active',
        actorPrincipalId: 'alice',
        requestId: `activate-${groupId}-${principalId}`
    });
}

/** One presence session generation of a member, connected or disconnected at its own instant. */
interface PresenceSessionStep {
    readonly groupId: string;
    readonly principalId: string;
    readonly generationId: string;
    readonly nowEpochMs: number;
}

async function connect(runtime: GroupBarrierRepository, step: PresenceSessionStep): Promise<void> {
    const { groupId, principalId, generationId, nowEpochMs } = step;
    await createService({ runtimeRepository: runtime, nowEpochMs, attemptCount: 1, injectedRandomId: undefined, timing: undefined }).connectPresenceSession(
        SCOPE,
        groupId,
        sessionId(groupId, principalId),
        {
            principalId,
            generationId,
            publicationKey: null,
            connectionGenerationId: `ws-${generationId}`,
            actorPrincipalId: principalId,
            expiresAtEpochMs: nowEpochMs + 60_000,
            requestId: `connect-${groupId}-${principalId}-${generationId}`
        }
    );
}

async function disconnect(runtime: GroupBarrierRepository, step: PresenceSessionStep): Promise<void> {
    const { groupId, principalId, generationId, nowEpochMs } = step;
    await createService({ runtimeRepository: runtime, nowEpochMs, attemptCount: 1, injectedRandomId: undefined, timing: undefined }).disconnectPresenceSession(
        SCOPE,
        groupId,
        sessionId(groupId, principalId),
        {
            generationId,
            connectionGenerationId: `ws-${generationId}`,
            actorPrincipalId: principalId,
            disconnectedAtEpochMs: nowEpochMs,
            requestId: `disconnect-${groupId}-${principalId}-${generationId}`
        }
    );
}

async function listEvents(runtime: GroupBarrierRepository, groupId: string): Promise<readonly GroupEvent[]> {
    return await createTestGroupStateRepository(runtime).listEvents(groupRef(groupId));
}

/** Expands every event after the seed as one pending batch, in the causal order the events were written. */
async function expandBatch(
    runtime: GroupBarrierRepository,
    groupId: string,
    seedEventCount: number
): Promise<readonly GroupStateDeltaEnvelope[]> {
    const work = new GroupPresenceSummaryWork({
        outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
        recomputeDebounceMs: 0,
        recomputeMaxWaitMs: 0,
        runtimeRepository: runtime,
        now: () => BASE_EPOCH_MS + 10_000,
        serviceId: 'summary-worker',
        senderPeerId: 'ws-server'
    });
    const commands = (await listEvents(runtime, groupId)).slice(seedEventCount).map(toSummaryCommand);
    const reads: readonly GroupPresenceSummaryWorkRead[] = (await work.read(
        commands.map((command) => ({
            work: command,
            reservation: summaryReservationRead(command.commandId),
            traceId: 'trace-group-presence-summary-coalesced-slices'
        })),
        BASE_EPOCH_MS + 10_000
    )).right ?? [];
    return commands.map((command, index) => {
        const expansion = toSummaryExpansion(command, reads[index]!);
        const computed = work.compute(expansion);
        expect(work.validate(expansion, computed)).toEqual([]);
        return readDeltaEnvelope(computed.downstreamOutboxWrites[0]!.entry.resource);
    });
}

function toSummaryCommand(event: GroupEvent): GroupPresenceSummaryWorkData {
    return {
        effectKind: 'group-presence-summary',
        aggregateRef: groupRef(event.groupId),
        commandId: `${event.groupId}-${event.eventId}`,
        createdAtEpochMs: event.occurredAtEpochMs,
        expireAtEpochMs: 253_402_300_799_999,
        acceptedCausalRevision: event.causalRevision,
        event
    };
}

function readDeltaEnvelope(resource: string): GroupStateDeltaEnvelope {
    return JSON.parse(decodePersistedALMessage(resource).payload.resource) as GroupStateDeltaEnvelope;
}
