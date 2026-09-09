import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import {
    planALMessageHandling,
    type ALMessageHandlingPlan,
    type ALMessagePlanningObservations
} from '@shared/al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionMemoryState
} from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import {
    createALInboundAdmissionStore,
    type ALInboundCommitBundle
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { computeALInboundPlanningObservations } from '@shared/alm/inbound/al-inbound-planner-snapshot.ts';
import {
    computeALInboundWorkEntry,
    toALInboundWorkType
} from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { computeALInboundAdmission } from '@shared/alm/inbound/compute-al-inbound-admission.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { readALInboundEffectFacts } from '@shared/alm/inbound/prepare-al-inbound-commit-bundle.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';

const NAMESPACE = 'inbound-canonical';

interface CanonicalRuntimeFixture {
    readonly state: ALAdmissionMemoryState;
    readonly runtime: ALInboundMessageRuntime;
    readonly admissionStore: ReturnType<typeof createALInboundAdmissionStore>;
    readonly delivered: string[];
    readonly forwarded: string[];
}

describe('inbound canonical message ownership', () => {
    it('stores one inbound message owner and references it from every effect and buffered snapshot', async () => {
        const fixture = createCanonicalRuntime();
        const message = newInboundMessage('message', { orderingKey: 'stream', seq: 1 }, 'hello');

        await fixture.runtime.admitIncomingMessage(message, { kind: 'ws-client', peerId: 'sender' });

        const stored = await fixture.admissionStore.readInboundMessage({
            senderId: 'sender',
            msgId: message.id.msgId
        });
        expect(stored).toEqual(message);
        const rows = await readAllWorkRows(fixture.state.workQueue);
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            expect(row.resource).not.toContain('"text":"hello"');
            expect(row.resource).toContain(`"msgId":"${message.id.msgId}"`);
        }
        await expect.poll(() => fixture.delivered).toEqual([message.id.msgId]);
        expect(fixture.forwarded).toEqual([message.id.msgId]);
    });

    it('names the canonical message from a buffered ordering slot instead of copying it', async () => {
        const fixture = createCanonicalRuntime();
        const gapped = newInboundMessage('gapped', { orderingKey: 'stream', seq: 2 }, 'buffered');

        await fixture.runtime.admitIncomingMessage(gapped, { kind: 'ws-client', peerId: 'sender' });

        const buffered = [...fixture.state.data.values()].filter((value) => value.key.includes(':buffered:'));
        expect(buffered).toHaveLength(1);
        expect(JSON.stringify(buffered[0]!.value)).not.toContain('"text":"buffered"');
        expect(buffered[0]!.value).toMatchObject({
            seq: 2,
            message: { senderId: 'sender', msgId: gapped.id.msgId }
        });
        const release = await fixture.admissionStore.readBufferedRelease({
            trackKey: toALOrderingTrackKey(gapped)!,
            seq: 2,
            nowMs: Date.now()
        });
        expect(release?.snapshot.msg).toEqual(gapped);
    });

    it('clamps a late re-extended buffered slot to the retention of the row it names', async () => {
        const bufferedAtMs = 1_800_000_000_000;
        const releasedAtMs = bufferedAtMs + 40 * 60_000;
        const retention = normalizeALRuntimeStoreRetention();
        const clock = { nowMs: bufferedAtMs };
        const state = createInMemoryALAdmissionState(new InMemoryQueueBox());
        const admissionStore = createALInboundAdmissionStore({
            namespace: NAMESPACE,
            backend: new InMemoryAdmissionBackend(state, () => clock.nowMs),
            orderingTrackTtlMs: retention.repositoryTtlMs,
            supersedenceTrackTtlMs: retention.repositoryTtlMs,
            retention,
            nowMs: () => clock.nowMs
        });
        const gapped = newInboundMessage('gapped', { orderingKey: 'stream', seq: 2 }, 'buffered');
        const trackKey = toALOrderingTrackKey(gapped)!;

        await admitMessage(admissionStore, gapped, clock.nowMs);
        const owner = state.data.get(`${NAMESPACE}:message:sender:${gapped.id.msgId}`);
        clock.nowMs = releasedAtMs;
        const release = await admitMessage(
            admissionStore,
            newInboundMessage('gapped', { orderingKey: 'stream', seq: 1 }, 'predecessor'),
            clock.nowMs
        );

        // The deadline-less release work outlives the canonical row, so the fence must stop at that row.
        const releaseEffect = release.durableEffects.find((effect) => effect.payload.kind === 'release-buffered');
        expect(releaseEffect?.expireAtTimestamp).toBe(releasedAtMs + retention.durableEffectTtlMs);
        expect(releaseEffect!.expireAtTimestamp).toBeGreaterThan(owner!.expireAtTimestamp);
        expect(state.data.get(`${NAMESPACE}:buffered:${trackKey}:2`)?.expireAtTimestamp)
            .toBe(owner!.expireAtTimestamp);
        const buffered = await admissionStore.readBufferedRelease({ trackKey, seq: 2, nowMs: clock.nowMs });
        expect(buffered?.snapshot.msg).toEqual(gapped);
        expect(await admissionStore.readOrderedDelivery(trackKey, 3)).toEqual({
            completedThrough: 0,
            predecessor: { kind: 'effect' }
        });
    });

    it('marks a delivery whose canonical message row is missing as NON_RETRYABLE', async () => {
        const fixture = createCanonicalRuntime();
        const message = newInboundMessage('missing-owner', undefined, 'hello');
        const work = computeALInboundWorkEntry({
            namespace: NAMESPACE,
            observedAtMs: Date.now(),
            effectId: 'dispatch-without-owner',
            expireAtTimestamp: Date.now() + 60_000,
            payload: { kind: 'dispatch-local', message: { senderId: 'sender', msgId: message.id.msgId } }
        });
        const nowMs = Date.now();
        const source = { kind: 'ws-client' as const, peerId: 'sender' };
        const read = await fixture.admissionStore.readIncomingMessage({
            msg: message,
            source,
            nowMs,
            prePlan: planIncomingMessage(message, source, { nowMs })
        });

        await fixture.admissionStore.commitBundle({
            admissionExpiresAtMs: null,
            senderId: message.id.senderId,
            observations: read.observations,
            mutations: [],
            durableEffects: [work]
        });
        await fixture.runtime.ready();

        await expect.poll(async () => (await fixture.state.workQueue.getItem(work.entry.key))?.status)
            .toBe(EntityStatus.NON_RETRYABLE);
        expect(fixture.delivered).toEqual([]);
    });
});

