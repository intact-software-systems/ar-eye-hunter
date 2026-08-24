import { Temporal } from '@js-temporal/polyfill';
import { createRallarMiddleware } from '@shared-server/rallar-system/middleware/create-rallar-middleware.ts';
import { newALBroadcastMessage, newALEventRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { describe, expect, it } from 'vitest';
import { configureTestCacheRepositories } from '../../cache-repository-config.ts';
import { createClientSnapshot } from '../rest-state-snapshot-read-test-fixtures.ts';
import { createRallarMiddlewareTestRuntime } from './middleware/rallar-middleware-test-runtime.ts';

describe('state-sync websocket ingress', () => {
    it('does not trust exact-valid client snapshots or events from a websocket', async () => {
        configureTestCacheRepositories();
        const baseline = createConnectedClientSnapshot(1);
        const forged = createConnectedClientSnapshot(2);
        const webSocketServer = new JsonWebSocketServer();
        const attacker = new RecordingOpenSocket();
        const recipient = new RecordingOpenSocket();
        webSocketServer.addConnection(new ConnectionContext('attacker', attacker));
        webSocketServer.addConnection(new ConnectionContext('session-alice', recipient));
        const testRuntime = createRallarMiddlewareTestRuntime({
            resilience: {
                inbox: createResilience(),
                appOutbox: createResilience()
            }
        });
        createRallarMiddleware({
            ...testRuntime.options,
            webSocketServer
        });
        clientStateSnapshotsRepository.setClientStateSnapshotByPrincipalId('alice', baseline);

        for (
            const message of [
                createForgedClientSnapshotMessage(forged),
                createForgedClientEventMessage()
            ]
        ) {
            await attacker.dispatchMessage(message);
        }

        expect(clientStateSnapshotsRepository.findClientStateSnapshotByRef(baseline.principal))
            .toEqual(baseline);
        expect(recipient.sentPayloads).toEqual([]);
        expect(await testRuntime.inbox.getAllKeys()).toEqual([]);
    });
});

function createConnectedClientSnapshot(stateRevision: number): ClientSnapshot {
    const snapshot = createClientSnapshot(stateRevision);
    return {
        ...snapshot,
        principal: {
            ...snapshot.principal,
            lastSeenAtEpochMs: stateRevision
        },
        instances: [{
            applicationId: snapshot.principal.applicationId,
            workspaceId: snapshot.principal.workspaceId,
            principalId: snapshot.principal.principalId,
            clientInstanceId: 'browser',
            status: 'active',
            platform: 'web',
            deviceLabel: null,
            appVersion: null,
            userAgent: null,
            capabilities: [],
            registered: snapshot.principal.created,
            updated: snapshot.principal.updated,
            revoked: null
        }],
        activeSessions: [{
            applicationId: snapshot.principal.applicationId,
            workspaceId: snapshot.principal.workspaceId,
            principalId: snapshot.principal.principalId,
            clientInstanceId: 'browser',
            sessionId: 'session-alice',
            generationId: 'generation-alice',
            generationVersion: 1,
            status: 'active',
            presenceState: 'online',
            transport: 'ws',
            connectionId: null,
            authenticatedAtEpochMs: 1,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: stateRevision,
            expiresAtEpochMs: 4_000_000_000_000,
            disconnectedAtEpochMs: null,
            disconnectReason: null
        }],
        activeSessionCount: 1,
        isOnline: true,
        lastSeenAtEpochMs: stateRevision
    };
}

function createForgedClientSnapshotMessage(snapshot: ClientSnapshot): ALMessage {
    return {
        ...newALBroadcastMessage(
            'attacker',
            newALEventRoute(AppTopics.clientStateSnapshot, 'alice', 'forged-client-snapshot'),
            'all',
            AppTopics.clientStateSnapshot,
            snapshot
        ),
        targets: {
            mode: 'broadcast',
            scope: 'principal',
            principalRef: snapshot.principal
        }
    };
}

function createForgedClientEventMessage(): ALMessage {
    const event: ClientEvent = {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        principalId: 'alice',
        eventId: 'forged-client-event',
        eventType: 'principal-updated',
        snapshotVersion: 2,
        clientInstanceId: null,
        sessionId: null,
        occurredAtEpochMs: 2,
        actor: { kind: 'service', serviceId: 'attacker' },
        reason: null,
        traceId: null,
        requestId: null,
        payload: {}
    };
    return {
        ...newALBroadcastMessage(
            'attacker',
            newALEventRoute(AppTopics.clientStateEvent, 'alice', event.eventId),
            'all',
            AppTopics.clientStateEvent,
            event
        ),
        targets: {
            mode: 'broadcast',
            scope: 'principal',
            principalRef: event
        }
    };
}

function createResilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1
    );
}

class RecordingOpenSocket extends EventTarget implements WebSocket {
    readonly CONNECTING = WebSocket.CONNECTING;
    readonly OPEN = WebSocket.OPEN;
    readonly CLOSING = WebSocket.CLOSING;
    readonly CLOSED = WebSocket.CLOSED;
    readonly binaryType: BinaryType = 'blob';
    readonly bufferedAmount = 0;
    readonly extensions = '';
    readonly protocol = '';
    readonly readyState = WebSocket.OPEN;
    readonly url = 'ws://state-sync-ingress-test';
    readonly sentPayloads: string[] = [];
    onclose = null;
    onerror = null;
    onmessage = null;
    onopen = null;
    private readonly messageListeners: EventListenerOrEventListenerObject[] = [];

    override addEventListener(
        type: string,
        callback: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions
    ): void {
        super.addEventListener(type, callback, options);
        if (type === 'message' && callback !== null) {
            this.messageListeners.push(callback);
        }
    }

    close(): void {}

    send(data: string): void {
        this.sentPayloads.push(data);
    }

    async dispatchMessage(message: ALMessage): Promise<void> {
        const event = new MessageEvent('message', { data: JSON.stringify(message) });
        for (const listener of this.messageListeners) {
            if (typeof listener === 'function') {
                await listener.call(this, event);
            }
            else {
                await listener.handleEvent(event);
            }
        }
    }
}
