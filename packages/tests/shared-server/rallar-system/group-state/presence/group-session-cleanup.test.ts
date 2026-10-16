import type { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { readGroupSessionCleanupCandidates } from '@shared-server/rallar-system/group-state/presence/group-session-cleanup.ts';
import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector
} from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { GroupPresenceSession, GroupScope } from '@shared/api/group-types.ts';
import { describe, expect, it } from 'vitest';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';

const SCOPE: GroupScope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
const AUTH_SESSION = {
    clientId: 'alice',
    username: 'alice',
    sessionId: 'session-alice',
    accessTokenDigest: 'digest-alice',
    issuedAtEpochMs: 1_000,
    expiresAtEpochMs: 1_000_000
} as const;
const DISCONNECTED_AT_EPOCH_MS = 5_000;

class RowCountingRuntime extends FakeRuntimeStateRepository {
    rowsReturned = 0;

    override async findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
        const entries = await super.findAllEntries(namespace);
        this.rowsReturned += entries.length;
        return entries;
    }

    override async readRuntimeStateBatch(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        const selections = await super.readRuntimeStateBatch(selectors);
        this.rowsReturned += selections.reduce((total, selection) => total + selection.entries.length, 0);
        return selections;
    }
}

describe('group session cleanup candidates', () => {
    it.each([0, 8, 32])(
        'reads only the disconnecting session\'s presence rows beside %i unrelated groups',
        async (unrelatedGroupCount) => {
            const { runtime, groups } = createRuntime();
            await groups.putPresenceSession(session({ groupId: 'room-one' }));
            await groups.putPresenceSession(session({ groupId: 'room-two' }));
            for (let index = 0; index < unrelatedGroupCount; index += 1) {
                await groups.putPresenceSession(session({
                    groupId: `unrelated-${index}`,
                    sessionId: `session-${index}`,
                    principalId: `principal-${index}`
                }));
            }
            runtime.rowsReturned = 0;

            const candidates = await readCandidates(groups);

            expect(candidates.map((candidate) => candidate.groupId)).toEqual(['room-one', 'room-two']);
            // The read is keyed by the session, so its row count does not grow with unrelated groups.
            expect(runtime.rowsReturned).toBe(2);
        }
    );

    it('keeps only the principal\'s live rows in the disconnect scope that predate the disconnect', async () => {
        const { groups } = createRuntime();
        await groups.putPresenceSession(session({ groupId: 'kept' }));
        await groups.putPresenceSession(session({ groupId: 'other-workspace', workspaceId: 'workspace-2' }));
        await groups.putPresenceSession(session({ groupId: 'other-principal', principalId: 'mallory' }));
        await groups.putPresenceSession(session({ groupId: 'already-disconnected', disconnectedAtEpochMs: 4_000 }));
        await groups.putPresenceSession(session({ groupId: 'reconnected-later', connectedAtEpochMs: 6_000 }));
        await groups.putPresenceSession(session({ groupId: 'heartbeat-later', lastHeartbeatAtEpochMs: 6_000 }));
        await groups.putPresenceSession(session({ groupId: 'other-session', sessionId: 'session-alice-2' }));

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
    const runtime = new RowCountingRuntime();
    return { runtime, groups: createTestGroupStateRepository(runtime) };
}

async function readCandidates(groups: GroupStateRepository): Promise<readonly GroupPresenceSession[]> {
    return await readGroupSessionCleanupCandidates(
        groups,
        { findBySessionId: async (sessionId) => (sessionId === AUTH_SESSION.sessionId ? AUTH_SESSION : undefined) },
        {
            scope: SCOPE,
            authSession: AUTH_SESSION,
            principalId: AUTH_SESSION.clientId,
            disconnectedAtEpochMs: DISCONNECTED_AT_EPOCH_MS
        }
    );
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