function createCanonicalRuntime(): CanonicalRuntimeFixture {
    const state = createInMemoryALAdmissionState(new InMemoryQueueBox());
    const admissionStore = createALInboundAdmissionStore({
        namespace: NAMESPACE,
        backend: new InMemoryAdmissionBackend(state, () => Date.now()),
        orderingTrackTtlMs: 5 * 60_000,
        supersedenceTrackTtlMs: 5 * 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    const resources = createDefaultALInboundRuntimeResources({
        selfPeerId: 'receiver',
        toInboxEntry: (incoming) => QueueBoxUtilities.toResourceEntryFromMsg(incoming, 'inbox'),
        stores: { admissionStore, workQueue: state.workQueue }
    });
    const delivered: string[] = [];
    const forwarded: string[] = [];
    const runtime = new ALInboundMessageRuntime({
        ...resources,
        planIncomingMessage,
        dispatchInboxEntry: async (entry) => {
            delivered.push(decodePersistedALMessage(entry.resource).id.msgId);
        },
        sendControlMessage: async () => {},
        forwardMessage: async (outgoing) => {
            forwarded.push(outgoing.id.msgId);
        }
    });
    onTestFinished(() => runtime.dispose());
    return { state, runtime, admissionStore, delivered, forwarded };
}

async function admitMessage(
    admissionStore: ReturnType<typeof createALInboundAdmissionStore>,
    msg: ALMessage,
    nowMs: number
): Promise<ALInboundCommitBundle> {
    const source = { kind: 'ws-client' as const, peerId: 'sender' };
    const read = await admissionStore.readIncomingMessage({
        msg,
        source,
        nowMs,
        prePlan: planIncomingMessage(msg, source, { nowMs })
    });
    const bundle = computeALInboundAdmission({
        read,
        plan: planIncomingMessage(msg, source, computeALInboundPlanningObservations(read)),
        canForward: false,
        facts: readALInboundEffectFacts(nowMs, {
            selfPeerId: 'receiver',
            newControlId: crypto.randomUUID.bind(crypto),
            createInboxEntry: (incoming) => QueueBoxUtilities.toResourceEntryFromMsg(incoming, 'inbox')
        })
    });
    expect(await admissionStore.commitBundle(bundle)).toBe('committed');
    return bundle;
}

function newInboundMessage(
    resourceId: string,
    ordering: ALMessage['ordering'],
    text: string
): ALMessage {
    return {
        ...newALUnicastMessage(
            'sender',
            { topicId: 'chat', resourceId, contextId: 'room' },
            'receiver',
            'chat',
            { text }
        ),
        forwarding: { nextHopPeerIds: ['relay'] },
        ...(ordering === undefined ? {} : { ordering })
    };
}

async function readAllWorkRows(queue: InMemoryQueueBox): Promise<readonly ResourceEntry[]> {
    const rows: ResourceEntry[] = [];
    for (const status of Object.values(EntityStatus)) {
        let cursor = null;
        do {
            const page = await queue.readWorkPage({
                typeId: toALInboundWorkType(NAMESPACE),
                status,
                maxToRead: 32,
                cursor
            });
            rows.push(...page.entries);
            cursor = page.nextCursor;
        }
        while (cursor !== null);
    }
    return rows;
}

function planIncomingMessage(
    message: ALMessage,
    source: ALInboundMessageRuntime.Source,
    observations: ALMessagePlanningObservations
): ALMessageHandlingPlan {
    return planALMessageHandling(message, {
        ...observations,
        selfPeerId: 'receiver',
        fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId,
        connectedPeerIds: ['sender', 'relay'],
        groupMemberPeerIds: ['sender', 'receiver', 'relay'],
        overlayNeighborPeerIds: ['relay']
    });
}
