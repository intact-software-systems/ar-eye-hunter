import { describe, expect, it } from 'vitest';

import type { ClientMutationRead } from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { CLIENT_STATE_SESSIONS_NAMESPACE } from '@shared-server/rallar-system/client-state/persistence/client-state-runtime-namespaces.ts';
import { toClientSessionPurgeAfterEpochMs, toSessionPurgeAfterEpochMs } from '@shared-server/rallar-system/presence/session-expiry.ts';

import {
    connectCommand,
    disconnectCommand,
    emptyRead,
    readAfterWrite,
    requireWrite
} from './client-mutation-compute-test-fixtures.ts';
import { TEST_DISCONNECTED_SESSION_RETENTION_MS } from './test-disconnected-session-retention.ts';

const AUTH_SESSION_EXPIRES_AT_EPOCH_MS = 30 * 24 * 60 * 60 * 1_000;

describe('disconnected client session retention', () => {
    it('purges a disconnected session the retention after it disconnected instead of after its auth expiry', () => {
        const command = disconnectCommand();
        const read = readConnectedSession(command, AUTH_SESSION_EXPIRES_AT_EPOCH_MS);

        const disconnected = requireWrite(computeClientMutation({ command, read }));

        const sessionWrite = disconnected.persistence.runtimeWrites.find(({ namespace }) => namespace === CLIENT_STATE_SESSIONS_NAMESPACE);
        expect(sessionWrite?.expireAtIsoTimestamp).toBe(
            new Date(4_000 + TEST_DISCONNECTED_SESSION_RETENTION_MS).toISOString()
        );
    });

    it('never keeps an ended session longer than its own expiry and grace would', () => {
        const ended = { expiresAtEpochMs: 8_000, disconnectedAtEpochMs: 4_000 };

        expect(toClientSessionPurgeAfterEpochMs(ended, TEST_DISCONNECTED_SESSION_RETENTION_MS))
            .toBe(toSessionPurgeAfterEpochMs(8_000, 4_000));
        expect(toClientSessionPurgeAfterEpochMs(ended, 1_000)).toBe(5_000);
    });

    it('leaves an active session purged by its expiry', () => {
        const active = { expiresAtEpochMs: AUTH_SESSION_EXPIRES_AT_EPOCH_MS, disconnectedAtEpochMs: null };

        expect(toClientSessionPurgeAfterEpochMs(active, 1_000))
            .toBe(toSessionPurgeAfterEpochMs(AUTH_SESSION_EXPIRES_AT_EPOCH_MS, null));
    });
});

/** The fixture's connected session, expiring as an auth session issued for thirty days would. */
function readConnectedSession(
    command: ReturnType<typeof disconnectCommand>,
    expiresAtEpochMs: number
): ClientMutationRead {
    const connect = connectCommand();
    const connected = requireWrite(computeClientMutation({ command: connect, read: emptyRead(connect) }));
    const read = readAfterWrite(command, connected);
    if (!read.session) {
        throw new Error('Expected the connected session');
    }
    return { ...read, session: { ...read.session, value: { ...read.session.value, expiresAtEpochMs } } };
}
