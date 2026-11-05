import { describe, expect, it } from 'vitest';

import type { ALMessage, ALTargets } from '@shared/al-contracts/al-contract.ts';
import { validateALOutboundPlannedMessage } from '@shared/alm/outbound/validate-al-outbound-dispatch.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const UNFROZEN: ALTargets = { mode: 'multicast', groupRef: ROOM };
const FROZEN: ALTargets = { mode: 'multicast', groupRef: ROOM, recipientPeerIds: ['b', 'c'], snapshotVersion: 4 };
const PROOF = { alg: 'ES256', keyId: 'k'.repeat(43), signature: 'Q'.repeat(86) } as const;

describe('planned outbound message authority', () => {
    it('accepts the origin freezing an unfrozen multicast audience', () => {
        expect(validateALOutboundPlannedMessage(withTargets(UNFROZEN), withTargets(FROZEN))).toEqual([]);
        expect(validateALOutboundPlannedMessage(withTargets(FROZEN), withTargets(FROZEN))).toEqual([]);
    });

    it.each(
        [
            { label: 'drops a frozen audience', original: FROZEN, planned: UNFROZEN },
            {
                label: 're-freezes a different audience',
                original: FROZEN,
                planned: { ...FROZEN, recipientPeerIds: ['b', 'd'], snapshotVersion: 6 }
            },
            {
                label: 'freezes while changing the room',
                original: UNFROZEN,
                planned: { ...FROZEN, groupRef: { ...ROOM, groupId: 'other' } }
            }
        ] satisfies ReadonlyArray<{ label: string; original: ALTargets; planned: ALTargets; }>
    )(
        'refuses a plan that $label',
        ({ original, planned }) => {
            expect(validateALOutboundPlannedMessage(withTargets(original), withTargets(planned))).toEqual([
                { code: 'malformed', message: 'Outbound planned message changes original authority or deadline' }
            ]);
        }
    );

    it('accepts the record and the proof a first admission adds to a request that carried neither', () => {
        const request = withOrdering(withTargets(FROZEN), { orderingKey: 'feed', epoch: 1, seq: 2 });
        const admitted = { ...withOrdering(request, { ...request.ordering, priorSeqByRecipient: { c: 0 } }), proof: PROOF };

        expect(validateALOutboundPlannedMessage(request, admitted)).toEqual([]);
    });

    it.each([
        {
            label: 'rewrites the record its request stated',
            change: (message: ALMessage) => withOrdering(message, { ...message.ordering, priorSeqByRecipient: { c: 1 } })
        },
        { label: 'replaces the proof its request carried', change: (message: ALMessage) => ({ ...message, proof: { ...PROOF, signature: 'g'.repeat(86) } }) }
    ])('refuses a plan that $label', ({ change }) => {
        const request = withOrdering(withTargets(FROZEN), { orderingKey: 'feed', epoch: 1, seq: 2, priorSeqByRecipient: { c: 0 } });
        const signed = { ...request, proof: PROOF };

        expect(validateALOutboundPlannedMessage(signed, change(signed))).toHaveLength(1);
    });

    it('refuses any other change beside a freeze', () => {
        const planned = { ...withTargets(FROZEN), payload: { typeId: 'chat', resource: '{"changed":true}' } };

        expect(validateALOutboundPlannedMessage(withTargets(UNFROZEN), planned)).toHaveLength(1);
    });
});

function withOrdering(message: ALMessage, ordering: NonNullable<ALMessage['ordering']>): ALMessage {
    return { ...message, ordering };
}

function withTargets(targets: ALTargets): ALMessage {
    return {
        id: { v: 4, msgId: 'message', senderId: 'a', ts: 1, traceId: 'trace-validate-al-outbound-dispatch' },
        route: { topicId: 'chat', resourceId: 'resource', contextId: 'room' },
        targets,
        constraints: { expiresAtMs: 10_000 },
        payload: { typeId: 'chat', resource: '{}' }
    };
}
