import { test } from 'bun:test';
import assert from 'node:assert/strict';

import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { stopNativeReceiptScenario } from './native-admission-test-cleanup.ts';
import {
    createNativeSessionTestFixture,
    issueNativeWebSocketTicket,
    type NativeSessionTestFixture
} from './native-session-test-fixture.ts';

const SNAPSHOT_WAIT_MS = 15_000;

interface NativeSocketPeer {
    readonly socket: JsonWebSocketClient;
    readonly snapshot: Promise<unknown>;
}

test('a replaced socket still receives its own connect snapshot', async () => {
    const fixture = await createNativeSessionTestFixture();
    const peers: NativeSocketPeer[] = [];
    let primaryFailure: Error | undefined;
    try {
        const baseUrl = await fixture.start();
        const session = await issueSession(fixture);
        const first = await connectPeer(baseUrl, session, 0);
        peers.push(first);
        await waitForSnapshot(first);

        const second = await connectPeer(baseUrl, session, 1);
        peers.push(second);
        await waitForSnapshot(second);

        const live = fixture.runtime.wsQBoxServerService.socket.connections.get(session.sessionId);
        assert.ok(live?.isOpen, 'the replacement socket must remain the session live connection');
    }
    catch (error) {
        primaryFailure = error instanceof Error ? error : new Error(String(error));
        throw primaryFailure;
    }
    finally {
        await stopNativeReceiptScenario({
            releaseDeliveryRegistry: () => {},
            stopPeers: peers.map((peer) => () => closePeer(peer)),
            stopRuntime: (closures, failure) => fixture.stop(closures, failure),
            primaryFailure,
            reportSecondaryFailures: (failure) => console.error('WS socket replacement cleanup failure', failure)
        });
    }
}, 60_000);

async function issueSession(fixture: NativeSessionTestFixture): Promise<IssuedAuthSession> {
    const issued = await fixture.runtime.appAuthInboxService.issueSession({
        requestId: 'ws-socket-replacement-session',
        traceId: 'trace-ws-socket-replacement',
        clientId: 'alice',
        username: 'alice',
        authority: { kind: 'static-client', clientId: 'alice', normalizedUsername: 'alice' },
        ttlMs: fixture.sessionTtlMs
    });
    assert.ok(issued.right, 'the session must issue');
    const persisted = await fixture.runtime.authSessionRepository.findBySessionId(issued.right.sessionId);
    assert.ok(persisted, 'the issued session must have durable auth authority');
    return { ...issued.right, issuedAtEpochMs: persisted.issuedAtEpochMs };
}

async function connectPeer(baseUrl: string, session: IssuedAuthSession, index: number): Promise<NativeSocketPeer> {
    const ticket = await issueNativeWebSocketTicket(baseUrl, session, index);
    const socket = new JsonWebSocketClient(
        toSocketUrl(baseUrl, session.sessionId, ticket),
        createPassThroughTransportFaultPort()
    );
    const snapshot = Promise.withResolvers<unknown>();
    socket.onWebSocketMessageDo('ws-socket-replacement-observer', {
        onMessage: (value) => {
            const message = decodeALMessageValue(value).right;
            if (message?.payload.typeId === 'client-state.snapshot') {
                snapshot.resolve(value);
            }
            return Promise.resolve();
        }
    });
    await socket.connect({ signal: AbortSignal.timeout(45_000) });
    return { socket, snapshot: snapshot.promise };
}

function toSocketUrl(baseUrl: string, sessionId: string, ticket: string): string {
    const url = new URL(`/api/ws/${sessionId}`, baseUrl);
    url.protocol = 'ws:';
    url.searchParams.set('ticket', ticket);
    url.searchParams.set('applicationId', 'rallar-server');
    url.searchParams.set('workspaceId', 'default');
    return url.toString();
}

async function waitForSnapshot(peer: NativeSocketPeer): Promise<void> {
    await Promise.race([
        peer.snapshot,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('connect snapshot was not received')), SNAPSHOT_WAIT_MS))
    ]);
}

async function closePeer(peer: NativeSocketPeer): Promise<void> {
    const socket = peer.socket.ws;
    const closed = socket === undefined || socket.readyState === WebSocket.CLOSED
        ? Promise.resolve()
        : new Promise<void>((resolve) => socket.addEventListener('close', () => resolve(), { once: true }));
    peer.socket.close();
    await closed;
}
