import { describe, expect, it } from 'vitest';

import type { ALMessage, ALTargets } from '@shared/al-contracts/al-contract.ts';
import type { ALOrderingObserverRole } from '@shared/al-contracts/al-runtime.ts';
import { resolveALOrderingObserverRole } from '@shared/alm/inbound/admission/resolve-al-ordering-observer-role.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const FROZEN_TO_SELF: ALTargets = { mode: 'multicast', groupRef: ROOM, recipientPeerIds: ['self', 'other'], snapshotVersion: 3 };
const FROZEN_TO_OTHERS: ALTargets = { mode: 'multicast', groupRef: ROOM, recipientPeerIds: ['other'], snapshotVersion: 3 };
const UNFROZEN: ALTargets = { mode: 'multicast', groupRef: ROOM };
const UNICAST_TO_OTHER: ALTargets = { mode: 'unicast', toPeerId: 'other' };

describe('resolveALOrderingObserverRole', () => {
    it.each<[string, ALTargets, boolean, 'addressed' | 'every-track', ALOrderingObserverRole]>([
        ['the server, its clients\' ordering hop, for a copy it delivers nowhere', FROZEN_TO_OTHERS, false, 'every-track', 'recipient'],
        ['the server for a copy frozen to it that it does not deliver', FROZEN_TO_SELF, false, 'every-track', 'recipient'],
        ['a peer that delivers the copy now or on its release', FROZEN_TO_SELF, true, 'addressed', 'recipient'],
        ['a peer that delivers an unfrozen copy', UNFROZEN, true, 'addressed', 'recipient'],
        ['a frozen recipient that delivers nothing', FROZEN_TO_SELF, false, 'addressed', 'witness'],
        ['a peer outside the frozen audience', FROZEN_TO_OTHERS, false, 'addressed', 'none'],
        ['a pure relay of an unfrozen copy', UNFROZEN, false, 'addressed', 'none'],
        ['a relay of a unicast to another peer', UNICAST_TO_OTHER, false, 'addressed', 'none']
    ])('resolves %s', (_name, targets, delivering, observer, role) => {
        expect(resolveALOrderingObserverRole({ msg: toMessage(targets, 'receiver'), selfPeerId: 'self', delivering, observer }))
            .toBe(role);
    });

    it('witnesses an unreceipted frozen copy too: the role never reads the receipt mode', () => {
        expect(resolveALOrderingObserverRole({
            msg: toMessage(FROZEN_TO_SELF, 'none'),
            selfPeerId: 'self',
            delivering: false,
            observer: 'addressed'
        })).toBe('witness');
    });
});

function toMessage(targets: ALTargets, ack: 'none' | 'receiver'): ALMessage {
    return {
        id: { v: 4, msgId: 'message-1', senderId: 'origin', ts: 1_000, traceId: 'trace-observer-role' },
        route: { topicId: 'room.feed', resourceId: 'feed', contextId: 'room' },
        targets,
        delivery: { ack, reliability: 'at-least-once' },
        ordering: { orderingKey: 'feed-track', seq: 4, priorSeqByRecipient: {} },
        payload: { typeId: 'room.feed.v1', resource: '{}' }
    };
}
