import {
    describe,
    expect,
    it
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALOutboundEffectPayload } from '@shared/alm/outbound/al-outbound-effect-validation.ts';
import { toALOutboundPreparedFingerprint } from '@shared/alm/outbound/to-al-outbound-prepared-fingerprint.ts';

const MESSAGE: ALMessage = {
    id: { v: 3, msgId: 'message', senderId: 'sender', ts: 0 },
    route: { topicId: 'chat', resourceId: 'resource', contextId: 'room' },
    payload: { typeId: 'chat.text.v1', resource: '"hello"' },
    constraints: { expiresAtMs: 60_000 }
};
const REFERENCE = {
    key: { topicId: 'AL_OUTBOUND_MESSAGE', resourceId: 'canonical', contextId: 'server' },
    typeId: 'chat.text.v1',
    scope: 'outbound',
    msgId: 'message',
    senderId: 'sender',
    identity: '[3,"sender","message",0,null,null]',
    expiresAtMs: 60_000
};

describe('persisted ALM prepared fingerprints', () => {
    // Literal historical FNV-1a hashes of the two serialized payloads; opposite insertion orders
    // have distinct durable identities even though their JSON content is equivalent.
    it.each(
        [
            [{ payload: { ['\u00e9']: 'first', ['e\u0301']: 'second' } }, '3k4zo7mf2o5tu'],
            [{ payload: { ['e\u0301']: 'second', ['\u00e9']: 'first' } }, '2aewqa2qez7ja']
        ] as const
    )('decodes the historical send row without changing its fingerprint %#', (prepared, fingerprint) => {
        const stored = JSON.parse(JSON.stringify({
            kind: 'send-prepared',
            message: REFERENCE,
            prepared,
            preparedFingerprint: fingerprint,
            attemptIdentity: 'initial',
            phase: 'immediate'
        }));
        expect(toALOutboundPreparedFingerprint(prepared)).toBe(fingerprint);
        expect(decodeALOutboundEffectPayload(stored, `send:message:immediate:initial:0:${fingerprint}`, {
            message: MESSAGE,
            decodePrepared: (value) => value
        })).toEqual(stored);

        stored.prepared.payload['\u00e9'] = 'changed';
        expect(() =>
            decodeALOutboundEffectPayload(stored, `send:message:immediate:initial:0:${fingerprint}`, {
                message: MESSAGE,
                decodePrepared: (value) => value
            })
        ).toThrow('Persisted AL prepared message fingerprint does not match its payload');
    });
});
