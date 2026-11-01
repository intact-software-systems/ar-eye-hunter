import type { AuthSession } from '@shared/api/api-config.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import { decodeMatchmakingMutationResult, type MatchmakingRequest } from '@shared/api/matchmaking/matchmaking-request.ts';
import { decodeMatchmakingSnapshot } from '@shared/api/matchmaking/matchmaking-snapshot.ts';
import assert from 'node:assert/strict';
import { createPGliteTracedRallarServer, issueTracedTestSession, type PGliteTracedRallarServer } from '../db/pglite-traced-rallar-test-runtime.ts';

const base = '/api/matchmaking/apps/game/workspaces/default';

Deno.test({
    name: 'default API matches two authenticated accounts, replays requests and exposes one committed room',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const server = await createPGliteTracedRallarServer();
        try {
            const alice = await issueTracedTestSession(server.rallar.runtime, 'alice');
            const admin = await issueTracedTestSession(server.rallar.runtime, 'admin');
            const first = await change(server, alice, { requestId: 'matchmaking-start-alice', request: { action: 'start', searchId: 'search-alice' } });
            assert.deepEqual(
                await change(server, alice, { requestId: 'matchmaking-start-alice', request: { action: 'start', searchId: 'search-alice' } }),
                first
            );
            assert.equal((await read(server, alice)).state.status, 'searching');
            await change(server, admin, { requestId: 'matchmaking-start-admin', request: { action: 'start', searchId: 'search-admin' } });
            assert.equal((await read(server, alice)).state.status, 'confirming');
            await change(server, alice, { requestId: 'matchmaking-confirm-alice', request: { action: 'confirm', searchId: 'search-alice' } });
            assert.equal((await read(server, admin)).state.status, 'confirming');
            await change(server, admin, { requestId: 'matchmaking-confirm-admin', request: { action: 'confirm', searchId: 'search-admin' } });
            const matched = (await read(server, alice)).state;
            assert.equal(matched.status, 'matched');
            if (matched.status !== 'matched') {
                throw new Error('Expected committed match');
            }
            assert.deepEqual((await read(server, admin)).state, { ...matched, searchId: 'search-admin' });
            const response = await server.app.request(`/api/state/apps/game/workspaces/default/groups/${matched.roomRef.groupId}`, { headers: headers(alice) });
            assert.equal(response.status, 200);
            const room: unknown = await response.json();
            validateAuthoritativeGroupSnapshot(room);
            assert.deepEqual(room.members.map((member) => member.principalId).sort(), ['admin', 'alice']);
            assert.equal(room.group.maxMembers, 2);
            const other = await server.app.request('/api/matchmaking/apps/other/workspaces/default', { headers: headers(alice) });
            assert.equal(decodeMatchmakingSnapshot(await other.json()).state.status, 'idle');
        }
        finally {
            await server.stop();
        }
    }
});

interface ChangeInput {
    readonly requestId: string;
    readonly request: MatchmakingRequest;
}

async function change(server: PGliteTracedRallarServer, session: AuthSession, input: ChangeInput) {
    const response = await server.app.request(`${base}/requests/${input.requestId}`, {
        method: 'POST',
        headers: headers(session),
        body: JSON.stringify(input.request)
    });
    assert.equal(response.status, 200, await response.clone().text());
    const result = decodeMatchmakingMutationResult(await response.json());
    assert.equal(result.status, 'applied');
    return result;
}

async function read(server: PGliteTracedRallarServer, session: AuthSession) {
    const response = await server.app.request(base, { headers: headers(session) });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    return decodeMatchmakingSnapshot(await response.json());
}

function headers(session: AuthSession): Record<string, string> {
    return { authorization: `Bearer ${session.accessToken}`, 'x-client-id': session.clientId, 'content-type': 'application/json' };
}
