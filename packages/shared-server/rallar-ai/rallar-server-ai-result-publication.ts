import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
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
import type {
    RallarServerWsFanout,
    RallarServerWsPublishResult
} from '../rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';

const DEFAULT_RALLAR_SERVER_AI_RESULT_TOPIC_ID = 'room.ai.generated';
const DEFAULT_RALLAR_SERVER_AI_RESULT_TYPE_ID = 'rallar.ai.generate-json.result.v1';

interface RallarServerAiResultPublicationBase<TValue extends RallarAiJsonValue> {
    readonly result: RallarAiJsonResult<TValue>;
    readonly actorId?: string;
    readonly topicId?: string;
    readonly typeId?: string;
    readonly resourceId?: string;
    readonly fanout?: RallarServerWsFanout;
}

export type RallarServerAiResultPublicationInput<TValue extends RallarAiJsonValue> =
    & RallarServerAiResultPublicationBase<TValue>
    & (
        | Readonly<{ scope?: 'room'; roomRef: GroupRef; }>
        | Readonly<{ scope: 'world' | 'all'; roomRef?: never; }>
    );

export type RallarServerAiResultPublicationTarget =
    | Readonly<{ scope: 'room'; groupRef: GroupRef; }>
    | Readonly<{ scope: 'world' | 'all'; }>;

export interface RallarServerAiResultPublicationPort {
    publish(
        message: ALMessage,
        fanout?: RallarServerWsFanout
    ): Promise<RallarServerWsPublishResult>;
}

export interface CreateRallarServerAiResultPublisherInput {
    readonly publication: RallarServerAiResultPublicationPort;
    readonly serverSenderId: string;
    readonly authorize?: RallarAiAuthorize;
    readonly diagnostics?: RallarAiDiagnosticsSink;
}

export type RallarServerAiResultPublisher = <TValue extends RallarAiJsonValue>(
    input: RallarServerAiResultPublicationInput<TValue>
) => Promise<RallarServerWsPublishResult>;

interface ReportRallarServerAiPublicationInput<TValue extends RallarAiJsonValue> {
    readonly publisher: CreateRallarServerAiResultPublisherInput;
    readonly result: RallarAiJsonResult<TValue>;
    readonly kind:
        | 'envelope-broadcast-started'
        | 'envelope-broadcast-completed'
        | 'envelope-broadcast-failed';
    readonly error?: Error;
}

export function createRallarServerAiResultPublisher(
    publisher: CreateRallarServerAiResultPublisherInput
): RallarServerAiResultPublisher {
    return async <TValue extends RallarAiJsonValue>(
        input: RallarServerAiResultPublicationInput<TValue>
    ): Promise<RallarServerWsPublishResult> => {
        const target = toRallarServerAiPublicationTarget(input.scope, input.roomRef);
        await assertRallarAiAuthorized(publisher.authorize, {
            actorId: input.actorId,
            roomId: target.scope === 'room' ? target.groupRef.groupId : undefined,
            action: 'broadcast',
            source: 'server',
            schemaId: input.result.schemaId,
            schemaVersion: input.result.schemaVersion
        });
        await reportRallarServerAiPublication({
            publisher,
            result: input.result,
            kind: 'envelope-broadcast-started'
        });

        try {
            const message = toRallarServerAiResultMessage({
                publication: input,
                senderId: publisher.serverSenderId,
                target
            });
            const result = await publisher.publication.publish(message, input.fanout);
            await reportRallarServerAiPublication({
                publisher,
                result: input.result,
                kind: 'envelope-broadcast-completed'
            });
            return result;
        }
        catch (error) {
            const cause = error instanceof Error ? error : new Error(String(error));
            await reportRallarServerAiPublication({
                publisher,
                result: input.result,
                kind: 'envelope-broadcast-failed',
                error: cause
            });
            throw cause;
        }
    };
}

interface ToRallarServerAiResultMessageInput<TValue extends RallarAiJsonValue> {
    readonly publication: RallarServerAiResultPublicationInput<TValue>;
    readonly senderId: string;
    readonly target: RallarServerAiResultPublicationTarget;
}

export function toRallarServerAiResultMessage<TValue extends RallarAiJsonValue>(
    input: ToRallarServerAiResultMessageInput<TValue>
): ALMessage {
    const contextId = input.target.scope === 'room'
        ? input.target.groupRef.groupId
        : input.target.scope;
    return newALBroadcastMessage(
        input.senderId,
        newALRoute(
            input.publication.topicId ?? DEFAULT_RALLAR_SERVER_AI_RESULT_TOPIC_ID,
            contextId,
            input.publication.resourceId ?? input.publication.result.generationId
        ),
        input.target.scope,
        input.publication.typeId ?? DEFAULT_RALLAR_SERVER_AI_RESULT_TYPE_ID,
        input.publication.result,
        {
            groupRef: input.target.scope === 'room' ? input.target.groupRef : undefined,
            reliability: 'at-least-once',
            ack: 'receiver'
        }
    );
}

function requireRallarServerAiGroupRef(value: GroupRef | undefined): GroupRef {
    if (
        value === undefined ||
        typeof value.applicationId !== 'string' || value.applicationId.length === 0 ||
        typeof value.workspaceId !== 'string' || value.workspaceId.length === 0 ||
        typeof value.groupId !== 'string' || value.groupId.length === 0
    ) {
        throw new RallarAiError(
            'invalid-json',
            'RallarAI room publication requires a complete GroupRef.'
        );
    }
    return {
        applicationId: value.applicationId,
        workspaceId: value.workspaceId,
        groupId: value.groupId
    };
}

export function toRallarServerAiPublicationTarget(
    scope: RallarServerAiResultPublicationTarget['scope'] | undefined,
    roomRef: GroupRef | undefined
): RallarServerAiResultPublicationTarget {
    const currentScope = scope ?? 'room';
    return currentScope === 'room'
        ? { scope: currentScope, groupRef: requireRallarServerAiGroupRef(roomRef) }
        : { scope: currentScope };
}

async function reportRallarServerAiPublication<TValue extends RallarAiJsonValue>(
    input: ReportRallarServerAiPublicationInput<TValue>
): Promise<void> {
    await emitRallarAiDiagnostic(
        input.publisher.diagnostics,
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
