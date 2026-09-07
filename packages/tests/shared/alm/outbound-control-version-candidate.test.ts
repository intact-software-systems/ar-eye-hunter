import { newALNackControlMessage, parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/al-outbound-admission-store.ts';
import { computeALOutboundControlAdmission, type ALControlAdmissionRead } from '@shared/alm/outbound/compute-al-outbound-control-admission.ts';
import { validateALOutboundControlAdmission } from '@shared/alm/outbound/validate-al-outbound-control-admission.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOutboundMessage } from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload } from './outbound-test-payload.ts';

describe('outbound control version candidate', () => {
    afterEach(() => vi.restoreAllMocks());

    it('computes and validates the ready version from frozen observations', () => {
        const message = createOutboundMessage('control-version');
        const control = newALNackControlMessage({ v: 2, msgId: 'nack', senderId: 'peer-1', ts: 1_000 }, {
            msgId: message.id.msgId,
            fromPeerId: 'peer-1',
            toPeerId: 'self',
            reason: 'not-yet-in-sync',
            observedAtEpochMs: 1_000
        });
        const read = freezeValues<ALControlAdmissionRead>({
            parsed: parseALControlMessage(control)!,
            targetMsgId: message.id.msgId,
            nowMs: 1_000,
            owner: 'self',
            ownerVersion: Object.freeze({ senderId: 'self', version: 7 }),
            sent: Object.freeze({ msgId: message.id.msgId, msg: message }),
            history: { kind: 'nacks', values: [] }
        });
        const retention = normalizeALRuntimeStoreRetention();
        const candidate = computeALOutboundControlAdmission(read, retention);
        expect(candidate).toEqual(computeALOutboundControlAdmission(read, retention));
        expect(candidate).toMatchObject({ nextVersion: { senderId: 'self', version: 8 } });
        expect(validateALOutboundControlAdmission(candidate).right).toBe(candidate);
        expect(validateALOutboundControlAdmission({ ...candidate, nextVersion: { senderId: 'self', version: 9 } }).left?.code).toBe('malformed');
    });

    it('rejects a changed owner version before installing control history and accepts a fresh observation', async () => {
        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
        const namespace = 'control-version-test';
        const store = createALOutboundAdmissionStore({ backend, namespace, retention: normalizeALRuntimeStoreRetention(), supersedenceTrackTtlMs: 60_000 });
        const message = createOutboundMessage('control-version-race');
        await store.commitBundle({
            senderId: 'self',
            mutations: [
                { kind: 'set-msg-owner', msgId: message.id.msgId, senderId: 'self' },
                { kind: 'set-sent-message', snapshot: { msgId: message.id.msgId, msg: message } }
            ],
            durableEffects: []
        }, decodeOutboundTestPayload);
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
        await expect(store.acceptControlMessage(control, decodeOutboundTestPayload)).rejects.toThrow('version changed');
        expect(injected).toBe(true);
        expect(await backend.read(`${namespace}:control:nacks:${message.id.msgId}`, (value) => value)).toBeUndefined();
        await expect(store.acceptControlMessage(control, decodeOutboundTestPayload)).resolves.toEqual({ handled: true });
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
