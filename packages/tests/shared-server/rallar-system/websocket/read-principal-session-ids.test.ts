import { describe, expect, it } from 'vitest';

import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import {
    readPrincipalSessions,
    type PrincipalSessionRowsReader
} from '@shared-server/rallar-system/websocket/read-principal-session-ids.ts';
import { createTestClientStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { AuditStamp, ClientInstance, ClientPrincipal, ClientPrincipalRef, ClientSession } from '@shared/api/client-types.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';

const ALICE: ClientPrincipalRef = { applicationId: 'app-1', workspaceId: 'workspace-1', principalId: 'alice' };
const NOW_EPOCH_MS = Date.now();

describe('readPrincipalSessions', () => {
    it('names every stored session row of an active principal and only the live ones as live', async () => {
        const clients = await seedAlice({ status: 'active', disabled: null, deleted: null });

        expect(await readPrincipalSessions(ALICE, toReader(clients))).toEqual({
            sessionIds: ['alice-closed', 'alice-live'],
            liveSessionIds: ['alice-live']
        });
    });

    it('names an inactive principal\'s rows with none of them live', async () => {
        const clients = await seedAlice({ status: 'disabled', disabled: audit(), deleted: null });

        expect(await readPrincipalSessions(ALICE, toReader(clients))).toEqual({
            sessionIds: ['alice-closed', 'alice-live'],
            liveSessionIds: []
        });
    });

    it('answers nothing when no principal row exists', async () => {
        const clients = createTestClientStateRepository(new FakeRuntimeStateRepository());

        expect(await readPrincipalSessions(ALICE, toReader(clients))).toBeUndefined();
    });
});

function toReader(clients: ClientStateRepository): PrincipalSessionRowsReader {
    return {
        findPrincipal: (ref) => clients.findPrincipal(ref),
        listSessionsForPrincipal: (ref) => clients.listSessionsForPrincipal(ref),
        nowEpochMs: () => NOW_EPOCH_MS
    };
}

async function seedAlice(lifecycle: PrincipalLifecycle): Promise<ClientStateRepository> {
    const clients = createTestClientStateRepository(new FakeRuntimeStateRepository());
    await clients.insertPrincipal(principal(lifecycle));
    await clients.insertInstance(instance());
    await clients.insertSession({
        ...session('alice-closed'),
        status: 'disconnected',
        disconnectedAtEpochMs: 2,
        disconnectReason: 'closed'
    });
    await clients.insertSession(session('alice-live'));
    return clients;
}

/** The principal's status with the stamps that status carries. */
type PrincipalLifecycle =
    | Readonly<{ status: 'active'; disabled: null; deleted: null; }>
    | Readonly<{ status: 'disabled'; disabled: AuditStamp; deleted: null; }>;

function principal(lifecycle: PrincipalLifecycle): ClientPrincipal {
    return {
        ...ALICE,
        username: 'alice',
        displayName: 'alice',
        avatarUrl: null,
        authProvider: null,
        externalSubjectId: null,
        ...lifecycle,
        roles: [],
        metadata: {},
        snapshotVersion: 1,
        profileVersion: 1,
        presenceVersion: 1,
        created: audit(),
        updated: audit(),
        lastSeenAtEpochMs: 1
    };
}

function instance(): ClientInstance {
    return {
        ...ALICE,
        clientInstanceId: 'alice-instance',
        status: 'active',
        revoked: null,
        platform: 'web',
        deviceLabel: null,
        appVersion: null,
        userAgent: null,
        capabilities: [],
        registered: audit(),
        updated: audit()
    };
}

function session(sessionId: string): ClientSession {
    return {
        ...ALICE,
        clientInstanceId: 'alice-instance',
        sessionId,
        generationId: `${sessionId}-generation`,
        generationVersion: 1,
        status: 'active',
        presenceState: 'online',
        transport: 'ws',
        connectionId: null,
        authenticatedAtEpochMs: 1,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: NOW_EPOCH_MS + 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

function audit(): AuditStamp {
    return { atEpochMs: 1, actor: { kind: 'service', serviceId: 'test' }, reason: null, traceId: null, requestId: null };
}
