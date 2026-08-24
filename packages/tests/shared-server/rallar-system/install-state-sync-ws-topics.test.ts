import { installStateSyncWsTopics } from '@shared-server/rallar-system/state-sync/install-state-sync-ws-topics.ts';
import { newALBroadcastMessage, newALEventRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OnWebSocketServerMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { describe, expect, it, vi } from 'vitest';

describe('state-sync websocket topic installation', () => {
    it('rejects an unsupported payload type before cache observation or publication', async () => {
        const service = new CapturingWsService();
        const observeGroupSnapshot = vi.fn();
        installStateSyncWsTopics(service, { observeGroupSnapshot });
        const callback = service.getInboxCallback(AppTopics.groupStateSnapshot);
        const webSocketServer = createWebSocketServer();
        const message = newALBroadcastMessage(
            'server-1',
            newALEventRoute(AppTopics.groupStateSnapshot, 'room-1', 'snapshot-1'),
            'room',
            'unsupported.state-sync.v1',
            { forged: true }
        );

        await callback.onMessage(message, {} as ResourceEntry, webSocketServer);

        expect(observeGroupSnapshot).not.toHaveBeenCalled();
        expect(webSocketServer.broadcast).not.toHaveBeenCalled();
        expect(webSocketServer.encode).not.toHaveBeenCalled();
        expect(webSocketServer.sendEncoded).not.toHaveBeenCalled();
    });
});

class CapturingWsService implements Pick<WsQueueBoxServerService, 'onInboxMessageDo' | 'onOutboxMessageDo'> {
    private readonly inboxCallbacks = new Map<string, OnWebSocketServerMessageCallback<ALMessage>>();

    onInboxMessageDo(
        topicId: string,
        callback: OnWebSocketServerMessageCallback<ALMessage>
    ): this {
        this.inboxCallbacks.set(topicId, callback);
        return this;
    }

    onOutboxMessageDo(
        _topicId: string,
        _callback: OnWebSocketServerMessageCallback<ALMessage>
    ): this {
        return this;
    }

    getInboxCallback(topicId: string): OnWebSocketServerMessageCallback<ALMessage> {
        const callback = this.inboxCallbacks.get(topicId);
        if (!callback) {
            throw new Error(`Missing inbox callback for ${topicId}`);
        }
        return callback;
    }
}

function createWebSocketServer(): JsonWebSocketServer {
    const webSocketServer = new JsonWebSocketServer();
    vi.spyOn(webSocketServer, 'broadcast');
    vi.spyOn(webSocketServer, 'encode');
    vi.spyOn(webSocketServer, 'sendEncoded');
    return webSocketServer;
}
