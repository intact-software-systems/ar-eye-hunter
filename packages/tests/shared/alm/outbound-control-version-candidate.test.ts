import { createTestALOutboundControlAdmission } from '@shared-test/shared/create-test-al-outbound-work-port.ts';
import { newALAckControlMessage, newALNackControlMessage, parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { decodeALOutboundSentMessage } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import { computeALOutboundControlAdmission, type ALControlAdmissionRead } from '@shared/alm/outbound/compute-al-outbound-control-admission.ts';
import { validateALOutboundControlAdmission } from '@shared/alm/outbound/validate-al-outbound-control-admission.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { computeOutboundTestAdmission, createOutboundMessage } from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload } from './outbound-test-payload.ts';

describe('outbound control version candidate', () => {
    afterEach(() => vi.restoreAllMocks());

    it('computes and validates the ready version from frozen observations', async () => {
        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
        const store = createALOutboundAdmissionStore({
            nowMs: Date.now,
            canonicalScope: 'control-values',
            decodePrepared: decodeOutboundTestPayload,
            backend,
            namespace: 'control-values',
            retention: normalizeALRuntimeStoreRetention(),
            supersedenceTrackTtlMs: 60_000
        });
        const message = createOutboundMessage('control-version');
        await store.commitBundle(await computeOutboundTestAdmission(store, message));
        const sent = await backend.read(`control-values:sent:${message.id.msgId}`, (value) => decodeALOutboundSentMessage(value, message.id.msgId));
        if (!sent) {
            throw new Error('Expected admitted compact sent fact');
        }
        const control = newALNackControlMessage({ v: 2, msgId: 'nack', senderId: 'peer-1', ts: 1_000 }, {
            msgId: message.id.msgId,
            fromPeerId: 'peer-1',
            toPeerId: 'self',
            reason: 'not-yet-in-sync',
            observedAtEpochMs: 1_000
        });
        const read = freezeValues<ALControlAdmissionRead>({
            parsed: parseALControlMessage(control)!,
            carrier: 'ws',
            targetMsgId: message.id.msgId,
            nowMs: 1_000,
            owner: 'self',
            ownerVersion: Object.freeze({ senderId: 'self', version: 7 }),
            sent: Object.freeze(sent),
            history: { kind: 'nacks', values: [] }
        });
        const retention = normalizeALRuntimeStoreRetention();
        const candidate = computeALOutboundControlAdmission(read, retention);
        expect(candidate).toEqual(computeALOutboundControlAdmission(read, retention));
        expect(candidate).toMatchObject({ nextVersion: { senderId: 'self', version: 8 } });
        expect(validateALOutboundControlAdmission(candidate)).toEqual([]);
        expect(validateALOutboundControlAdmission({ ...candidate, nextVersion: { senderId: 'self', version: 9 } })).toContainEqual(
            expect.objectContaining({ code: 'malformed' })
        );
    });

    it('refuses an acknowledgement past its message deadline even while its receipt is still retained', async () => {
        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
        const store = createALOutboundAdmissionStore({
            nowMs: Date.now,
            canonicalScope: 'control-deadline',
            decodePrepared: decodeOutboundTestPayload,
            backend,
            namespace: 'control-deadline',
            retention: normalizeALRuntimeStoreRetention(),
            supersedenceTrackTtlMs: 60_000
        });
        const message = createOutboundMessage('control-deadline');
        await store.commitBundle(await computeOutboundTestAdmission(store, message));
        const sent = await backend.read(`control-deadline:sent:${message.id.msgId}`, (value) => decodeALOutboundSentMessage(value, message.id.msgId));
        if (!sent) {
            throw new Error('Expected admitted compact sent fact');
        }
        const ack = newALAckControlMessage({ v: 2, msgId: 'ack', senderId: 'peer-1', ts: 1_000 }, {
            ackedMsgId: message.id.msgId,
            fromPeerId: 'peer-1',
            toPeerId: 'self',
            status: 'accepted',
            observedAtEpochMs: 1_000,
            carrier: 'ws'
        });
        const readAt = (nowMs: number): ALControlAdmissionRead => ({
            parsed: parseALControlMessage(ack)!,
            carrier: 'ws',
            targetMsgId: message.id.msgId,
            nowMs,
            owner: 'self',
            ownerVersion: { senderId: 'self', version: 1 },
            sent,
            pending: {
                msgId: message.id.msgId,
                expectedPeerIds: ['peer-1'],
                ackedPeerIds: [],
                timeoutMs: 2_000,
                maxAttempts: 3,
                attempts: 3,
                deadlineAtMs: nowMs - 1
            },
            history: { kind: 'acks', values: [] }
        });
        const retention = normalizeALRuntimeStoreRetention();
        const deadlineMs = sent.reference.expiresAtMs;

        expect(validateALOutboundControlAdmission(computeALOutboundControlAdmission(readAt(deadlineMs - 1), retention))).toEqual([]);
        expect(validateALOutboundControlAdmission(computeALOutboundControlAdmission(readAt(deadlineMs), retention))).toEqual([
            { code: 'unauthorized', message: 'AL acknowledgement arrived after its message deadline' }
        ]);
    });

    it('rejects a changed owner version before installing control history and accepts a fresh observation', async () => {
        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
        const namespace = 'control-version-test';
        const store = createALOutboundAdmissionStore({
            nowMs: Date.now,
            decodePrepared: decodeOutboundTestPayload,
            backend,
            namespace,
            canonicalScope: namespace,
            retention: normalizeALRuntimeStoreRetention(),
            supersedenceTrackTtlMs: 60_000
        });
        const controlAdmission = createTestALOutboundControlAdmission({
            admissionStore: store,
            workQueue: backend.workQueue,
            nowMs: Date.now,
            carrier: 'ws'
        });
        const message = createOutboundMessage('control-version-race');
        await store.commitBundle(await computeOutboundTestAdmission(store, message));
        const control = newALNackControlMessage({ v: 2, msgId: 'nack-race', senderId: 'peer-1', ts: Date.now() }, {
            msgId: message.id.msgId,
            fromPeerId: 'peer-1',
            toPeerId: 'self',
            reason: 'not-yet-in-sync',
            observedAtEpochMs: Date.now()
        });
        const write = backend.write.bind(backend);
        let injected = false;
        vi.spyOn(backend, 'write').mockImplementationOnce(async (apply) => {
            await write(async (tx) => {
                await tx.set(`${namespace}:version:self`, { senderId: 'self', version: 2 }, Date.now() + 60_000);
            });
            injected = true;
            return await write(apply);
        });
        // The changed version is a conflict, so the admission retains replayable work instead of committing.
        expect(await controlAdmission.admit(control)).toEqual({ kind: 'pending-control' });
        expect(injected).toBe(true);
        expect(await backend.read(`${namespace}:control:nacks:${message.id.msgId}`, (value) => value)).toBeUndefined();
        expect(await controlAdmission.admit(control)).toEqual({ kind: 'committed' });
        expect(await backend.read(`${namespace}:version:self`, (value) => value)).toEqual({ senderId: 'self', version: 3 });
    });
});

function freezeValues<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) {
            freezeValues(child);
        }
        Object.freeze(value);
    }
    return value;
}
