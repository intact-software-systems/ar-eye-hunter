import { describe, expect, it } from 'vitest';

import { PSqlAdmissionWorkBackend } from '@shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
import {
    newALBroadcastMessage,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { planALMessageHandling, type ALMessageHandlingPlan } from '@shared/al-contracts/al-policy.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { computeALInboundAdmission } from '@shared/alm/inbound/admission/compute-al-inbound-admission.ts';
import {
    createALInboundAdmissionStore,
    type ALInboundAdmissionStore,
    type ALInboundCommitBundle
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { computeALInboundPlanningObservations } from '@shared/alm/inbound/al-inbound-planner-snapshot.ts';
import { readALInboundEffectFacts } from '@shared/alm/inbound/prepare-al-inbound-commit-bundle.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import { createPSqlAdmissionTestStorage } from '../../../shared-server/al-runtime/postgres/create-p-sql-admission-test-storage.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const RESOURCE_ID = 'pickup-1';
const CLAIM_TTL_MS = 3_000;
const STARTED_AT_MS = Date.UTC(2026, 9, 7, 12);

type ClaimStorage = 'memory' | 'pglite';

interface ClaimFixture {
    readonly store: ALInboundAdmissionStore;
    readonly clock: { nowMs: number; };
}

interface ClaimDecision {
    readonly plan: ALMessageHandlingPlan;
    readonly bundle: ALInboundCommitBundle;
}

describe('the exclusive claim key a WS client admission reads', () => {
    it('names the room scope and the route, each part encoded', async () => {
        const message = exclusiveRoomBroadcast('claimant-a', 'exclusive', {
            ...ROOM,
            groupId: 'room/1'
        });

        expect(await readClaimKey(message)).toBe('app/workspace/room%2F1/arena.intent/room/pickup-1');
    });

    it('tells the same route apart in another workspace', async () => {
        const here = exclusiveRoomBroadcast('claimant-a', 'exclusive', ROOM);
        const there = exclusiveRoomBroadcast('claimant-a', 'exclusive', { ...ROOM, workspaceId: 'other' });

        expect(await readClaimKey(here)).not.toBe(await readClaimKey(there));
    });

    it('keys an exclusive room unicast by the room it names', async () => {
        const message = newALUnicastMessage(
            'claimant-a',
            { topicId: 'arena.intent', contextId: 'room', resourceId: RESOURCE_ID },
            'director',
            'pickup-intent.v1',
            {},
            { groupRef: ROOM, ownership: 'exclusive', reliability: 'at-least-once', ack: 'receiver' }
        );

        expect(await readClaimKey(message)).toBe('app/workspace/room-1/arena.intent/room/pickup-1');
    });

    it.each([
        { name: 'a shared room send', message: exclusiveRoomBroadcast('claimant-a', 'shared', ROOM) },
        {
            name: 'an exclusive world broadcast',
            message: newALBroadcastMessage(
                'claimant-a',
                { topicId: 'arena.intent', contextId: 'world', resourceId: RESOURCE_ID },
                'world',
                'pickup-intent.v1',
                {},
                { ownership: 'exclusive' }
            )
        },
        {
            name: 'an exclusive unicast that names no room',
            message: newALUnicastMessage(
                'claimant-a',
                { topicId: 'arena.intent', contextId: 'room', resourceId: RESOURCE_ID },
                'director',
                'pickup-intent.v1',
                {},
                { ownership: 'exclusive', reliability: 'at-least-once', ack: 'receiver' }
            )
        }
    ])('claims nothing for $name', async ({ message }) => {
        expect(await readClaimKey(message)).toBeUndefined();
    });
});

describe.each(['memory', 'pglite'] as const)('the exclusive claim in the inbound admission store over %s', (storage) => {
    it('admits the first exclusive send on a free resource and claims it for the sender until its deadline', async () => {
        const fixture = await createClaimFixture(storage);
        const first = await readClaimDecision(fixture, exclusiveRoomBroadcast('claimant-a', 'exclusive', ROOM));

        expect(first.plan.dropReasonCode).toBeUndefined();
        expect(first.bundle.mutations.filter((mutation) => mutation.kind === 'set-claim')).toEqual([{
            kind: 'set-claim',
            claimKey: 'app/workspace/room-1/arena.intent/room/pickup-1',
            holderPeerId: 'claimant-a',
            expireAtTimestamp: STARTED_AT_MS + CLAIM_TTL_MS
        }]);
        expect(await fixture.store.commitBundle(first.bundle)).toBe('committed');
    });

    it('drops another session\'s exclusive send on the live claim, NACKs it held-by-other and writes nothing', async () => {
        const fixture = await createClaimFixture(storage);
        await claim(fixture, exclusiveRoomBroadcast('claimant-a', 'exclusive', ROOM));

        const second = await readClaimDecision(fixture, exclusiveRoomBroadcast('claimant-b', 'exclusive', ROOM));

        expect(second.plan.dropReasonCode).toBe('held-by-other');
        expect(second.plan.nack).toEqual({
            enabled: true,
            toPeerId: 'claimant-b',
            reason: 'held-by-other',
            missingRanges: []
        });
        expect(second.bundle.mutations).toEqual([]);
        expect(
            second.bundle.durableEffects.map((effect) => effect.payload.kind === 'send-control' ? parseALControlMessage(effect.payload.msg) : effect.payload)
        ).toEqual([{
            type: 'nack',
            payload: expect.objectContaining({
                msgId: second.bundle.observations.msgId,
                toPeerId: 'claimant-b',
                reason: 'held-by-other'
            })
        }]);
    });

    it('admits the holder\'s re-send and moves the claim\'s expiry to its deadline', async () => {
        const fixture = await createClaimFixture(storage);
        await claim(fixture, exclusiveRoomBroadcast('claimant-a', 'exclusive', ROOM));
        fixture.clock.nowMs = STARTED_AT_MS + 1_000;

        const resend = await readClaimDecision(
            fixture,
            exclusiveRoomBroadcast('claimant-a', 'exclusive', ROOM, fixture.clock.nowMs)
        );

        expect(resend.plan.dropReasonCode).toBeUndefined();
        expect(resend.bundle.mutations.filter((mutation) => mutation.kind === 'set-claim')).toEqual([
            expect.objectContaining({ holderPeerId: 'claimant-a', expireAtTimestamp: STARTED_AT_MS + 1_000 + CLAIM_TTL_MS })
        ]);
        expect(await fixture.store.commitBundle(resend.bundle)).toBe('committed');
        fixture.clock.nowMs = STARTED_AT_MS + CLAIM_TTL_MS + 500;
        expect(
            (await readClaimDecision(
                fixture,
                exclusiveRoomBroadcast('claimant-b', 'exclusive', ROOM, fixture.clock.nowMs)
            )).plan.dropReasonCode
        ).toBe('held-by-other');
    });

    it('frees the resource once the claiming message has expired, for the next claimant', async () => {
        const fixture = await createClaimFixture(storage);
        await claim(fixture, exclusiveRoomBroadcast('claimant-a', 'exclusive', ROOM));
        fixture.clock.nowMs = STARTED_AT_MS + CLAIM_TTL_MS + 500;

        const reclaim = await readClaimDecision(
            fixture,
            exclusiveRoomBroadcast('claimant-b', 'exclusive', ROOM, fixture.clock.nowMs)
        );

        expect(reclaim.plan.dropReasonCode).toBeUndefined();
        expect(reclaim.bundle.mutations.filter((mutation) => mutation.kind === 'set-claim')).toEqual([
            expect.objectContaining({ holderPeerId: 'claimant-b' })
        ]);
        expect(await fixture.store.commitBundle(reclaim.bundle)).toBe('committed');
    });

    it('lets a shared send on a claimed resource through without reading or taking the claim', async () => {
        const fixture = await createClaimFixture(storage);
        await claim(fixture, exclusiveRoomBroadcast('claimant-a', 'exclusive', ROOM));

        const shared = await readClaimDecision(fixture, exclusiveRoomBroadcast('claimant-b', 'shared', ROOM));

        expect(shared.plan.dropReasonCode).toBeUndefined();
        expect(shared.bundle.observations.claim).toBeUndefined();
        expect(shared.bundle.mutations.some((mutation) => mutation.kind === 'set-claim')).toBe(false);
    });

    it.each<ALInboundMessageRuntime.Source>([
        { kind: 'rtc-peer', peerId: 'claimant-b' },
        { kind: 'trusted-server' }
    ])('neither reads nor takes a claim for a $kind source', async (source) => {
        const fixture = await createClaimFixture(storage);
        await claim(fixture, exclusiveRoomBroadcast('claimant-a', 'exclusive', ROOM));

        const decision = await readClaimDecision(
            fixture,
            exclusiveRoomBroadcast('claimant-b', 'exclusive', ROOM),
            source
        );

        expect(decision.plan.dropReasonCode).toBeUndefined();
        expect(decision.bundle.observations.claim).toBeUndefined();
        expect(decision.bundle.mutations.some((mutation) => mutation.kind === 'set-claim')).toBe(false);
    });
});

async function createClaimFixture(storage: ClaimStorage): Promise<ClaimFixture> {
    const clock = { nowMs: STARTED_AT_MS };
    const namespace = `exclusive-claim-${crypto.randomUUID()}`;
    const backend = await createClaimBackend(storage, namespace, () => clock.nowMs);
    const store = createALInboundAdmissionStore({
        nowMs: () => clock.nowMs,
        namespace,
        backend,
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    return { store, clock };
}

async function createClaimBackend(
    storage: ClaimStorage,
    namespace: string,
    nowMs: () => number
): Promise<ALAdmissionWorkBackend> {
    if (storage === 'memory') {
        return new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), nowMs);
    }
    const { sql } = await createPSqlAdmissionTestStorage();
    return new PSqlAdmissionWorkBackend(sql, namespace, nowMs);
}

async function claim(fixture: ClaimFixture, message: ALMessage): Promise<void> {
    const decision = await readClaimDecision(fixture, message);
    expect(decision.plan.dropReasonCode).toBeUndefined();
    expect(await fixture.store.commitBundle(decision.bundle)).toBe('committed');
}

/** The admission's own read, plan and bundle, as `ALInboundMessageAdmission.attempt` threads them, at the fixture clock. */
async function readClaimDecision(
    fixture: ClaimFixture,
    message: ALMessage,
    source: ALInboundMessageRuntime.Source = toWsClientSource(message.id.senderId)
): Promise<ClaimDecision> {
    const nowMs = fixture.clock.nowMs;
    const fromPeerId = source.kind === 'trusted-server' ? message.id.senderId : source.peerId;
    const context = { selfPeerId: 'server-1', fromPeerId, nowMs };
    const read = await fixture.store.readIncomingMessage({
        msg: message,
        source,
        nowMs,
        prePlan: planALMessageHandling(message, context)
    });
    const plan = planALMessageHandling(message, { ...context, ...computeALInboundPlanningObservations(read) });
    const facts = readALInboundEffectFacts(nowMs, {
        newControlId: crypto.randomUUID.bind(crypto),
        selfPeerId: 'server-1',
        createInboxEntry: (incoming) => QueueBoxUtilities.toResourceEntryFromMsg(incoming, 'inbox')
    });
    return {
        plan,
        bundle: computeALInboundAdmission({ read, plan, facts, canForward: false, recordedParentPresent: true })
    };
}

function toWsClientSource(peerId: string): ALInboundMessageRuntime.Source {
    return { kind: 'ws-client', peerId, authenticatedScope: { applicationId: 'app', workspaceId: 'workspace' } };
}

/** Sent at `sentAtMs`, so its deadline, and the lease of the claim it takes, is that instant plus the claim TTL. */
function exclusiveRoomBroadcast(
    senderId: string,
    ownership: 'shared' | 'exclusive',
    groupRef: typeof ROOM,
    sentAtMs = STARTED_AT_MS
): ALMessage {
    const message = newALBroadcastMessage(
        senderId,
        { topicId: 'arena.intent', contextId: 'room', resourceId: RESOURCE_ID },
        'room',
        'pickup-intent.v1',
        {},
        { groupRef, ownership }
    );
    return {
        ...message,
        id: { ...message.id, ts: sentAtMs },
        constraints: { expiresAtMs: sentAtMs + CLAIM_TTL_MS }
    };
}

async function readClaimKey(message: ALMessage): Promise<string | undefined> {
    const decision = await readClaimDecision(await createClaimFixture('memory'), message);
    return decision.bundle.observations.claim?.key;
}
