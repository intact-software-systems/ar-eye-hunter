import { describe, expect, it, onTestFinished } from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALFrozenMulticastMessage } from '@shared/al-contracts/al-frozen-multicast-audience.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { decodeALAdmissionControlValue } from '@shared/alm/al-admission-value-validation.ts';
import { createDefaultInMemoryALInboundRuntimeStores, createVolatileALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { evictTerminalVolatileInboundMessages } from '@shared/alm/inbound/admission/evict-terminal-volatile-inbound-messages.ts';
import { toALInboundMessageKey, toALInboundMessageReference } from '@shared/alm/inbound/al-inbound-canonical-message.ts';
import { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import {
    computeALInboundWorkEntry,
    decodeALInboundWorkEntry,
    toALInboundWorkType
} from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { toALInboundControlPendingKey } from '@shared/alm/inbound/control/al-inbound-control-rows.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createInboundTestAdmission,
    createInboundTestMessage,
    createInboundTestRuntime,
    INBOUND_TEST_SOURCE,
    planInboundTestMessage
} from '../inbound-runtime-test-fixture.ts';

describe('volatile inbound canonical envelope reclamation', () => {
    it('reclaims a completed direct delivery at the existing sweep while preserving duplicate ownership', async () => {
        const volatileStores = createVolatileALInboundRuntimeStores({ namespace: 'reclaim-volatile' }, undefined);
        const admission = createInboundTestAdmission(volatileStores);
        const message = createInboundTestMessage({ msgId: 'terminal-envelope' });
        const reference = toALInboundMessageReference(message);

        expect((await admission.attempt(message, INBOUND_TEST_SOURCE, planInboundTestMessage)).right)
            .toMatchObject({ kind: 'completed', acceptance: { kind: 'admitted' }, wroteWork: true });
        expect((await volatileStores.admissionStore.readDeliverySurface(reference, Date.now()))?.msg.id.msgId)
            .toBe('terminal-envelope');

        volatileStores.evictExpired();
        expect((await volatileStores.admissionStore.readDeliverySurface(reference, Date.now()))?.msg.id.msgId)
            .toBe('terminal-envelope');

        const keys = await volatileStores.workQueue.getAllKeys();
        expect(keys).toHaveLength(1);
        const entry = await volatileStores.workQueue.getItem(keys[0]);
        expect(entry?.status).toBe(EntityStatus.NEW);
        const reserved = await volatileStores.workQueue.reserveEntries({
            typeIds: new Set([entry!.typeId]),
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: 1
        });
        const [claim] = [...reserved.values()];
        expect(claim.status).toBe(EntityStatus.RESERVED);

        volatileStores.evictExpired();
        expect((await volatileStores.admissionStore.readDeliverySurface(reference, Date.now()))?.msg.id.msgId)
            .toBe('terminal-envelope');

        await volatileStores.workQueue.releaseEntries([{
            entry: claim,
            disposition: { status: EntityStatus.COMPLETED, delayMs: null }
        }]);
        volatileStores.evictExpired();

        expect(await volatileStores.admissionStore.readDeliverySurface(reference, Date.now())).toBeUndefined();
        const fixture = createInboundTestRuntime({
            carrier: 'ws',
            stores: createDefaultInMemoryALInboundRuntimeStores({ namespace: 'reclaim-durable' }),
            volatileStores,
            effectWorkerId: 'al-inbound:reclaim'
        });
        await fixture.runtime.ready();
        expect((await fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right)
            .toEqual({ kind: 'duplicate' });
    });

    it('keeps the original envelope while an ordered delivery is buffered', async () => {
        const stores = createVolatileALInboundRuntimeStores({ namespace: 'reclaim-buffered' }, undefined);
        const admission = createInboundTestAdmission(stores);
        const message = createInboundTestMessage({ msgId: 'buffered-envelope', seq: 2 });
        const reference = toALInboundMessageReference(message);

        expect((await admission.attempt(message, INBOUND_TEST_SOURCE, planInboundTestMessage)).right)
            .toMatchObject({ kind: 'completed', acceptance: { kind: 'admitted' } });
        expect(await stores.workQueue.getAllKeys()).toEqual([]);
        stores.evictExpired();

        expect((await stores.admissionStore.readDeliverySurface(reference, Date.now()))?.msg)
            .toEqual(message);
    });

    it('reclaims unrelated completed delivery while a real release and buffered slot remain live', async () => {
        const stores = createVolatileALInboundRuntimeStores({ namespace: 'reclaim-unrelated-release' }, undefined);
        const admission = createInboundTestAdmission(stores);
        const eligible = createInboundTestMessage({ msgId: 'eligible-unrelated' });
        const buffered = createInboundTestMessage({ msgId: 'held-successor', seq: 2 });
        const predecessor = createInboundTestMessage({ msgId: 'live-predecessor', seq: 1 });

        expect((await admission.attempt(eligible, INBOUND_TEST_SOURCE, planInboundTestMessage)).right)
            .toMatchObject({ kind: 'completed', acceptance: { kind: 'admitted' } });
        const [key] = await stores.workQueue.getAllKeys();
        const entry = await stores.workQueue.getItem(key);
        const reserved = await stores.workQueue.reserveEntries({
            typeIds: new Set([entry!.typeId]),
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: 1
        });
        const [claim] = [...reserved.values()];
        await stores.workQueue.releaseEntries([{
            entry: claim,
            disposition: { status: EntityStatus.COMPLETED, delayMs: null }
        }]);
        expect((await admission.attempt(buffered, INBOUND_TEST_SOURCE, planInboundTestMessage)).right)
            .toMatchObject({ kind: 'completed', acceptance: { kind: 'admitted' } });
        expect((await admission.attempt(predecessor, INBOUND_TEST_SOURCE, planInboundTestMessage)).right)
            .toMatchObject({ kind: 'completed', acceptance: { kind: 'admitted' } });
        const workKeys = await stores.workQueue.getAllKeys();
        const work = await Promise.all(workKeys.map((workKey) => stores.workQueue.getItem(workKey)));
        expect(work.some((row) =>
            row !== undefined &&
            decodeALInboundWorkEntry(row, stores.admissionStore.namespace).payload.kind === 'release-buffered'
        ))
            .toBe(true);
        expect(
            await stores.admissionStore.readBufferedRelease({
                trackKey: toALOrderingTrackKey(buffered)!,
                seq: 2,
                nowMs: Date.now()
            })
        ).toBeDefined();

        stores.evictExpired();

        expect(await stores.admissionStore.readDeliverySurface(toALInboundMessageReference(eligible), Date.now()))
            .toBeUndefined();
        expect((await stores.admissionStore.readDeliverySurface(toALInboundMessageReference(buffered), Date.now()))?.msg)
            .toEqual(buffered);
    });

    it('does not sweep between an expired pending observation and an active or queued write on shared state', async () => {
        const namespace = 'reclaim-interleaving';
        const clock = { nowMs: Date.now() };
        const state = createInMemoryALAdmissionState();
        const first = new InMemoryAdmissionBackend(state, () => clock.nowMs);
        const second = new InMemoryAdmissionBackend(state, () => clock.nowMs);
        const observer = new InMemoryAdmissionBackend(state, () => clock.nowMs);
        const message = createInboundTestMessage({ msgId: 'interleaved-envelope' });
        const reference = toALInboundMessageReference(message);
        const messageKey = toALInboundMessageKey(namespace, reference);
        const pendingKey = toALInboundControlPendingKey(namespace, reference.msgId, reference.senderId);
        const work = computeALInboundWorkEntry({
            namespace,
            effectId: 'owed-child-forward',
            payload: { kind: 'forward-message', message: reference, fromPeerId: reference.senderId },
            observedAtMs: clock.nowMs,
            expireAtTimestamp: clock.nowMs + 60_000,
            carrier: 'ws'
        });
        await first.write(async (tx) => {
            await tx.set(messageKey, {
                msgId: reference.msgId,
                senderId: reference.senderId,
                msg: message,
                retainUntilMs: clock.nowMs + 60_000
            }, clock.nowMs + 60_000);
            await tx.set(pendingKey, {
                kind: 'pending',
                value: {
                    toPeerId: reference.senderId,
                    status: 'subtree-complete',
                    localReady: false,
                    expectedFromPeerIds: ['owed-child'],
                    ackedFromPeerIds: [],
                    carrier: 'ws'
                }
            }, clock.nowMs + 5);
        });
        let markEntered!: () => void;
        const entered = new Promise<void>((resolve) => {
            markEntered = resolve;
        });
        let releaseHeld!: () => void;
        const held = new Promise<void>((resolve) => {
            releaseHeld = resolve;
        });
        const active = first.write(async (tx) => {
            expect(await tx.read(pendingKey, (value) => decodeALAdmissionControlValue(value, reference.msgId, 'pending')))
                .toBeDefined();
            markEntered();
            await held;
            expect(await tx.readWork(work.entry.key)).toBeUndefined();
            tx.writeWork(work.entry);
        });
        await entered;
        const queued = second.write(async (tx) => {
            await tx.set(`${namespace}:dedup:after-active`, clock.nowMs + 60_000, clock.nowMs + 60_000);
        });
        clock.nowMs += 10;
        observer.evictExpired();
        expect(observer.peek(pendingKey)).toBeUndefined();

        evictTerminalVolatileInboundMessages(observer, namespace);

        expect(observer.peek(messageKey)).toBeDefined();
        releaseHeld();
        await Promise.all([active, queued]);
        expect(first.peek(messageKey)).toBeDefined();
        expect(await first.readWork(work.entry.key)).toMatchObject({ status: EntityStatus.NEW });
    });

    it('counts a queued write before its first await when an idle wrapper sweeps the shared state', async () => {
        const namespace = 'reclaim-entry-gate';
        const state = createInMemoryALAdmissionState();
        const writer = new InMemoryAdmissionBackend(state, Date.now);
        const observer = new InMemoryAdmissionBackend(state, Date.now);
        const message = createInboundTestMessage({ msgId: 'entry-gate' });
        const reference = toALInboundMessageReference(message);
        const messageKey = toALInboundMessageKey(namespace, reference);
        const retainUntilMs = Date.now() + 60_000;
        await writer.write(async (tx) => {
            await tx.set(messageKey, { ...reference, msg: message, retainUntilMs }, retainUntilMs);
        });

        const queued = writer.write(async (tx) => {
            await tx.set(`${namespace}:dedup:queued`, retainUntilMs, retainUntilMs);
        });
        observer.evictExpired();
        evictTerminalVolatileInboundMessages(observer, namespace);
        expect(observer.peek(messageKey)).toBeDefined();

        await queued;
        observer.evictExpired();
        evictTerminalVolatileInboundMessages(observer, namespace);
        expect(observer.peek(messageKey)).toBeUndefined();
    });

    it('reclaims an incomplete pending row with no owed child but leaves its receipt fact intact', async () => {
        const namespace = 'reclaim-no-owed-child';
        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
        const message = createInboundTestMessage({ msgId: 'no-owed-child' });
        const reference = toALInboundMessageReference(message);
        const messageKey = toALInboundMessageKey(namespace, reference);
        const pendingKey = toALInboundControlPendingKey(namespace, reference.msgId, reference.senderId);
        const retainUntilMs = Date.now() + 60_000;
        await backend.write(async (tx) => {
            await tx.set(messageKey, { ...reference, msg: message, retainUntilMs }, retainUntilMs);
            await tx.set(pendingKey, {
                kind: 'pending',
                value: {
                    toPeerId: reference.senderId,
                    status: 'subtree-complete',
                    localReady: false,
                    expectedFromPeerIds: [],
                    ackedFromPeerIds: [],
                    carrier: 'ws'
                }
            }, retainUntilMs);
        });

        evictTerminalVolatileInboundMessages(backend, namespace);

        expect(backend.peek(messageKey)).toBeUndefined();
        expect(backend.peek(pendingKey)).toBeDefined();
    });

    it('fails closed before any removal on an invalid held pending fact', async () => {
        const namespace = 'reclaim-malformed';
        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
        const message = createInboundTestMessage({ msgId: 'malformed-pending' });
        const reference = toALInboundMessageReference(message);
        const messageKey = toALInboundMessageKey(namespace, reference);
        const pendingKey = toALInboundControlPendingKey(namespace, reference.msgId, reference.senderId);
        const retainUntilMs = Date.now() + 60_000;
        await backend.write(async (tx) => {
            await tx.set(messageKey, { ...reference, msg: message, retainUntilMs }, retainUntilMs);
            await tx.set(pendingKey, { kind: 'pending', value: { expectedFromPeerIds: 'not-an-array' } }, retainUntilMs);
        });

        expect(() => evictTerminalVolatileInboundMessages(backend, namespace))
            .toThrow(ALAdmissionCorruptionError);
        expect(backend.peek(messageKey)).toBeDefined();
        expect(backend.peek(pendingKey)).toBeDefined();
    });

    it('keeps all envelopes when a direct work reference has no canonical owner', async () => {
        const namespace = 'reclaim-missing-owner';
        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
        const message = createInboundTestMessage({ msgId: 'otherwise-terminal' });
        const reference = toALInboundMessageReference(message);
        const messageKey = toALInboundMessageKey(namespace, reference);
        const retainUntilMs = Date.now() + 60_000;
        const orphan = computeALInboundWorkEntry({
            namespace,
            effectId: 'missing-canonical-owner',
            payload: {
                kind: 'dispatch-local',
                message: { senderId: reference.senderId, msgId: 'absent' }
            },
            observedAtMs: Date.now(),
            expireAtTimestamp: retainUntilMs,
            carrier: 'ws'
        });
        await backend.write(async (tx) => {
            await tx.set(messageKey, { ...reference, msg: message, retainUntilMs }, retainUntilMs);
            expect(await tx.readWork(orphan.entry.key)).toBeUndefined();
            tx.writeWork(orphan.entry);
        });

        expect(() => evictTerminalVolatileInboundMessages(backend, namespace))
            .toThrow(ALAdmissionCorruptionError);
        expect(backend.peek(messageKey)).toBeDefined();
    });

    it.each([EntityStatus.RETRY, EntityStatus.FAILED, EntityStatus.NON_RETRYABLE])(
        'keeps the envelope for a %s direct delivery row',
        async (status) => {
            const stores = createVolatileALInboundRuntimeStores({ namespace: `reclaim-${status}` }, undefined);
            const admission = createInboundTestAdmission(stores);
            const message = createInboundTestMessage({ msgId: `held-${status}` });
            const reference = toALInboundMessageReference(message);
            expect((await admission.attempt(message, INBOUND_TEST_SOURCE, planInboundTestMessage)).right)
                .toMatchObject({ kind: 'completed', acceptance: { kind: 'admitted' } });
            const [key] = await stores.workQueue.getAllKeys();
            const entry = await stores.workQueue.getItem(key);
            const reserved = await stores.workQueue.reserveEntries({
                typeIds: new Set([entry!.typeId]),
                statusIds: new Set([EntityStatus.NEW]),
                reservationInput: 1
            });
            const [claim] = [...reserved.values()];
            await stores.workQueue.releaseEntries([{
                entry: claim,
                disposition: status === EntityStatus.RETRY
                    ? { status, delayMs: 1_000 }
                    : { status, delayMs: null }
            }]);

            stores.evictExpired();

            expect((await stores.admissionStore.readDeliverySurface(reference, Date.now()))?.msg)
                .toEqual(message);
        }
    );

    it('reclaims terminal WS work while the shared RTC carrier still holds its own canonical reference', async () => {
        const stores = createVolatileALInboundRuntimeStores({ namespace: 'reclaim-carriers' }, undefined);
        const admission = createInboundTestAdmission(stores);
        const ws = createInboundTestMessage({ msgId: 'ws-envelope' });
        const rtc = createInboundTestMessage({ msgId: 'rtc-envelope' });
        expect((await admission.attempt(ws, INBOUND_TEST_SOURCE, planInboundTestMessage)).right)
            .toMatchObject({ kind: 'completed', acceptance: { kind: 'admitted' } });
        expect((await admission.attempt(rtc, { kind: 'rtc-peer', peerId: 'sender' }, planInboundTestMessage)).right)
            .toMatchObject({ kind: 'completed', acceptance: { kind: 'admitted' } });
        const reserved = await stores.workQueue.reserveEntries({
            typeIds: new Set([toALInboundWorkType(stores.admissionStore.namespace, 'ws')]),
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: 1
        });
        const [claim] = [...reserved.values()];
        await stores.workQueue.releaseEntries([{
            entry: claim,
            disposition: { status: EntityStatus.COMPLETED, delayMs: null }
        }]);

        stores.evictExpired();

        expect(await stores.admissionStore.readDeliverySurface(toALInboundMessageReference(ws), Date.now()))
            .toBeUndefined();
        expect((await stores.admissionStore.readDeliverySurface(toALInboundMessageReference(rtc), Date.now()))?.msg)
            .toEqual(rtc);
    });

    it('keeps an owed child’s original envelope after its first forward completes', async () => {
        const volatileStores = createVolatileALInboundRuntimeStores({ namespace: 'reclaim-owed-child' }, undefined);
        const durableStores = createDefaultInMemoryALInboundRuntimeStores({ namespace: 'reclaim-owed-durable' });
        const forwarded: ALMessage[] = [];
        const planner: ALInboundMessageRuntime.Dependencies['planIncomingMessage'] = (msg, source, observations) =>
            planALMessageHandling(msg, {
                ...observations,
                selfPeerId: 'receiver',
                fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId,
                connectedPeerIds: ['sender', 'relay'],
                groupMemberPeerIds: ['sender', 'receiver', 'relay'],
                overlayNeighborPeerIds: ['relay']
            });
        const runtime = new ALInboundMessageRuntime({
            ...createDefaultALInboundRuntimeResources({
                selfPeerId: 'receiver',
                stores: durableStores,
                volatileStores,
                toInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox')
            }),
            carrier: 'ws',
            planIncomingMessage: planner,
            dispatchInboxEntry: async () => {},
            forwardMessage: async ({ msg }) => {
                forwarded.push(msg);
            },
            forwardRetriedCopy: async ({ msg }) => {
                forwarded.push(msg);
            },
            sendControlMessages: async () => {},
            diagnostics: undefined
        });
        onTestFinished(() => runtime.dispose());
        await runtime.ready();
        const relayed = newALMulticastMessage(
            'sender',
            { topicId: 'chat', resourceId: 'owed-original', contextId: 'room' },
            { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room' },
            'chat.message.v1',
            { text: 'owed-original' },
            { reliability: 'at-least-once', ack: 'all-logical-recipients', ttlMs: 60_000 }
        );
        const original = toALFrozenMulticastMessage(relayed, {
            recipientPeerIds: ['sender', 'receiver', 'relay'],
            snapshotVersion: 1
        });
        expect((await runtime.admitIncomingMessage(original, INBOUND_TEST_SOURCE)).right)
            .toEqual({ kind: 'admitted' });
        await expect.poll(() => forwarded.length).toBe(1);
        expect(
            (await volatileStores.admissionStore.readDeliverySurface(
                toALInboundMessageReference(original),
                Date.now()
            ))?.msg.payload.resource
        ).toBe(original.payload.resource);
        const nowMs = Date.now();
        const read = await volatileStores.admissionStore.readIncomingMessage({
            msg: original,
            source: INBOUND_TEST_SOURCE,
            nowMs,
            prePlan: planner(original, INBOUND_TEST_SOURCE, { nowMs })
        });
        expect(read.pendingAck).toMatchObject({ expectedFromPeerIds: ['relay'], ackedFromPeerIds: [] });

        volatileStores.evictExpired();
        expect(
            (await volatileStores.admissionStore.readDeliverySurface(
                toALInboundMessageReference(original),
                Date.now()
            ))?.msg.payload.resource
        ).toBe(original.payload.resource);

        const altered = {
            ...original,
            forwarding: { ...original.forwarding, nextHopPeerIds: ['receiver'] },
            payload: { ...original.payload, resource: JSON.stringify({ text: 'altered-on-retry' }) }
        };
        expect((await runtime.admitIncomingMessage(altered, INBOUND_TEST_SOURCE)).right)
            .toEqual({ kind: 'duplicate' });
        await expect.poll(() => forwarded.length).toBe(2);
        expect(forwarded[1]?.payload.resource).toBe(original.payload.resource);
        expect(forwarded[1]?.payload.resource).not.toBe(altered.payload.resource);
    });
});
