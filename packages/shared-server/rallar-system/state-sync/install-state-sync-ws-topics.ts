import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import type { OnWebSocketServerMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { decodeStateSyncMessage, type StateSyncPayload } from './state-sync-payload.ts';
import { sendDecodedStateSyncMessage } from './state-sync-websocket-publication.ts';

export interface InstallStateSyncWsTopicsOptions {
    readonly observeGroupSnapshot?: (snapshot: GroupSnapshot) => void | Promise<void>;
    readonly observeClientSnapshot?: (snapshot: ClientSnapshot) => void | Promise<void>;
}

interface StateSyncWsTopicService {
    onInboxMessageDo(
        topicId: string,
        callback: OnWebSocketServerMessageCallback<ALMessage>
    ): void;
    onOutboxMessageDo(
        topicId: string,
        callback: OnWebSocketServerMessageCallback<ALMessage>
    ): void;
}

export function installStateSyncWsTopics(
    service: StateSyncWsTopicService,
    options: InstallStateSyncWsTopicsOptions = {}
): void {
    const onMessage = async (
        message: ALMessage,
        _entry: ResourceEntry,
        webSocketServer: JsonWebSocketServer
    ): Promise<void> => {
        const decoded = decodeStateSyncMessage(message);
        if (decoded.kind !== 'decoded') {
            return;
        }

        await observeStateSyncPayload(decoded.payload, options);
        sendDecodedStateSyncMessage({ webSocketServer, message, decoded });
    };

    for (const topicId of STATE_SYNC_TOPIC_IDS) {
        service.onInboxMessageDo(topicId, { onMessage });
        service.onOutboxMessageDo(topicId, { onMessage });
    }
}

async function observeStateSyncPayload(
    payload: StateSyncPayload,
    options: InstallStateSyncWsTopicsOptions
): Promise<void> {
    switch (payload.kind) {
        case 'client-snapshot':
            if (options.observeClientSnapshot) {
                await options.observeClientSnapshot(payload.snapshot);
                return;
            }
            clientStateSnapshotsRepository.setClientStateSnapshotByPrincipalId(
                payload.snapshot.principal.principalId,
                payload.snapshot
            );
            return;
        case 'group-snapshot':
        case 'group-directory-snapshot':
            if (options.observeGroupSnapshot) {
                await options.observeGroupSnapshot(payload.snapshot);
                return;
            }
            groupStateSnapshotsRepository.setGroupStateSnapshot(payload.snapshot);
            return;
        case 'client-event':
        case 'group-event':
            return;
    }
}

const STATE_SYNC_TOPIC_IDS = [
    AppTopics.clientStateSnapshot,
    AppTopics.clientStateEvent,
    AppTopics.groupStateSnapshot,
    AppTopics.groupDirectorySnapshot,
    AppTopics.groupStateEvent
] as const;
