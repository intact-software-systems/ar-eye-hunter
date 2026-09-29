import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALRoute,
    newALUnicastMessage
} from '@shared/al-contracts/al-contract.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const ROUTE = newALRoute('app.command', 'room-1', 'resource-1');
const TTL_MS = 30_000;

function tickClockOnEveryRead(): void {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
}

describe('a message deadline is measured from the message id timestamp', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('for a unicast', () => {
        tickClockOnEveryRead();

        const message = newALUnicastMessage('a', ROUTE, 'b', 'app.command.v1', {}, { ttlMs: TTL_MS });

        expect(message.constraints?.expiresAtMs).toBe(message.id.ts + TTL_MS);
    });

    it('for a multicast', () => {
        tickClockOnEveryRead();

        const message = newALMulticastMessage('a', ROUTE, ROOM, 'app.command.v1', {}, { ttlMs: TTL_MS });

        expect(message.constraints?.expiresAtMs).toBe(message.id.ts + TTL_MS);
    });

    it('for a broadcast', () => {
        tickClockOnEveryRead();

        const message = newALBroadcastMessage('a', ROUTE, 'room', 'app.command.v1', {}, {
            groupRef: ROOM,
            ttlMs: TTL_MS
        });

        expect(message.constraints?.expiresAtMs).toBe(message.id.ts + TTL_MS);
    });
});
