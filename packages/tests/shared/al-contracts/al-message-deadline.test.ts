import { describe, expect, it } from 'vitest';

import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALPrincipalBroadcastMessage,
    newALRoute,
    newALUnicastMessage,
    newALUntargetedMessage
} from '@shared/al-contracts/al-contract.ts';

const groupRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const input = {
    createdAtEpochMs: 100_000,
    senderId: 'a',
    route: newALRoute('app.command', 'room-1', 'resource-1'),
    typeId: 'app.command.v1',
    resource: {}
};

describe('an AL envelope uses the creation epoch supplied by its owner', () => {
    it.each([undefined, 0, 1000])('preserves a TTL of %s across audiences', (ttlMs) => {
        const message = { ...input, options: { ttlMs } };
        const envelopes = [
            newALUntargetedMessage(message),
            newALUnicastMessage({ ...message, toPeerId: 'b' }),
            newALMulticastMessage({ ...message, groupRef }),
            newALBroadcastMessage({ ...message, scope: 'world' }),
            newALPrincipalBroadcastMessage({
                ...message,
                target: { groupRef, principalRef: { applicationId: 'app', workspaceId: 'workspace', principalId: 'b' } }
            })
        ];
        for (const envelope of envelopes) {
            expect(envelope.id.ts).toBe(100_000);
            expect(envelope.audit?.createdTs).toBe(100_000);
            expect(envelope.constraints?.expiresAtMs).toBe(ttlMs === undefined ? undefined : 100_000 + ttlMs);
        }
    });
});
