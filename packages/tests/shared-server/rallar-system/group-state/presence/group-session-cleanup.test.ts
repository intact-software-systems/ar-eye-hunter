import type { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { SESSIONS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { readGroupSessionCleanupCandidates } from '@shared-server/rallar-system/group-state/presence/group-session-cleanup.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { GroupPresenceSession, GroupScope } from '@shared/api/group-types.ts';
import { describe, expect, it } from 'vitest';

import { ReadBatchFakeRuntimeStateRepository } from '../../../runtime-state/test-support/read-batch-fake-runtime-state-repository.ts';

const SCOPE: GroupScope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
const AUTH_SESSION = {
    clientId: 'alice',
    username: 'alice',
    sessionId: 'session:alice=1',
    issuedAtEpochMs: 1_000,
    expiresAtEpochMs: 1_000_000
} as const;
const DISCONNECTED_AT_EPOCH_MS = 5_000;

describe('group session cleanup candidates', () => {
    it('reads the disconnecting session\'s presence rows by their key suffix, never the whole namespace', async () => {
        const { runtime, groups } = createRuntime();
        await groups.putPresenceSession(session({ groupId: 'room-one' }));
        await groups.putPresenceSession(session({ groupId: 'room-two' }));
        // Ids that share the session id's tail or extend it, around its encoded ':' and '='.
        await groups.putPresenceSession(session({ groupId: 'room-two', sessionId: 'xsession:alice=1' }));
        await groups.putPresenceSession(session({ groupId: 'room-two', sessionId: 'session:alice=12' }));
        await groups.putPresenceSession(session({ groupId: 'unrelated', sessionId: 'session-bob', principalId: 'bob' }));
        runtime.readBatchCalls.length = 0;

        const candidates = await readCandidates(groups);

        expect(candidates.map((candidate) => `${candidate.groupId}/${candidate.sessionId}`)).toEqual([
            'room-one/session:alice=1',
            'room-two/session:alice=1'
        ]);
        expect(runtime.wholeNamespaceReads).not.toContain(SESSIONS_NAMESPACE);
        expect(runtime.readBatchCalls.flat().map((selector) => [selector.namespace, selector.kind])).toEqual([
            [SESSIONS_NAMESPACE, 'suffix']
        ]);
    });

    it('keeps only the principal\'s live rows in the disconnect scope that predate the disconnect', async () => {
        const { groups } = createRuntime();
        await groups.putPresenceSession(session({ groupId: 'kept' }));
        await groups.putPresenceSession(session({ groupId: 'other-workspace', workspaceId: 'workspace-2' }));
        await groups.putPresenceSession(session({ groupId: 'other-principal', principalId: 'mallory' }));
        await groups.putPresenceSession(session({ groupId: 'already-disconnected', disconnectedAtEpochMs: 4_000 }));
        await groups.putPresenceSession(session({ groupId: 'reconnected-later', connectedAtEpochMs: 6_000 }));
        await groups.putPresenceSession(session({ groupId: 'heartbeat-later', lastHeartbeatAtEpochMs: 6_000 }));
        await groups.putPresenceSession(session({ groupId: 'other-session', sessionId: 'session:alice=2' }));

        const candidates = await readCandidates(groups);

        expect(candidates.map((candidate) => candidate.groupId)).toEqual(['kept']);
    });
});

interface SessionInput {
    readonly groupId: string;
    readonly sessionId?: string;
    readonly principalId?: string;
    readonly workspaceId?: string;
    readonly connectedAtEpochMs?: number;
    readonly lastHeartbeatAtEpochMs?: number;
    readonly disconnectedAtEpochMs?: number;
}

function createRuntime() {
    const runtime = new ReadBatchFakeRuntimeStateRepository();
    return { runtime, groups: createTestGroupStateRepository(runtime) };
}

async function readCandidates(groups: GroupStateRepository): Promise<readonly GroupPresenceSession[]> {
    return await readGroupSessionCleanupCandidates(groups, {
        scope: SCOPE,
        authSession: AUTH_SESSION,
        principalId: AUTH_SESSION.clientId,
        disconnectedAtEpochMs: DISCONNECTED_AT_EPOCH_MS
    });
}

function session(input: SessionInput): GroupPresenceSession {
    const connectedAtEpochMs = input.connectedAtEpochMs ?? 2_000;
    const common = {
        applicationId: SCOPE.applicationId,
        workspaceId: input.workspaceId ?? SCOPE.workspaceId,
        groupId: input.groupId,
        sessionId: input.sessionId ?? AUTH_SESSION.sessionId,
        principalId: input.principalId ?? AUTH_SESSION.clientId,
        generationId: 'generation-1',
        generationVersion: connectedAtEpochMs,
        connectedAtEpochMs,
        lastHeartbeatAtEpochMs: input.lastHeartbeatAtEpochMs ?? Math.max(connectedAtEpochMs, 3_000),
        expiresAtEpochMs: Number.MAX_SAFE_INTEGER
    };
    return input.disconnectedAtEpochMs === undefined
        ? { ...common, status: 'active', disconnectedAtEpochMs: null, disconnectReason: null }
        : {
            ...common,
            status: 'disconnected',
            disconnectedAtEpochMs: input.disconnectedAtEpochMs,
            disconnectReason: 'closed'
        };
}
