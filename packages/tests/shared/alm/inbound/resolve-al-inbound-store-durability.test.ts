import { describe, expect, it } from 'vitest';

import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDurabilityAlgo } from '@shared/al-contracts/al-policy.ts';
import { resolveALInboundStoreDurability } from '@shared/alm/inbound/lane/resolve-al-inbound-store-durability.ts';

function toMessage(durability: ALDurabilityAlgo | undefined) {
    return newALUnicastMessage(
        {
            createdAtEpochMs: Date.now(),
            senderId: 'sender',
            route: { topicId: 'chat', resourceId: `durability-${durability ?? 'none'}`, contextId: 'room' },
            toPeerId: 'receiver',
            typeId: 'chat.message.v1',
            resource: {},
            options: {
                ttlMs: 30_000,
                qos: durability === undefined ? undefined : { durability: { algo: durability } }
            }
        }
    );
}

describe('resolveALInboundStoreDurability', () => {
    it.each([
        { durability: undefined, expected: 'volatile' },
        { durability: 'volatile' as const, expected: 'volatile' },
        { durability: 'local-outbox' as const, expected: 'volatile' },
        { durability: 'local-inbox' as const, expected: 'durable' }
    ])(
        'stores a message that carries $durability in the $expected inbound pair',
        ({ durability, expected }) => {
            expect(resolveALInboundStoreDurability(toMessage(durability))).toBe(expected);
        }
    );
});
