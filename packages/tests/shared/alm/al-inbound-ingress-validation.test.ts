import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { describe, expect, it } from 'vitest';

describe('AL inbound canonical validation', () => {
    it('bounds retained ordered message bytes and admits the rejected identity when capacity becomes available', async () => {
        const fixture = createFixture();
        const base = directMessage();
        const payload = { typeId: 'text', resource: JSON.stringify('x'.repeat(60_000)) };
        try {
            for (let seq = 2; seq <= 18; seq++) {
                const result = await fixture.runtime.handleIncomingMessage({
                    ...base,
                    id: { ...base.id, msgId: `message-${seq}` },
                    payload,
                    route: { ...base.route, resourceId: `message-${seq}` },
                    ordering: { orderingKey: 'ordered', seq }
                }, { kind: 'rtc-peer', peerId: 'sender' });
                expect(result.right?.kind).toBe('admitted');
            }
            const overflow = {
                ...base,
                id: { ...base.id, msgId: 'message-19' },
                payload,
                route: { ...base.route, resourceId: 'message-19' },
                ordering: { orderingKey: 'ordered', seq: 19 }
            };
            const rejected = await fixture.runtime.handleIncomingMessage(overflow, { kind: 'rtc-peer', peerId: 'sender' });
            expect(rejected.right?.kind).toBe('resync-required');
            expect(fixture.delivered).toEqual([]);
            await fixture.runtime.handleIncomingMessage({
                ...base,
                ordering: { orderingKey: 'ordered', seq: 1 }
            }, { kind: 'rtc-peer', peerId: 'sender' });
            const retried = await fixture.runtime.handleIncomingMessage(overflow, { kind: 'rtc-peer', peerId: 'sender' });
            expect(retried.right?.kind).toBe('admitted');
            expect(fixture.delivered).toContain('message');
        }
        finally {
            fixture.runtime.dispose();
        }
    });

    it('does not create receipt history or repair work for an untracked control', async () => {
        const fixture = createFixture();
        const nowMs = Date.now();
        const control = newALAckControlMessage(
            { v: 2, msgId: 'receipt', senderId: 'sender', ts: nowMs },
            { ackedMsgId: 'unknown', fromPeerId: 'sender', toPeerId: 'receiver', status: 'delivered', observedAtEpochMs: nowMs }
        );
        try {
            for (let attempt = 0; attempt < 3; attempt++) {
                const result = await fixture.runtime.handleIncomingMessage(control, { kind: 'rtc-peer', peerId: 'sender' });
                expect(result.right).toEqual({ kind: 'control', handled: false });
            }
            expect(fixture.state.data.size).toBe(0);
            expect(fixture.delivered).toEqual([]);
            expect(fixture.controls).toEqual([]);
        }
        finally {
            fixture.runtime.dispose();
        }
    });

    it('rejects unsupported control types before application dispatch or admission', async () => {
        const fixture = createFixture();
        try {
            const result = await fixture.runtime.handleIncomingMessage({
                ...directMessage(),
                payload: { typeId: 'al.control.future.v5', resource: '{}' }
            }, { kind: 'rtc-peer', peerId: 'sender' });
            expect(result.left?.code).toBe('unsupported');
            expect(fixture.state.data.size).toBe(0);
            expect(fixture.delivered).toEqual([]);
        }
        finally {
            fixture.runtime.dispose();
        }
    });

    it('rejects a forged direct RTC origin without reserving its identity', async () => {
        const fixture = createFixture();
        const message = directMessage();
        try {
            const rejected = await fixture.runtime.handleIncomingMessage(message, { kind: 'rtc-peer', peerId: 'forger' });
            expect(rejected.left?.code).toBe('unauthorized');
            expect(fixture.delivered).toEqual([]);
            expect(fixture.controls).toEqual([]);
            const accepted = await fixture.runtime.handleIncomingMessage(message, { kind: 'rtc-peer', peerId: 'sender' });
            expect(accepted.right?.kind).toBe('admitted');
            expect(fixture.delivered).toEqual(['message']);
        }
        finally {
            fixture.runtime.dispose();
        }
    });

    it('rejects malformed and oversized envelopes as values without dispatching work', async () => {
        const fixture = createFixture();
        try {
            const malformed = await fixture.runtime.handleIncomingMessage({}, { kind: 'rtc-peer', peerId: 'sender' });
            const oversized = await fixture.runtime.handleIncomingMessage({
                ...directMessage(),
                payload: { typeId: 'text', resource: JSON.stringify('a'.repeat(65_536)) }
            }, { kind: 'rtc-peer', peerId: 'sender' });
            expect(malformed.left?.code).toBe('malformed');
            expect(oversized.left?.code).toBe('oversized');
            expect(fixture.delivered).toEqual([]);
            expect(fixture.controls).toEqual([]);
        }
        finally {
            fixture.runtime.dispose();
        }
    });

    it('preserves the logical sender on an explicitly trusted server relay', async () => {
        const fixture = createFixture();
        try {
            const result = await fixture.runtime.handleIncomingMessage(directMessage(), { kind: 'trusted-server' });
            expect(result.right?.kind).toBe('admitted');
            expect(fixture.delivered).toEqual(['message']);
        }
        finally {
            fixture.runtime.dispose();
        }
    });

    it('returns a resynchronization result for an excessive gap without poisoning later admission', async () => {
        const fixture = createFixture();
        const message = directMessage();
        try {
            const outside = await fixture.runtime.handleIncomingMessage({
                ...message,
                ordering: { orderingKey: 'ordered', seq: Number.MAX_SAFE_INTEGER }
            }, { kind: 'rtc-peer', peerId: 'sender' });
            expect(outside.right?.kind).toBe('resync-required');
            expect(fixture.delivered).toEqual([]);
            const corrected = await fixture.runtime.handleIncomingMessage({
                ...message,
                ordering: { orderingKey: 'ordered', seq: 1 }
            }, { kind: 'rtc-peer', peerId: 'sender' });
            expect(corrected.right?.kind).toBe('admitted');
            expect(fixture.delivered).toEqual(['message']);
        }
        finally {
            fixture.runtime.dispose();
        }
    });
});

function directMessage(): ALMessage {
    return {
        id: { v: 2, msgId: 'message', senderId: 'sender', ts: Date.now() },
        route: { topicId: 'chat', resourceId: 'message', contextId: 'room' },
        targets: { mode: 'unicast', toPeerId: 'receiver' },
        delivery: { reliability: 'best-effort', ack: 'none' },
        payload: { typeId: 'text', resource: '"hello"' }
    };
}

function createFixture() {
    const delivered: string[] = [];
    const controls: ALMessage[] = [];
    const state = createInMemoryALAdmissionState();
    const admissionStore = createALInboundAdmissionStore({
        namespace: 'ingress-test',
        backend: new InMemoryAdmissionBackend(state, Date.now),
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    const runtime = new ALInboundMessageRuntime({
        ...createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            stores: { admissionStore },
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        }),
        inbox: new InMemoryQueueBox(),
        planIncomingMessage: (message, source, observations) =>
            planALMessageHandling(message, {
                ...observations,
                selfPeerId: 'receiver',
                fromPeerId: source.kind === 'trusted-server' ? message.id.senderId : source.peerId
            }),
        readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
        dispatchInboxEntry: async (entry) => {
            delivered.push(decodePersistedALMessage(entry.resource).id.msgId);
        },
        sendControlMessage: async (message) => {
            controls.push(message);
        }
    });
    return { runtime, delivered, controls, state };
}
