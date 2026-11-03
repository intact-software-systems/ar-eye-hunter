import { describe, expect, it } from 'vitest';

import { isClientSnapshotSessionLive } from '@shared-server/rallar-system/presence/snapshot-presence.ts';
import type { ClientSession } from '@shared/api/client-types.ts';

const NOW_EPOCH_MS = 10_000;

const ACTIVE_SESSION: ClientSession = {
    applicationId: 'app',
    workspaceId: 'workspace',
    principalId: 'alice',
    clientInstanceId: 'alice-instance',
    sessionId: 'alice-session',
    generationId: 'alice-generation',
    generationVersion: 1,
    status: 'active',
    presenceState: 'online',
    transport: 'ws',
    connectionId: null,
    authenticatedAtEpochMs: 1,
    connectedAtEpochMs: 1,
    lastHeartbeatAtEpochMs: 1,
    expiresAtEpochMs: NOW_EPOCH_MS + 1,
    disconnectedAtEpochMs: null,
    disconnectReason: null
};

describe('client session liveness', () => {
    it('holds an active session live until the instant it expires, and not at that instant', () => {
        expect(isClientSnapshotSessionLive(ACTIVE_SESSION, NOW_EPOCH_MS)).toBe(true);
        expect(isClientSnapshotSessionLive(ACTIVE_SESSION, NOW_EPOCH_MS + 1)).toBe(false);
    });

    it.each(['disconnected', 'expired'] as const)('holds a %s session not live before its expiry', (status) => {
        const ended: ClientSession = {
            ...ACTIVE_SESSION,
            status,
            disconnectedAtEpochMs: NOW_EPOCH_MS - 1,
            disconnectReason: 'closed'
        };

        expect(isClientSnapshotSessionLive(ended, NOW_EPOCH_MS)).toBe(false);
    });
});
