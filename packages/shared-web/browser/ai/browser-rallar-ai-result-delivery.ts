import {
    emitBrowserRallarAiResultDiagnostic,
    toBrowserRallarAiErrorMessage
} from '@shared-web/browser/ai/browser-rallar-ai-diagnostics.ts';
import type {
    CreateRallarBrowserAiOptions,
    RallarBrowserAiBroadcastInput,
    RallarBrowserAiBroadcastResult,
    RallarBrowserAiFacade,
    RallarBrowserAiPersistInput,
    RallarBrowserAiRallar,
    RallarBrowserAiTransport
} from '@shared-web/browser/rallar-ai.ts';
import { RallarAiError, type RallarAiJsonResult } from '@shared/rallar-ai/mod.ts';

const DEFAULT_AI_RESULT_TOPIC_ID = 'room.ai';
const DEFAULT_AI_RESULT_TYPE_ID = 'generated';
const DEFAULT_AI_RESULT_LANE_ID = 'rallar-ai';
const DEFAULT_AI_RESULT_STORE_NAME = 'rallar-ai-results';

/** Owns delivery of generated envelopes to browser room transports. */
export function createBrowserRallarAiBroadcast(
    options: CreateRallarBrowserAiOptions
): RallarBrowserAiFacade['broadcastJson'] {
    return async <TValue>(
        input: RallarBrowserAiBroadcastInput<TValue>
    ): Promise<RallarBrowserAiBroadcastResult> => {
        const transport = input.transport ?? 'realtime';
        await emitBrowserRallarAiResultDiagnostic({
            sink: options.diagnostics,
            kind: 'envelope-broadcast-started',
            result: input.result
        });

        try {
            const result = await broadcastWithTransport(
                options.rallar,
                input,
                transport
            );
            await emitBrowserRallarAiResultDiagnostic({
                sink: options.diagnostics,
                kind: 'envelope-broadcast-completed',
                result: input.result
            });
            return result;
        }
        catch (error) {
            const broadcastError = error instanceof Error
                ? error
                : new Error(String(error));
            await emitBrowserRallarAiResultDiagnostic({
                sink: options.diagnostics,
                kind: 'envelope-broadcast-failed',
                result: input.result,
                failure: {
                    errorCode: broadcastError instanceof RallarAiError
                        ? broadcastError.code
                        : 'provider-failed',
                    message: toBrowserRallarAiErrorMessage(broadcastError)
                }
            });
            throw error;
        }
    };
}

/** Owns durable browser storage of generated envelopes. */
export function createBrowserRallarAiPersistence(
    options: CreateRallarBrowserAiOptions
): RallarBrowserAiFacade['persistJson'] {
    return async <TValue>(
        input: RallarBrowserAiPersistInput<TValue>
    ): Promise<void> => {
        await emitBrowserRallarAiResultDiagnostic({
            sink: options.diagnostics,
            kind: 'envelope-persistence-started',
            result: input.result
        });

        try {
            const store = await options.rallar.data.open<RallarAiJsonResult<TValue>>(
                input.storeName ?? DEFAULT_AI_RESULT_STORE_NAME,
                {
                    scope: input.scope ?? 'session',
                    durability: input.durability ?? 'write-behind'
                }
            );
            await store.set(
                input.key ?? input.result.generationId,
                input.result
            );
            await emitBrowserRallarAiResultDiagnostic({
                sink: options.diagnostics,
                kind: 'envelope-persistence-completed',
                result: input.result
            });
        }
        catch (error) {
            const persistenceError = error instanceof Error
                ? error
                : new Error(String(error));
            await emitBrowserRallarAiResultDiagnostic({
                sink: options.diagnostics,
                kind: 'envelope-persistence-failed',
                result: input.result,
                failure: {
                    errorCode: 'provider-failed',
                    message: toBrowserRallarAiErrorMessage(persistenceError)
                }
            });
            throw error;
        }
    };
}

async function broadcastWithTransport<TValue>(
    rallar: RallarBrowserAiRallar,
    input: RallarBrowserAiBroadcastInput<TValue>,
    transport: RallarBrowserAiTransport
): Promise<RallarBrowserAiBroadcastResult> {
    if (transport === 'realtime') {
        return {
            transport,
            realtime: await rallar.realtime.sendJson({
                data: input.result,
                laneId: input.laneId ?? DEFAULT_AI_RESULT_LANE_ID,
                roomId: input.roomId,
                roomRef: input.roomRef
            })
        };
    }

    const messageInput = {
        topicId: input.topicId ?? DEFAULT_AI_RESULT_TOPIC_ID,
        typeId: input.typeId ?? DEFAULT_AI_RESULT_TYPE_ID,
        payload: input.result,
        scope: 'room' as const,
        roomId: input.roomId,
        roomRef: input.roomRef
    };

    return {
        transport,
        message: transport === 'messages.ws'
            ? await rallar.messages.ws.send(messageInput)
            : await rallar.messages.rtc.send(messageInput)
    };
}
