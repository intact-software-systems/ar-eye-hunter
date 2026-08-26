import {
    assertRallarAiAuthorized,
    createRallarAiDiagnosticEvent,
    emitRallarAiDiagnostic,
    RallarAiError,
    type RallarAiAuthorize,
    type RallarAiDiagnosticsSink,
    type RallarAiJsonResult,
    type RallarAiJsonValue
} from '@shared/rallar-ai/mod.ts';
import type { AppDataValueCodec } from '../app-data/app-data-value-codec.ts';
import { RALLAR_SERVER_AI_RESULT_APP_DATA_CODEC } from './rallar-server-ai-result-app-data-codec.ts';

export interface RallarServerAiResultStore {
    set(
        key: string,
        value: RallarAiJsonResult<RallarAiJsonValue>
    ): Promise<void>;
}

export interface RallarServerAiResultStorePort {
    open(
        storeName: string,
        options: Readonly<{
            codec: AppDataValueCodec<RallarAiJsonResult<RallarAiJsonValue>>;
            namespace: string;
            ttlMs?: number;
        }>
    ): Promise<RallarServerAiResultStore>;
}

export interface CreateRallarServerAiResultPersistenceInput {
    readonly stores: RallarServerAiResultStorePort;
    readonly defaultStoreName: string;
    readonly defaultNamespace: string;
    readonly authorize?: RallarAiAuthorize;
    readonly diagnostics?: RallarAiDiagnosticsSink;
}

export interface RallarServerAiResultPersistenceInput<TValue extends RallarAiJsonValue> {
    readonly result: RallarAiJsonResult<TValue>;
    readonly actorId?: string;
    readonly roomId?: string;
    readonly storeName?: string;
    readonly key?: string;
    readonly namespace?: string;
    readonly ttlMs?: number;
}

export type RallarServerAiResultPersistence = <TValue extends RallarAiJsonValue>(
    input: RallarServerAiResultPersistenceInput<TValue>
) => Promise<void>;

interface ReportRallarServerAiPersistenceInput<TValue extends RallarAiJsonValue> {
    readonly persistence: CreateRallarServerAiResultPersistenceInput;
    readonly result: RallarAiJsonResult<TValue>;
    readonly kind:
        | 'envelope-persistence-started'
        | 'envelope-persistence-completed'
        | 'envelope-persistence-failed';
    readonly error?: Error;
}

export function createRallarServerAiResultPersistence(
    persistence: CreateRallarServerAiResultPersistenceInput
): RallarServerAiResultPersistence {
    return async <TValue extends RallarAiJsonValue>(
        input: RallarServerAiResultPersistenceInput<TValue>
    ): Promise<void> => {
        await assertRallarAiAuthorized(persistence.authorize, {
            actorId: input.actorId,
            roomId: input.roomId,
            action: 'persist',
            source: 'server',
            schemaId: input.result.schemaId,
            schemaVersion: input.result.schemaVersion
        });
        await reportRallarServerAiPersistence({
            persistence,
            result: input.result,
            kind: 'envelope-persistence-started'
        });

        try {
            const store = await persistence.stores.open(
                input.storeName ?? persistence.defaultStoreName,
                {
                    codec: RALLAR_SERVER_AI_RESULT_APP_DATA_CODEC,
                    namespace: input.namespace ?? persistence.defaultNamespace,
                    ttlMs: input.ttlMs
                }
            );
            await store.set(input.key ?? input.result.generationId, input.result);
            await reportRallarServerAiPersistence({
                persistence,
                result: input.result,
                kind: 'envelope-persistence-completed'
            });
        }
        catch (error) {
            const cause = error instanceof Error ? error : new Error(String(error));
            await reportRallarServerAiPersistence({
                persistence,
                result: input.result,
                kind: 'envelope-persistence-failed',
                error: cause
            });
            throw cause;
        }
    };
}

async function reportRallarServerAiPersistence<TValue extends RallarAiJsonValue>(
    input: ReportRallarServerAiPersistenceInput<TValue>
): Promise<void> {
    await emitRallarAiDiagnostic(
        input.persistence.diagnostics,
        createRallarAiDiagnosticEvent(input.kind, {
            generationId: input.result.generationId,
            requestId: input.result.requestId,
            providerId: input.result.providerId,
            modelId: input.result.modelId,
            schemaId: input.result.schemaId,
            schemaVersion: input.result.schemaVersion,
            schemaHash: input.result.schemaHash,
            source: input.result.source,
            validationOk: input.result.validation.ok,
            errorCode: input.error === undefined
                ? undefined
                : input.error instanceof RallarAiError
                ? input.error.code
                : 'provider-failed',
            message: input.error?.message
        })
    );
}
