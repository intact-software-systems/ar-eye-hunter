import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { initGroupStateResyncOnReopen } from '@shared-web/browser/state-read/group-state-resync-on-reopen.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { TestWebSocket } from '../shared/websocket/test-web-socket.ts';
import { createGroupSnapshotFixture } from './authoritative-group-fixtures.ts';

describe('group-state resync on WS reopen', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('cancels retained fragments on close, reopen and teardown while refreshing current state', async () => {
        const socket = await createConnectedSocket();
        const groups = [createGroupSnapshotFixture({ applicationId: 'app', workspaceId: 'workspace', groupId: 'room-a', sessionIds: [] })];
        const refreshed: typeof groups[] = [];
        const fragments = new Set(['old-connection-fragment']);
        const stop = initGroupStateResyncOnReopen({
            cancelSnapshotAssemblies: () => {
                fragments.clear();
            },
            socket,
            resyncStateSnapshots: async () => groups,
            resyncGroupTopologies: async (snapshots) => {
                refreshed.push([...snapshots]);
            },
            isCurrentGeneration: () => true
        });

        await reopenSocket(socket);

        expect(refreshed).toEqual([groups]);
        expect([...fragments]).toEqual([]);
        fragments.add('disconnected-fragment');
        const nativeSocket = TestWebSocket.instances.at(-1);
        if (!nativeSocket) {
            throw new Error('Expected the connected native socket');
        }
        nativeSocket.disconnect(1006, 'connection-lost');
        expect([...fragments]).toEqual([]);
        fragments.add('teardown-fragment');
        stop();
        expect([...fragments]).toEqual([]);
    });

    it('skips the resync entirely on a stale generation', async () => {
        const socket = await createConnectedSocket();
        const requests: string[] = [];
        initGroupStateResyncOnReopen({
            cancelSnapshotAssemblies: () => {
                requests.push('cancel-current-fragments');
            },
            socket,
            resyncStateSnapshots: async () => {
                requests.push('snapshots');
                return [];
            },
            resyncGroupTopologies: async () => {
                requests.push('topologies');
            },
            isCurrentGeneration: () => false
        });

        await reopenSocket(socket);

        expect(requests).toEqual([]);
    });

    it('stops before the topology pull when the generation goes stale mid-resync', async () => {
        const socket = await createConnectedSocket();
        let current = true;
        const requests: string[] = [];
        initGroupStateResyncOnReopen({
            cancelSnapshotAssemblies: () => {},
            socket,
            resyncStateSnapshots: async () => {
                requests.push('snapshots');
                current = false;
                return [];
            },
            resyncGroupTopologies: async () => {
                requests.push('topologies');
            },
            isCurrentGeneration: () => current
        });

        await reopenSocket(socket);

        expect(requests).toEqual(['snapshots']);
    });

    it('stops requesting snapshots after its subscription is stopped', async () => {
        const socket = await createConnectedSocket();
        const requests: string[] = [];
        const stop = initGroupStateResyncOnReopen({
            cancelSnapshotAssemblies: () => {},
            socket,
            resyncStateSnapshots: async () => {
                requests.push('snapshots');
                return [];
            },
            resyncGroupTopologies: async () => {
                requests.push('topologies');
            },
            isCurrentGeneration: () => true
        });

        stop();
        await reopenSocket(socket);

        expect(requests).toEqual([]);
    });

    it('isolates a failed resync and recovers on the next reopen', async () => {
        const socket = await createConnectedSocket();
        let attempts = 0;
        const refreshed: string[] = [];
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        initGroupStateResyncOnReopen({
            cancelSnapshotAssemblies: () => {},
            socket,
            resyncStateSnapshots: async () => {
                if (++attempts === 1) {
                    throw new Error('refresh failed');
                }
                return [];
            },
            resyncGroupTopologies: async () => {
                refreshed.push('topologies');
            },
            isCurrentGeneration: () => true
        });

        await reopenSocket(socket);
        expect(refreshed).toEqual([]);
        await reopenSocket(socket);

        expect(refreshed).toEqual(['topologies']);
    });
});

async function createConnectedSocket(): Promise<JsonWebSocketClient> {
    vi.stubGlobal('WebSocket', TestWebSocket);
    const socket = new JsonWebSocketClient('ws://test');
    onTestFinished(() => socket.close());
    await reopenSocket(socket);
    return socket;
}

async function reopenSocket(socket: JsonWebSocketClient): Promise<void> {
    socket.close();
    const connected = socket.connect();
    await Promise.resolve();
    const nativeSocket = TestWebSocket.instances.at(-1);
    if (!nativeSocket) {
        throw new Error('Expected connect to create a native WebSocket');
    }
    nativeSocket.open();
    await connected;
}
