import { describe, expect, it } from 'vitest';

import type { ALMessage, ALTargets } from '@shared/al-contracts/al-contract.ts';
import { validateALOutboundPlannedMessage } from '@shared/alm/outbound/validate-al-outbound-dispatch.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const UNFROZEN: ALTargets = { mode: 'multicast', groupRef: ROOM };
const FROZEN: ALTargets = { mode: 'multicast', groupRef: ROOM, recipientPeerIds: ['b', 'c'], snapshotVersion: 4 };

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

    it('refuses any other change beside a freeze', () => {
        const planned = { ...withTargets(FROZEN), payload: { typeId: 'chat', resource: '{"changed":true}' } };

        expect(validateALOutboundPlannedMessage(withTargets(UNFROZEN), planned)).toHaveLength(1);
    });
});

function withTargets(targets: ALTargets): ALMessage {
    return {
        id: { v: 2, msgId: 'message', senderId: 'a', ts: 1 },
        route: { topicId: 'chat', resourceId: 'resource', contextId: 'room' },
        targets,
        constraints: { expiresAtMs: 10_000 },
        payload: { typeId: 'chat', resource: '{}' }
    };
}
