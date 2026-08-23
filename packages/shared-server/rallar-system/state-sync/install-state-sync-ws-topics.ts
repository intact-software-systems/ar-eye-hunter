import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { sendStateSyncMessage } from './state-sync-websocket-publication.ts';

export interface InstallStateSyncWsTopicsOptions {
    readonly observeGroupSnapshot?: (snapshot: GroupSnapshot) => void | Promise<void>;
    readonly observeClientSnapshot?: (snapshot: ClientSnapshot) => void | Promise<void>;
}

export function installStateSyncWsTopics(
    service: WsQueueBoxServerService,
    options: InstallStateSyncWsTopicsOptions = {}
): void {
    installStateSyncTopic(AppTopics.clientStateSnapshot, service, async (value) => {
        const snapshot = value as ClientSnapshot;
        if (options.observeClientSnapshot) {
            await options.observeClientSnapshot(snapshot);
            return;
        }
        clientStateSnapshotsRepository.setClientStateSnapshotByPrincipalId(
            snapshot.principal.principalId,
            snapshot
        );
    });
    installStateSyncTopic(AppTopics.clientStateEvent, service);
    const observeGroupSnapshot = async (value: unknown): Promise<void> => {
        const snapshot = value as GroupSnapshot;
        if (options.observeGroupSnapshot) {
            await options.observeGroupSnapshot(snapshot);
            return;
        }
        groupStateSnapshotsRepository.setGroupStateSnapshot(snapshot);
    };
    installStateSyncTopic(AppTopics.groupStateSnapshot, service, observeGroupSnapshot);
    installStateSyncTopic(AppTopics.groupDirectorySnapshot, service, observeGroupSnapshot);
    installStateSyncTopic(AppTopics.groupStateEvent, service);
}

function installStateSyncTopic(
    topicId: string,
    service: WsQueueBoxServerService,
    observe?: (value: unknown) => void | Promise<void>
): void {
    const onMessage = async (
        message: ALMessage,
        _entry: ResourceEntry,
        server: JsonWebSocketServer
    ): Promise<void> => {
        if (message.route.topicId !== topicId) {
            return;
        }
        await observe?.(JSON.parse(message.payload.resource));
        sendStateSyncMessage(server, message);
    };
    service.onInboxMessageDo(topicId, { onMessage });
    service.onOutboxMessageDo(topicId, { onMessage });
}
