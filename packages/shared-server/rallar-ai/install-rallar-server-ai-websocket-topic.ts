import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    assertRallarAiAuthorized,
    type RallarAiAuthorize,
    type RallarAiJsonResult,
    type RallarAiJsonValue
} from '@shared/rallar-ai/mod.ts';
import type { JsonWireValue } from '../rallar-system/protocol/json-wire-identity.ts';
import type {
    RallarServerWsFanout,
    RallarServerWsPublishResult
} from '../rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { isRallarServerAiJsonRequest, type RallarServerAiJsonRequest } from './decode-rallar-server-ai-json-request.ts';
import type { RallarServerAi } from './rallar-server-ai-contracts.ts';
import {
    toRallarServerAiPublicationTarget,
    toRallarServerAiResultMessage,
    type RallarServerAiResultPublicationInput,
    type RallarServerAiResultPublicationTarget
} from './rallar-server-ai-result-publication.ts';

export interface RallarServerAiWebSocketPort {
    defineTopic(definition: RallarServerAiWebSocketTopicDefinition): void;
    on(
        selector: RallarServerAiWebSocketSelector,
        handler: RallarServerAiWebSocketHandler
    ): () => boolean;
    publish(
        message: ALMessage,
        fanout?: RallarServerWsFanout
    ): Promise<RallarServerWsPublishResult>;
}

export interface RallarServerAiWebSocketSelector {
    readonly topicId: string;
    readonly typeId: string;
}

export interface RallarServerAiWebSocketMessage {
    readonly payload: RallarServerAiJsonRequest;
}

export interface RallarServerAiWebSocketMessageContext {
    readonly senderId: string;
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
}

export type RallarServerAiWebSocketHandler = (
    message: RallarServerAiWebSocketMessage,
    context: RallarServerAiWebSocketMessageContext
) => void | Promise<void>;

export interface RallarServerAiWebSocketTopicDefinition {
    readonly topicId: string;
    readonly typeId: string;
    readonly fanout: RallarServerWsFanout;
    readonly maxPayloadBytes: number;
    readonly validate: (value: JsonWireValue) => boolean;
    readonly authorize: RallarServerAiWebSocketHandlerAuthorization;
}

export type RallarServerAiWebSocketHandlerAuthorization = (
    message: RallarServerAiWebSocketMessage,
    context: RallarServerAiWebSocketMessageContext
) => boolean | Promise<boolean>;

export interface RallarServerAiWebSocketConfig {
    readonly requestTopicId: string;
    readonly requestTypeId: string;
    readonly resultTopicId: string;
    readonly resultTypeId: string;
    readonly requestFanout: RallarServerWsFanout;
    readonly resultFanout: RallarServerWsFanout;
    readonly resultScope: 'room' | 'world' | 'all';
    readonly maxPayloadBytes: number;
    readonly serverSenderId: string;
}

export interface InstallRallarServerAiWebSocketTopicInput {
    readonly websocket: RallarServerAiWebSocketPort;
    readonly serverAi: RallarServerAi;
    readonly config: RallarServerAiWebSocketConfig;
    readonly authorize?: RallarAiAuthorize;
}

export function installRallarServerAiWebSocketTopic(
    input: InstallRallarServerAiWebSocketTopicInput
): () => boolean {
    input.websocket.defineTopic({
        topicId: input.config.requestTopicId,
        typeId: input.config.requestTypeId,
        fanout: input.config.requestFanout,
        maxPayloadBytes: input.config.maxPayloadBytes,
        validate: (value) => isRallarServerAiJsonRequest(value),
        authorize: async (message, context) => {
            try {
                await assertRallarAiAuthorized(input.authorize, {
                    actorId: context.senderId,
                    roomId: context.roomId,
                    action: 'generate',
                    source: 'server',
                    schemaId: message.payload.schemaId,
                    schemaVersion: message.payload.schemaVersion
                });
                return true;
            }
            catch {
                return false;
            }
        }
    });

    return input.websocket.on(
        {
            topicId: input.config.requestTopicId,
            typeId: input.config.requestTypeId
        },
        async (message, context) => {
            const result = await input.serverAi.generateJson(message.payload, {
                actorId: context.senderId,
                roomId: context.roomId
            });
            const target = toRallarServerAiPublicationTarget(
                input.config.resultScope,
                context.roomRef
            );
            const publication = toResultPublicationInput(
                result,
                input.config,
                target
            );
            await input.websocket.publish(
                toRallarServerAiResultMessage({
                    publication,
                    senderId: input.config.serverSenderId,
                    target
                }),
                input.config.resultFanout
            );
        }
    );
}

function toResultPublicationInput(
    result: RallarAiJsonResult<RallarAiJsonValue>,
    config: RallarServerAiWebSocketConfig,
    target: RallarServerAiResultPublicationTarget
): RallarServerAiResultPublicationInput<RallarAiJsonValue> {
    return target.scope === 'room'
        ? {
            result,
            scope: 'room',
            roomRef: target.groupRef,
            topicId: config.resultTopicId,
            typeId: config.resultTypeId,
            fanout: config.resultFanout
        }
        : {
            result,
            scope: target.scope,
            topicId: config.resultTopicId,
            typeId: config.resultTypeId,
            fanout: config.resultFanout
        };
}
