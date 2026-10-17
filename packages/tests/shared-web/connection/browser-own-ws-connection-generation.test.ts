import { describe, expect, it, vi } from 'vitest';

import { BrowserOwnWsConnectionGeneration } from '@shared-web/browser/connection/browser-own-ws-connection-generation.ts';
import type { ClientSession, ClientSnapshot } from '@shared/api/client-types.ts';

import { createActiveClientSessionFixture, createClientSnapshotFixture } from '../authoritative-group-fixtures.ts';

const SCOPE = { applicationId: 'app-1', workspaceId: 'workspace-1', principalId: 'principal-1' };
const SESSION_ID = 'session-1';

describe('the own WebSocket connection generation', () => {
    it('reads it once per socket from a client snapshot read after the socket opened', async () => {
        const socket = { ws: openSocket() };
        const readOwnClientSnapshot = vi.fn(async () => snapshotNaming(authorisedWsSession('ws-generation-a')));
        const generation = new BrowserOwnWsConnectionGeneration({ socket, sessionId: SESSION_ID, readOwnClientSnapshot });

        expect((await generation.read()).right).toBe('ws-generation-a');
        // The same socket keeps the generation it was read under, whatever a later snapshot would name.
        readOwnClientSnapshot.mockResolvedValue(snapshotNaming(authorisedWsSession('ws-generation-later')));
        expect((await generation.read()).right).toBe('ws-generation-a');
        expect(generation.readKnown()).toBe('ws-generation-a');
    });

    it('never returns the closed socket\'s generation after a reconnect', async () => {
        const socket = { ws: openSocket() };
        const readOwnClientSnapshot = vi.fn(async () => snapshotNaming(authorisedWsSession('ws-generation-a')));
        const generation = new BrowserOwnWsConnectionGeneration({ socket, sessionId: SESSION_ID, readOwnClientSnapshot });
        await generation.read();

        socket.ws.readyState = WebSocket.CLOSED;
        expect(generation.readKnown()).toBeUndefined();
        expect((await generation.read()).left?.message).toBe('Cannot connect room presence: the WebSocket is not open.');

        socket.ws = openSocket();
        readOwnClientSnapshot.mockResolvedValueOnce(snapshotNaming(authorisedWsSession('ws-generation-b')));
        expect(generation.readKnown()).toBeUndefined();
        expect((await generation.read()).right).toBe('ws-generation-b');
    });

    it('refuses a read the socket outlived by reconnecting', async () => {
        const socket = { ws: openSocket() };
        const readOwnClientSnapshot = vi.fn(async () => {
            socket.ws = openSocket();
            return snapshotNaming(authorisedWsSession('ws-generation-a'));
        });
        const generation = new BrowserOwnWsConnectionGeneration({ socket, sessionId: SESSION_ID, readOwnClientSnapshot });

        expect((await generation.read()).left?.message).toBe(
            'Cannot connect room presence: the WebSocket reconnected while its generation was read.'
        );
        expect(generation.readKnown()).toBeUndefined();
    });

    it('ignores a session entry no authorised socket wrote', async () => {
        const socket = { ws: openSocket() };
        // The heartbeat repair without a known socket generation leaves the entry without a connection id.
        const repaired = { ...authorisedWsSession('heartbeat-generation'), connectionId: null };
        const generation = new BrowserOwnWsConnectionGeneration({
            socket,
            sessionId: SESSION_ID,
            readOwnClientSnapshot: async () => snapshotNaming(repaired)
        });

        expect((await generation.read()).left?.message).toBe(
            'Cannot connect room presence: the WebSocket connection generation is not known yet.'
        );
    });

    it('returns the snapshot read failure as the value', async () => {
        const failure = new Error('client snapshot read failed');
        const generation = new BrowserOwnWsConnectionGeneration({
            socket: { ws: openSocket() },
            sessionId: SESSION_ID,
            readOwnClientSnapshot: async () => {
                throw failure;
            }
        });

        expect((await generation.read()).left).toBe(failure);
    });
});

function openSocket(): { readyState: number; } {
    return { readyState: WebSocket.OPEN };
}

function authorisedWsSession(generationId: string): ClientSession {
    return {
        ...createActiveClientSessionFixture({ ...SCOPE, clientInstanceId: SCOPE.principalId, sessionId: SESSION_ID }),
        generationId,
        connectionId: generationId
    };
}

function snapshotNaming(session: ClientSession): ClientSnapshot {
    return { ...createClientSnapshotFixture(SCOPE), activeSessions: [session] };
}
