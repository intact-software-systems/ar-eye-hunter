import { assertRallarAiAuthorized, type RallarAiJsonRequest } from '@shared/rallar-ai/mod.ts';
import {
    DEFAULT_AI_REQUEST_TOPIC_ID,
    DEFAULT_AI_REQUEST_TYPE_ID,
    DEFAULT_AI_RESULT_TOPIC_ID,
    DEFAULT_AI_RESULT_TYPE_ID,
    DEFAULT_SERVER_SENDER_ID
} from './rallar-ai-server-config.ts';
import { isRallarAiJsonRequest } from './rallar-ai-server-generation.ts';
import {
    normalizeBroadcastScope,
    requireCompleteGroupRef,
    toResultBroadcastMessage,
    type RallarServerAiBroadcastTarget
} from './rallar-ai-server-publication.ts';
import type {
    CreateRallarServerAiOptions,
    RallarServerAiFacade,
    RallarServerAiGenerationTopicOptions
} from './rallar-ai-server.ts';

interface CreateRallarServerAiTopicInstallerInput {
    readonly options: CreateRallarServerAiOptions;
    readonly generateJson: RallarServerAiFacade['generateJson'];
    readonly maxRequestBytes: number;
}

export function createRallarServerAiTopicInstaller(
    input: CreateRallarServerAiTopicInstallerInput
): RallarServerAiFacade['installGenerationTopic'] {
    return (topicOptions = {}) => installGenerationTopic(input, topicOptions);
}

function installGenerationTopic(
    input: CreateRallarServerAiTopicInstallerInput,
    topicOptions: RallarServerAiGenerationTopicOptions
): () => boolean {
    const requestTopicId = topicOptions.requestTopicId ?? DEFAULT_AI_REQUEST_TOPIC_ID;
    const requestTypeId = topicOptions.requestTypeId ?? DEFAULT_AI_REQUEST_TYPE_ID;
    input.options.rallar.ws.defineTopic<RallarAiJsonRequest>({
        topicId: requestTopicId,
        typeId: requestTypeId,
        fanout: topicOptions.requestFanout ?? 'none',
        maxPayloadBytes: topicOptions.maxPayloadBytes ?? input.maxRequestBytes,
        validate: (value) => isRallarAiJsonRequest(value),
        authorize: async (message, context) => {
            try {
                await assertRallarAiAuthorized(input.options.authorize, {
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

    return input.options.rallar.ws.on<RallarAiJsonRequest>(
        { topicId: requestTopicId, typeId: requestTypeId },
        async (message, context) => {
            const result = await input.generateJson(message.payload, {
                actorId: context.senderId,
                roomId: context.roomId
            });
            const scope = normalizeBroadcastScope(topicOptions.scope);
            const target: RallarServerAiBroadcastTarget = scope === 'room'
                ? { scope, groupRef: requireCompleteGroupRef(context.roomRef) }
                : { scope };
            await input.options.rallar.ws.publish(
                toResultBroadcastMessage(
                    {
                        result,
                        actorId: context.senderId,
                        ...(target.scope === 'room'
                            ? { scope: target.scope, roomRef: target.groupRef }
                            : { scope: target.scope }),
                        topicId: topicOptions.resultTopicId ?? DEFAULT_AI_RESULT_TOPIC_ID,
                        typeId: topicOptions.resultTypeId ?? DEFAULT_AI_RESULT_TYPE_ID,
                        fanout: topicOptions.resultFanout
                    },
                    input.options.serverSenderId ?? DEFAULT_SERVER_SENDER_ID,
                    target
                ),
                topicOptions.resultFanout
            );
        }
    );
}
