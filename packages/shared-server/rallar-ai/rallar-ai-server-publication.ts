import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    assertRallarAiAuthorized,
    createRallarAiDiagnosticEvent,
    emitRallarAiDiagnostic,
    RallarAiError,
    type RallarAiJsonResult,
    type RallarAiJsonValue
} from '@shared/rallar-ai/mod.ts';
import { RALLAR_AI_RESULT_APP_DATA_CODEC } from './rallar-ai-result-app-data-codec.ts';
import {
    DEFAULT_AI_RESULT_STORE_NAME,
    DEFAULT_AI_RESULT_TOPIC_ID,
    DEFAULT_AI_RESULT_TYPE_ID,
    DEFAULT_SERVER_SENDER_ID
} from './rallar-ai-server-config.ts';
import type {
    CreateRallarServerAiOptions,
    RallarServerAiBroadcastInput,
    RallarServerAiFacade,
    RallarServerAiPersistInput
} from './rallar-ai-server.ts';
import type { RallarServerAiBoundaryValue } from './rallar-server-ai-boundary-value.ts';

export type RallarServerAiBroadcastTarget =
    | Readonly<{ scope: 'room'; groupRef: GroupRef; }>
    | Readonly<{ scope: 'world' | 'all'; }>;

interface EmitPublicationDiagnosticInput<TValue extends RallarAiJsonValue> {
    readonly options: CreateRallarServerAiOptions;
    readonly result: RallarAiJsonResult<TValue>;
    readonly kind:
        | 'envelope-broadcast-started'
        | 'envelope-broadcast-completed'
        | 'envelope-broadcast-failed'
        | 'envelope-persistence-started'
        | 'envelope-persistence-completed'
        | 'envelope-persistence-failed';
    readonly error?: RallarServerAiBoundaryValue;
}

export function createRallarServerAiBroadcast(
    options: CreateRallarServerAiOptions
): RallarServerAiFacade['broadcastJson'] {
    return async <TValue extends RallarAiJsonValue = RallarAiJsonValue>(
        input: RallarServerAiBroadcastInput<TValue>
    ) => {
        const target = normalizeBroadcastTarget(input);
        await assertRallarAiAuthorized(options.authorize, {
            actorId: input.actorId,
            roomId: target.scope === 'room' ? target.groupRef.groupId : undefined,
            action: 'broadcast',
            source: 'server',
            schemaId: input.result.schemaId,
            schemaVersion: input.result.schemaVersion
        });
        await emitPublicationDiagnostic({
            options,
            result: input.result,
            kind: 'envelope-broadcast-started'
        });

        try {
            const message = toResultBroadcastMessage(
                input,
                options.serverSenderId ?? DEFAULT_SERVER_SENDER_ID,
                target
            );
            const result = await options.rallar.ws.publish(message, input.fanout);
            await emitPublicationDiagnostic({
                options,
                result: input.result,
                kind: 'envelope-broadcast-completed'
            });
            return result;
        }
        catch (error) {
            await emitPublicationDiagnostic({
                options,
                result: input.result,
                kind: 'envelope-broadcast-failed',
                error: error instanceof Error ? error : new Error(String(error))
            });
            throw error;
        }
    };
}

export function createRallarServerAiPersistence(
    options: CreateRallarServerAiOptions
): RallarServerAiFacade['persistJson'] {
    return async <TValue extends RallarAiJsonValue = RallarAiJsonValue>(
        input: RallarServerAiPersistInput<TValue>
    ): Promise<void> => {
        if (!options.rallar.appData) {
            throw new RallarAiError(
                'invalid-configuration',
                'RallarAI server persistence requires a Rallar data facade.'
            );
        }
        await assertRallarAiAuthorized(options.authorize, {
            actorId: input.actorId,
            roomId: input.roomId,
            action: 'persist',
            source: 'server',
            schemaId: input.result.schemaId,
            schemaVersion: input.result.schemaVersion
        });
        await emitPublicationDiagnostic({
            options,
            result: input.result,
            kind: 'envelope-persistence-started'
        });

        try {
            const store = await options.rallar.appData.open<RallarAiJsonResult<RallarAiJsonValue>>(
                input.storeName ?? DEFAULT_AI_RESULT_STORE_NAME,
                {
                    codec: RALLAR_AI_RESULT_APP_DATA_CODEC,
                    namespace: input.namespace ?? 'server',
                    ttlMs: input.ttlMs
                }
            );
            await store.set(input.key ?? input.result.generationId, input.result);
            await emitPublicationDiagnostic({
                options,
                result: input.result,
                kind: 'envelope-persistence-completed'
            });
        }
        catch (error) {
            await emitPublicationDiagnostic({
                options,
                result: input.result,
                kind: 'envelope-persistence-failed',
                error: error instanceof Error ? error : new Error(String(error))
            });
            throw error;
        }
    };
}

