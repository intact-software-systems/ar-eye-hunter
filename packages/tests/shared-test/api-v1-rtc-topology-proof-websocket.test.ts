import type { ProofSession } from '@shared-test/black-box-runner/topology-replay/api-v1-rtc-topology-proof-api.mts';
import { ApiV1RtcTopologyProofSocket } from '@shared-test/black-box-runner/topology-replay/api-v1-rtc-topology-proof-websocket.mts';
import { afterEach, expect, it, vi } from 'vitest';
import { TestWebSocket } from '../shared/websocket/test-web-socket.ts';

const session: ProofSession = {
    label: 'scope-proof',
    principal: 'alice',
    clientId: 'alice',
    sessionId: 'session/one',
    accessToken: 'unused-test-token',
    apiBaseUrl: 'http://localhost',
    wsBaseUrl: 'ws://localhost'
};

afterEach(() => vi.unstubAllGlobals());

it.each([
    { applicationId: 'proof-app', workspaceId: 'proof-workspace', groupId: 'room' },
    { applicationId: 'app &/?=é', workspaceId: 'workspace #+&', groupId: 'room' }
])('binds the proof socket authorization URL to its expected snapshot scope $applicationId', async (groupRef) => {
    vi.stubGlobal('WebSocket', TestWebSocket);
    const opening = ApiV1RtcTopologyProofSocket.open(session, 'ticket?&=+', groupRef);
    const socket = TestWebSocket.instances.at(-1)!;
    socket.open();
    const proof = await opening;
    try {
        const url = new URL(socket.url);
        expect(url.pathname).toBe('/api/ws/session%2Fone');
        expect(url.searchParams.get('ticket')).toBe('ticket?&=+');
        expect(url.searchParams.get('applicationId')).toBe(groupRef.applicationId);
        expect(url.searchParams.get('workspaceId')).toBe(groupRef.workspaceId);
        expect([...url.searchParams.keys()].sort()).toEqual(['applicationId', 'ticket', 'workspaceId']);
    }
    finally {
        proof.close();
    }
});
