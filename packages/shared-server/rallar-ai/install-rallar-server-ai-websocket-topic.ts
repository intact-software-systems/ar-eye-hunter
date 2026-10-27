import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALReplyMessage } from '@shared/al-contracts/reply/new-al-reply-message.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { assertRallarAiAuthorized, type RallarAiAuthorize } from '@shared/rallar-ai/mod.ts';
import type { JsonWireValue } from '../rallar-system/protocol/json-wire-identity.ts';
import type {
    RallarServerWsFanout,
    RallarServerWsPublishInputDto,
    RallarServerWsPublishResult,
    RallarServerWsTopicScope
} from '../rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { isRallarServerAiJsonRequest, type RallarServerAiJsonRequest } from './decode-rallar-server-ai-json-request.ts';
import type { RallarServerAi } from './rallar-server-ai-contracts.ts';

export interface RallarServerAiWebSocketPort {
    defineTopic(definition: RallarServerAiWebSocketTopicDefinition): void;
    on(
        selector: RallarServerAiWebSocketSelector,
        handler: RallarServerAiWebSocketHandler
    ): () => boolean;
    publish(
        input: RallarServerWsPublishInputDto
    ): Promise<RallarServerWsPublishResult>;
}

export interface RallarServerAiWebSocketSelector {
    readonly topicId: string;
    readonly typeId: string;
}

export interface RallarServerAiWebSocketMessage {
    readonly payload: RallarServerAiJsonRequest;
    readonly raw: ALMessage;
}

export interface RallarServerAiWebSocketMessageContext {
    readonly senderId: string;
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
    readonly authenticatedScope: StateScope | undefined;
}

export type RallarServerAiWebSocketHandler = (
    message: RallarServerAiWebSocketMessage,
    context: RallarServerAiWebSocketMessageContext
) => void | Promise<void>;

export interface RallarServerAiWebSocketTopicDefinition {
    readonly topicId: string;
    readonly typeId: string;
    readonly scope: RallarServerWsTopicScope;
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
    readonly requestScope: RallarServerWsTopicScope;
    readonly requestFanout: RallarServerWsFanout;
    /** The reply is a unicast to the asking session under the request's correlation. */
    readonly replyTypeId: string;
    readonly replyFanout: RallarServerWsFanout;
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
        scope: input.config.requestScope,
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
            const reply = newALReplyMessage(message.raw, {
                senderId: input.config.serverSenderId,
                typeId: input.config.replyTypeId,
                payload: result
            });
            // A reply in the request's room is scoped by its groupRef; any other unicast reaches the asker's proven scope.
            const scope = readALTargetGroupRef(message.raw) === undefined ? context.authenticatedScope : undefined;
            await input.websocket.publish({ message: reply, fanout: input.config.replyFanout, scope });
        }
    );
}