export function toResultBroadcastMessage<TValue extends RallarAiJsonValue>(
    input: RallarServerAiBroadcastInput<TValue>,
    senderId: string,
    target: RallarServerAiBroadcastTarget
): ALMessage {
    const contextId = target.scope === 'room' ? target.groupRef.groupId : target.scope;
    return newALBroadcastMessage(
        senderId,
        newALRoute(
            input.topicId ?? DEFAULT_AI_RESULT_TOPIC_ID,
            contextId,
            input.resourceId ?? input.result.generationId
        ),
        target.scope,
        input.typeId ?? DEFAULT_AI_RESULT_TYPE_ID,
        input.result,
        {
            groupRef: target.scope === 'room' ? target.groupRef : undefined,
            reliability: 'at-least-once',
            ack: 'receiver'
        }
    );
}

function normalizeBroadcastTarget<TValue extends RallarAiJsonValue>(
    input: RallarServerAiBroadcastInput<TValue>
): RallarServerAiBroadcastTarget {
    const scope = normalizeBroadcastScope(input.scope);
    if (scope !== 'room') {
        return { scope };
    }
    return { scope, groupRef: requireCompleteGroupRef(input.roomRef) };
}

export function normalizeBroadcastScope(
    value: RallarServerAiBoundaryValue
): RallarServerAiBroadcastTarget['scope'] {
    if (value === undefined) {
        return 'room';
    }
    if (value === 'room' || value === 'world' || value === 'all') {
        return value;
    }
    throw new RallarAiError(
        'invalid-json',
        'RallarAI broadcast scope must be room, world, or all.'
    );
}

export function requireCompleteGroupRef(value: RallarServerAiBoundaryValue): GroupRef {
    if (
        !isRecord(value) ||
        typeof value.applicationId !== 'string' || value.applicationId.length === 0 ||
        typeof value.workspaceId !== 'string' || value.workspaceId.length === 0 ||
        typeof value.groupId !== 'string' || value.groupId.length === 0
    ) {
        throw new RallarAiError(
            'invalid-json',
            'RallarAI room broadcast requires a complete GroupRef.'
        );
    }
    return {
        applicationId: value.applicationId,
        workspaceId: value.workspaceId,
        groupId: value.groupId
    };
}

async function emitPublicationDiagnostic<TValue extends RallarAiJsonValue>(
    input: EmitPublicationDiagnosticInput<TValue>
): Promise<void> {
    const { options, result, kind, error } = input;
    await emitRallarAiDiagnostic(
        options.diagnostics,
        createRallarAiDiagnosticEvent(kind, {
            generationId: result.generationId,
            requestId: result.requestId,
            providerId: result.providerId,
            modelId: result.modelId,
            schemaId: result.schemaId,
            schemaVersion: result.schemaVersion,
            schemaHash: result.schemaHash,
            source: result.source,
            validationOk: result.validation.ok,
            errorCode: error === undefined
                ? undefined
                : error instanceof RallarAiError
                ? error.code
                : 'provider-failed',
            message: error === undefined
                ? undefined
                : error instanceof Error
                ? error.message
                : String(error)
        })
    );
}

function isRecord(
    value: RallarServerAiBoundaryValue
): value is Record<string, RallarServerAiBoundaryValue> {
    return value !== null && typeof value === 'object';
}
