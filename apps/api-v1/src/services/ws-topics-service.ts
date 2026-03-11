import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { AppTopics, RttMeasurementInfo } from '@shared/api/api-config.ts';
import { QRtcSignalingMessage } from '@shared/webrtc/QRtcSignalingContracts.ts';
import * as rttRepository from '@shared/repository/rtt-repository.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import * as vivaldiService from '@shared-graph/vivaldi-service.ts';
import { computeGlobalGraphAndCacheIt } from '@shared-graph/group-graphs-create-service.ts';
import { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { initDynamicWsTopicRouter } from './ws-topic-router.ts';

export function initWsTopics(
    wsQBoxServerService: WsQueueBoxServerService,
) {
    initStateBroadcastTopic(
        AppTopics.clientStateSnapshot,
        wsQBoxServerService,
        (rawData) => {
            const data = rawData as ClientSnapshot;
            clientStateSnapshotsRepository.setClientStateSnapshotByPrincipalId(
                data.principal.principalId,
                data,
            );
        },
    );
    initStateBroadcastTopic(AppTopics.clientStateEvent, wsQBoxServerService);
    initStateBroadcastTopic(
        AppTopics.groupStateSnapshot,
        wsQBoxServerService,
        (rawData) => {
            const data = rawData as GroupSnapshot;
            groupStateSnapshotsRepository.setGroupStateSnapshotById(
                data.group.groupId,
                data,
            );
        },
    );
    initStateBroadcastTopic(AppTopics.groupStateEvent, wsQBoxServerService);
    initGraphsTopic(wsQBoxServerService);
    initChatTopic(wsQBoxServerService);
    initRttTopic(wsQBoxServerService);
    initRtcSignalingTopic(wsQBoxServerService);
    initDynamicWsTopicRouter(wsQBoxServerService);
}

function initStateBroadcastTopic(
    topicId: string,
    wsQBoxServerService: WsQueueBoxServerService,
    onState?: (data: unknown) => void,
) {
    const acceptState = (data: ALMessage) => {
        if (!onState) {
            return;
        }

        onState(JSON.parse(data.payload.resource));
    };

    wsQBoxServerService
        .onInboxMessageDo(
            topicId,
            {
                onMessage: (
                    data: ALMessage,
                    _: ResourceEntry,
                    server: JsonWebSocketServer,
                ) => {
                    if (!isTopic(data, topicId)) {
                        return Promise.resolve();
                    }

                    acceptState(data);
                    server.broadcast(data);
                    return Promise.resolve();
                },
            },
        );

    wsQBoxServerService
        .onOutboxMessageDo(
            topicId,
            {
                onMessage: (
                    data: ALMessage,
                    _: ResourceEntry,
                    server: JsonWebSocketServer,
                ) => {
                    if (!isTopic(data, topicId)) {
                        return Promise.resolve();
                    }

                    acceptState(data);
                    server.broadcast(data);
                    return Promise.resolve();
                },
            },
        );
}

function initGraphsTopic(wsQBoxServerService: WsQueueBoxServerService) {
    wsQBoxServerService
        .onInboxMessageDo(
            AppTopics.graphs,
            {
                onMessage: (
                    data: ALMessage,
                    _: ResourceEntry,
                    server: JsonWebSocketServer,
                ) => {
                    if (!isTopic(data, AppTopics.graphs)) {
                        return Promise.resolve();
                    }

                    server.broadcast(data);
                    return Promise.resolve();
                },
            },
        );

    wsQBoxServerService
        .onOutboxMessageDo(
            AppTopics.graphs,
            {
                onMessage: (
                    data: ALMessage,
                    _: ResourceEntry,
                    server: JsonWebSocketServer,
                ) => {
                    if (!isTopic(data, AppTopics.graphs)) {
                        return Promise.resolve();
                    }

                    server.broadcast(data);
                    return Promise.resolve();
                },
            },
        );
}

function initChatTopic(wsQBoxServerService: WsQueueBoxServerService) {
    wsQBoxServerService
        .onInboxMessageDo(
            AppTopics.chat,
            {
                onMessage: (
                    data: ALMessage,
                    _: ResourceEntry,
                    server: JsonWebSocketServer,
                ) => {
                    if (!isTopic(data, AppTopics.chat)) {
                        return Promise.resolve();
                    }

                    server.broadcast(data);
                    return Promise.resolve();
                },
            },
        );
}

function initRttTopic(wsQBoxServerService: WsQueueBoxServerService) {
    wsQBoxServerService
        .onInboxMessageDo(
            AppTopics.rtt,
            {
                onMessage: (data: ALMessage) => {
                    if (!isTopic(data, AppTopics.rtt)) {
                        return Promise.resolve();
                    }

                    const rtt: RttMeasurementInfo = JSON.parse(
                        data.payload.resource,
                    ) as RttMeasurementInfo;

                    console.log(`Received RTT message: ${data.payload.resource}`);

                    const isUpdated = rttRepository.setRtt(rtt);
                    if (isUpdated) {
                        vivaldiService.observeRtt(rtt);
                        computeGlobalGraphAndCacheIt();
                    }

                    return Promise.resolve();
                },
            },
        );
}

function initRtcSignalingTopic(wsQBoxServerService: WsQueueBoxServerService) {
    wsQBoxServerService
        .onInboxMessageDo(
            AppTopics.rtcSignaling,
            {
                onMessage: (
                    data: ALMessage,
                    _: ResourceEntry,
                    server: JsonWebSocketServer,
                ) => {
                    if (!isTopic(data, AppTopics.rtcSignaling)) {
                        return Promise.resolve();
                    }

                    const msg: QRtcSignalingMessage = JSON.parse(
                        data.payload.resource,
                    ) as QRtcSignalingMessage;
                    if (msg === undefined) {
                        return Promise.reject('Invalid signaling message:');
                    }

                    console.log(`Received signaling message: ${JSON.stringify(msg)}`);

                    server.send(msg.toId, data);

                    return Promise.resolve();
                },
            },
        );
}

function isTopic(message: ALMessage, topicId: string): boolean {
    return message.route.topicId === topicId;
}
