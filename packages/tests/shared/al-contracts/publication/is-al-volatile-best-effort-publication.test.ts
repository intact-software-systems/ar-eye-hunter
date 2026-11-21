import { describe, expect, it } from 'vitest';

import { newALBroadcastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { isALVolatileBestEffortPublication } from '@shared/al-contracts/publication/is-al-volatile-best-effort-publication.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

/** The wire signature a live publication carries: best-effort, no receipt, volatile, latest-wins. */
function livePublication(): ALMessage {
    const base = newALBroadcastMessage(
        {
            createdAtEpochMs: Date.now(),
            senderId: 'sender',
            route: { topicId: 'room.pose', resourceId: 'entity-1', contextId: ROOM.groupId },
            scope: 'room',
            typeId: 'pose.v1',
            resource: { x: 1 },
            options: { groupRef: ROOM }
        }
    );
    return {
        ...base,
        delivery: { reliability: 'best-effort', ack: 'none' },
        qos: { durability: { algo: 'volatile' }, supersedence: { algo: 'latest-wins' } }
    };
}

describe('isALVolatileBestEffortPublication (D482)', () => {
    it('reads a best-effort, volatile, latest-wins message as a live publication', () => {
        expect(isALVolatileBestEffortPublication(livePublication())).toBe(true);
    });

    it.each([
        {
            name: 'an at-least-once delivery',
            change: (msg: ALMessage): ALMessage => ({ ...msg, delivery: { reliability: 'at-least-once', ack: 'none' } })
        },
        {
            name: 'no delivery section',
            change: ({ delivery: _delivery, ...msg }: ALMessage): ALMessage => msg
        },
        {
            name: 'a local-outbox durability',
            change: (msg: ALMessage): ALMessage => ({ ...msg, qos: { ...msg.qos, durability: { algo: 'local-outbox' } } })
        },
        {
            name: 'no durability request',
            change: (msg: ALMessage): ALMessage => ({ ...msg, qos: { supersedence: { algo: 'latest-wins' } } })
        },
        {
            name: 'no supersedence',
            change: (msg: ALMessage): ALMessage => ({ ...msg, qos: { ...msg.qos, supersedence: { algo: 'none' } } })
        },
        {
            name: 'no qos section',
            change: ({ qos: _qos, ...msg }: ALMessage): ALMessage => msg
        }
    ])('does not read a message with $name as one', ({ change }) => {
        expect(isALVolatileBestEffortPublication(change(livePublication()))).toBe(false);
    });
});
