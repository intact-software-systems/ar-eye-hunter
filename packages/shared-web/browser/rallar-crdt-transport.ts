import {
    RALLAR_CRDT_APPEND_RESPONSE_TYPE_ID,
    RALLAR_CRDT_APP_TOPIC_ID,
    RALLAR_CRDT_CATCH_UP_REQUEST_TYPE_ID,
    RALLAR_CRDT_CATCH_UP_RESPONSE_TYPE_ID,
    RALLAR_CRDT_ROOM_TOPIC_ID,
    RALLAR_CRDT_SYNC_REQUEST_TYPE_ID,
    RALLAR_CRDT_SYNC_RESPONSE_TYPE_ID,
    RALLAR_CRDT_UPDATE_TYPE_ID,
    evaluateRallarCrdtFeaturePolicy,
    type RallarCrdtAppendResponseEnvelope,
    type RallarCrdtCatchUpRequestEnvelope,
    type RallarCrdtCatchUpResponseEnvelope,
    type RallarCrdtDocumentRef,
    type RallarCrdtDocumentTypePolicy,
    type RallarCrdtOperationBatch,
    type RallarCrdtSyncRequestEnvelope,
    type RallarCrdtSyncResponseEnvelope,
    type RallarCrdtTransportStrategy,
    type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-data.ts';

export type RallarCrdtTransportKind = 'ws' | 'rtc';

export type RallarCrdtTransportSendInput<TPayload> = Readonly<{
    topicId: string;
    typeId: string;
    payload: TPayload;
    contextId?: string;
    resourceId?: string;
    scope?: 'room' | 'world' | 'all';
    roomId?: string;
    roomRef?: RallarCrdtDocumentRef['roomRef'];
}>;

export type RallarCrdtTransportMessage<TPayload> = Readonly<{
    payload: TPayload;
    topicId?: string;
    typeId?: string;
    transport?: RallarCrdtTransportKind;
}>;

export type RallarCrdtTransportSendResult = Readonly<{
    transport: RallarCrdtTransportKind;
    status: string;
    reason?: string;
}>;

export type RallarCrdtTransportLane = Readonly<{
    send<TPayload>(
        input: RallarCrdtTransportSendInput<TPayload>,
    ): Promise<RallarCrdtTransportSendResult>;
    onMessage<TPayload>(
        selector: Readonly<{ topicId?: string; typeId?: string }>,
        handler: (
            message: RallarCrdtTransportMessage<TPayload>,
        ) => void | Promise<void>,
    ): RallarUnsubscribe;
}>;

export type RallarCrdtMessageTransport = Readonly<{
    ws?: RallarCrdtTransportLane;
    rtc?: RallarCrdtTransportLane;
}>;

export type RallarCrdtLiveSendOutcome = Readonly<{
    attempted: readonly RallarCrdtTransportKind[];
    results: readonly RallarCrdtTransportSendResult[];
    sentCount: number;
    failedCount: number;
    status: 'sent' | 'deferred' | 'failed';
    reason?: string;
}>;

export function subscribeRallarCrdtLiveTransport<
    TPayload extends RallarCrdtOperationBatch,
>(
    options: Readonly<{
        ref: RallarCrdtDocumentRef;
        transport: RallarCrdtMessageTransport | undefined;
        strategy: RallarCrdtTransportStrategy;
        onUpdate(
            update: RallarCrdtUpdateEnvelope<TPayload>,
            transport: RallarCrdtTransportKind,
        ): void | Promise<void>;
        onSyncRequest?(
            request: RallarCrdtSyncRequestEnvelope,
            transport: RallarCrdtTransportKind,
        ): void | Promise<void>;
        onSyncResponse?(
            response: RallarCrdtSyncResponseEnvelope<unknown, TPayload>,
            transport: RallarCrdtTransportKind,
        ): void | Promise<void>;
        onAppendResponse?(
            response: RallarCrdtAppendResponseEnvelope<TPayload>,
            transport: RallarCrdtTransportKind,
        ): void | Promise<void>;
        onCatchUpResponse?(
            response: RallarCrdtCatchUpResponseEnvelope<unknown, TPayload>,
            transport: Extract<RallarCrdtTransportKind, 'ws'>,
        ): void | Promise<void>;
        policies?: readonly RallarCrdtDocumentTypePolicy[];
    }>,
): readonly RallarUnsubscribe[] {
    const topicId = toRallarCrdtLiveTopicId(options.ref);
    const unsubscribes: RallarUnsubscribe[] = [];

    if (
        usesWs(options.strategy) &&
        options.transport?.ws &&
        isTransportAllowed(options.ref, 'ws', options.policies)
    ) {
        unsubscribes.push(
            options.transport.ws.onMessage<RallarCrdtUpdateEnvelope<TPayload>>(
                {
                    topicId,
                    typeId: RALLAR_CRDT_UPDATE_TYPE_ID,
                },
                async (message) => {
                    await options.onUpdate(message.payload, 'ws');
                },
            ),
        );
        if (options.onSyncRequest) {
            unsubscribes.push(
                options.transport.ws.onMessage<RallarCrdtSyncRequestEnvelope>(
                    {
                        topicId,
                        typeId: RALLAR_CRDT_SYNC_REQUEST_TYPE_ID,
                    },
                    async (message) => {
                        await options.onSyncRequest?.(message.payload, 'ws');
                    },
                ),
            );
        }
        if (options.onSyncResponse) {
            unsubscribes.push(
                options.transport.ws.onMessage<
                    RallarCrdtSyncResponseEnvelope<unknown, TPayload>
                >(
                    {
                        topicId,
                        typeId: RALLAR_CRDT_SYNC_RESPONSE_TYPE_ID,
                    },
                    async (message) => {
                        await options.onSyncResponse?.(message.payload, 'ws');
                    },
                ),
            );
        }
        if (options.onAppendResponse) {
            unsubscribes.push(
                options.transport.ws.onMessage<
                    RallarCrdtAppendResponseEnvelope<TPayload>
                >(
                    {
                        topicId,
                        typeId: RALLAR_CRDT_APPEND_RESPONSE_TYPE_ID,
                    },
                    async (message) => {
                        await options.onAppendResponse?.(message.payload, 'ws');
                    },
                ),
            );
        }
        if (options.onCatchUpResponse) {
            unsubscribes.push(
                options.transport.ws.onMessage<
                    RallarCrdtCatchUpResponseEnvelope<unknown, TPayload>
                >(
                    {
                        topicId,
                        typeId: RALLAR_CRDT_CATCH_UP_RESPONSE_TYPE_ID,
                    },
                    async (message) => {
                        await options.onCatchUpResponse?.(
                            message.payload,
                            'ws',
                        );
                    },
                ),
            );
        }
    }

    if (
        usesRtc(options.strategy) &&
        options.transport?.rtc &&
        isTransportAllowed(options.ref, 'rtc', options.policies)
    ) {
        unsubscribes.push(
            options.transport.rtc.onMessage<RallarCrdtUpdateEnvelope<TPayload>>(
                {
                    topicId,
                    typeId: RALLAR_CRDT_UPDATE_TYPE_ID,
                },
                async (message) => {
                    await options.onUpdate(message.payload, 'rtc');
                },
            ),
        );
        if (options.onSyncRequest) {
            unsubscribes.push(
                options.transport.rtc.onMessage<RallarCrdtSyncRequestEnvelope>(
                    {
                        topicId,
                        typeId: RALLAR_CRDT_SYNC_REQUEST_TYPE_ID,
                    },
                    async (message) => {
                        await options.onSyncRequest?.(message.payload, 'rtc');
                    },
                ),
            );
        }
        if (options.onSyncResponse) {
            unsubscribes.push(
                options.transport.rtc.onMessage<
                    RallarCrdtSyncResponseEnvelope<unknown, TPayload>
                >(
                    {
                        topicId,
                        typeId: RALLAR_CRDT_SYNC_RESPONSE_TYPE_ID,
                    },
                    async (message) => {
                        await options.onSyncResponse?.(message.payload, 'rtc');
                    },
                ),
            );
        }
        if (options.onAppendResponse) {
            unsubscribes.push(
                options.transport.rtc.onMessage<
                    RallarCrdtAppendResponseEnvelope<TPayload>
                >(
                    {
                        topicId,
                        typeId: RALLAR_CRDT_APPEND_RESPONSE_TYPE_ID,
                    },
                    async (message) => {
                        await options.onAppendResponse?.(
                            message.payload,
                            'rtc',
                        );
                    },
                ),
            );
        }
    }

    return unsubscribes;
}

export async function sendRallarCrdtLiveUpdate<
    TPayload extends RallarCrdtOperationBatch,
>(
    options: Readonly<{
        update: RallarCrdtUpdateEnvelope<TPayload>;
        transport: RallarCrdtMessageTransport | undefined;
        strategy: RallarCrdtTransportStrategy;
        policies?: readonly RallarCrdtDocumentTypePolicy[];
    }>,
): Promise<RallarCrdtLiveSendOutcome> {
    if (options.strategy === 'local-only') {
        return {
            attempted: [],
            results: [],
            sentCount: 0,
            failedCount: 0,
            status: 'deferred',
            reason: 'Document is opened in local-only mode.',
        };
    }

    if (!isLiveTransportScope(options.update.document)) {
        return {
            attempted: [],
            results: [],
            sentCount: 0,
            failedCount: 0,
            status: 'deferred',
            reason: 'Live CRDT transport supports room documents and WS app/principal documents.',
        };
    }

    if (!options.transport) {
        return {
            attempted: [],
            results: [],
            sentCount: 0,
            failedCount: 0,
            status: 'deferred',
            reason: 'No CRDT live transport is configured.',
        };
    }

    switch (options.strategy) {
        case 'ws':
            return await sendThroughOrderedTransports(options, ['ws']);
        case 'rtc':
            return await sendThroughOrderedTransports(options, ['rtc']);
        case 'ws-then-rtc':
            return await sendThroughOrderedTransports(options, ['ws', 'rtc'], {
                continueAfterSuccess: true,
            });
        case 'rtc-with-ws-fallback':
            return await sendThroughOrderedTransports(options, ['rtc', 'ws']);
    }
}

export async function sendRallarCrdtSyncRequest(
    options: Readonly<{
        request: RallarCrdtSyncRequestEnvelope;
        transport: RallarCrdtMessageTransport | undefined;
        strategy: RallarCrdtTransportStrategy;
        policies?: readonly RallarCrdtDocumentTypePolicy[];
    }>,
): Promise<RallarCrdtLiveSendOutcome> {
    return await sendRallarCrdtControlEnvelope({
        envelope: options.request,
        document: options.request.document,
        transport: options.transport,
        strategy: options.strategy,
        typeId: RALLAR_CRDT_SYNC_REQUEST_TYPE_ID,
        resourceId: options.request.requestId,
        policies: options.policies,
    });
}

export async function sendRallarCrdtCatchUpRequest(
    options: Readonly<{
        request: RallarCrdtCatchUpRequestEnvelope;
        transport: RallarCrdtMessageTransport | undefined;
        policies?: readonly RallarCrdtDocumentTypePolicy[];
    }>,
): Promise<RallarCrdtLiveSendOutcome> {
    if (!options.transport?.ws) {
        return {
            attempted: ['ws'],
            results: [
                {
                    transport: 'ws',
                    status: 'missing-transport',
                    reason: 'WS CRDT transport is not configured.',
                },
            ],
            sentCount: 0,
            failedCount: 1,
            status: 'failed',
            reason: 'WS CRDT transport is not configured.',
        };
    }

    if (!isLiveTransportScope(options.request.document)) {
        return {
            attempted: ['ws'],
            results: [],
            sentCount: 0,
            failedCount: 0,
            status: 'deferred',
            reason: 'CRDT durable catch-up supports room, app, and principal documents over WS.',
        };
    }

    const policy = evaluateRallarCrdtFeaturePolicy({
        document: options.request.document,
        operation: 'durable-catch-up',
        policies: options.policies,
    });
    if (!policy.allowed) {
        return {
            attempted: ['ws'],
            results: [
                {
                    transport: 'ws',
                    status: policy.code,
                    reason: policy.reason,
                },
            ],
            sentCount: 0,
            failedCount: 1,
            status: 'failed',
            reason: policy.reason,
        };
    }

    const result = await options.transport.ws.send({
        topicId: toRallarCrdtLiveTopicId(options.request.document),
        typeId: RALLAR_CRDT_CATCH_UP_REQUEST_TYPE_ID,
        payload: options.request,
        contextId: toRallarCrdtContextId(options.request.document),
        resourceId: options.request.requestId,
        roomId: options.request.document.roomRef?.groupId,
        roomRef: options.request.document.roomRef,
        scope: options.request.document.roomRef ? 'room' : undefined,
    });
    const sent = isSuccessfulRallarCrdtTransportStatus(result.status);
    return {
        attempted: ['ws'],
        results: [
            {
                ...result,
                transport: 'ws',
            },
        ],
        sentCount: sent ? 1 : 0,
        failedCount: sent ? 0 : 1,
        status: sent ? 'sent' : 'failed',
        reason: result.reason,
    };
}

export async function sendRallarCrdtSyncResponse<
    TPayload extends RallarCrdtOperationBatch,
>(
    options: Readonly<{
        response: RallarCrdtSyncResponseEnvelope<unknown, TPayload>;
        transport: RallarCrdtMessageTransport | undefined;
        replyTransport: RallarCrdtTransportKind;
        policies?: readonly RallarCrdtDocumentTypePolicy[];
    }>,
): Promise<RallarCrdtLiveSendOutcome> {
    return await sendRallarCrdtControlEnvelope({
        envelope: options.response,
        document: options.response.document,
        transport: options.transport,
        strategy: options.replyTransport,
        typeId: RALLAR_CRDT_SYNC_RESPONSE_TYPE_ID,
        resourceId: options.response.responseId,
        policies: options.policies,
    });
}

export function toRallarCrdtLiveTopicId(ref: RallarCrdtDocumentRef): string {
    return ref.scope === 'app' || ref.scope === 'principal'
        ? RALLAR_CRDT_APP_TOPIC_ID
        : RALLAR_CRDT_ROOM_TOPIC_ID;
}

export function isSuccessfulRallarCrdtTransportStatus(status: string): boolean {
    return (
        status === 'sent' ||
        status === 'ok' ||
        status === 'enqueued' ||
        status === 'sent-immediate' ||
        status === 'duplicate' ||
        status === 'superseded' ||
        status === 'skipped'
    );
}

function usesWs(strategy: RallarCrdtTransportStrategy): boolean {
    return (
        strategy === 'ws' ||
        strategy === 'ws-then-rtc' ||
        strategy === 'rtc-with-ws-fallback'
    );
}

function usesRtc(strategy: RallarCrdtTransportStrategy): boolean {
    return (
        strategy === 'rtc' ||
        strategy === 'ws-then-rtc' ||
        strategy === 'rtc-with-ws-fallback'
    );
}

async function sendThroughOrderedTransports<
    TPayload extends RallarCrdtOperationBatch,
>(
    options: Readonly<{
        update: RallarCrdtUpdateEnvelope<TPayload>;
        transport: RallarCrdtMessageTransport | undefined;
        strategy: RallarCrdtTransportStrategy;
        policies?: readonly RallarCrdtDocumentTypePolicy[];
    }>,
    order: readonly RallarCrdtTransportKind[],
    behavior: Readonly<{ continueAfterSuccess?: boolean }> = {},
): Promise<RallarCrdtLiveSendOutcome> {
    const results: RallarCrdtTransportSendResult[] = [];
    const attempted: RallarCrdtTransportKind[] = [];

    for (const transportKind of order) {
        const lane = options.transport?.[transportKind];
        attempted.push(transportKind);
        const decision = evaluateTransportDecision(
            options.update.document,
            transportKind,
            options.policies,
        );
        if (!decision.allowed) {
            results.push({
                transport: transportKind,
                status: decision.code,
                reason: decision.reason,
            });
            continue;
        }
        if (!lane) {
            results.push({
                transport: transportKind,
                status: 'missing-transport',
                reason: `${transportKind.toUpperCase()} CRDT transport is not configured.`,
            });
            continue;
        }

        try {
            const result = await lane.send(
                toRallarCrdtTransportSendInput(options.update, transportKind),
            );
            results.push({
                ...result,
                transport: transportKind,
            });
            if (
                isSuccessfulRallarCrdtTransportStatus(result.status) &&
                !behavior.continueAfterSuccess
            ) {
                break;
            }
        } catch (error) {
            results.push({
                transport: transportKind,
                status: 'failed',
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }

    const sentCount = results.filter((result) =>
        isSuccessfulRallarCrdtTransportStatus(result.status),
    ).length;
    const failedCount = results.length - sentCount;

    return {
        attempted,
        results,
        sentCount,
        failedCount,
        status:
            sentCount > 0 ? 'sent' : failedCount > 0 ? 'failed' : 'deferred',
        reason: results.find((result) => result.reason)?.reason,
    };
}

function toRallarCrdtTransportSendInput<
    TPayload extends RallarCrdtOperationBatch,
>(
    update: RallarCrdtUpdateEnvelope<TPayload>,
    transport: RallarCrdtTransportKind,
): RallarCrdtTransportSendInput<RallarCrdtUpdateEnvelope<TPayload>> {
    const topicId = toRallarCrdtLiveTopicId(update.document);
    const roomId = update.document.roomRef?.groupId;
    const roomRef = update.document.roomRef;

    return {
        topicId,
        typeId: RALLAR_CRDT_UPDATE_TYPE_ID,
        payload: update,
        contextId: toRallarCrdtContextId(update.document),
        resourceId: update.updateId,
        roomId,
        roomRef,
        scope: transport === 'ws' && roomRef ? 'room' : undefined,
    };
}

async function sendRallarCrdtControlEnvelope<TEnvelope>(
    options: Readonly<{
        envelope: TEnvelope;
        document: RallarCrdtDocumentRef;
        transport: RallarCrdtMessageTransport | undefined;
        strategy: RallarCrdtTransportStrategy | RallarCrdtTransportKind;
        typeId: string;
        resourceId: string;
        policies?: readonly RallarCrdtDocumentTypePolicy[];
    }>,
): Promise<RallarCrdtLiveSendOutcome> {
    if (!options.transport) {
        return {
            attempted: [],
            results: [],
            sentCount: 0,
            failedCount: 0,
            status: 'deferred',
            reason: 'No CRDT live transport is configured.',
        };
    }

    if (!isLiveTransportScope(options.document)) {
        return {
            attempted: [],
            results: [],
            sentCount: 0,
            failedCount: 0,
            status: 'deferred',
            reason: 'Live CRDT sync supports room documents and WS app/principal documents.',
        };
    }

    const order = toTransportOrder(options.strategy);
    const results: RallarCrdtTransportSendResult[] = [];

    for (const transportKind of order) {
        const lane = options.transport[transportKind];
        const decision = evaluateTransportDecision(
            options.document,
            transportKind,
            options.policies,
        );
        if (!decision.allowed) {
            results.push({
                transport: transportKind,
                status: decision.code,
                reason: decision.reason,
            });
            continue;
        }
        if (!lane) {
            results.push({
                transport: transportKind,
                status: 'missing-transport',
            });
            continue;
        }

        const result = await lane.send({
            topicId: toRallarCrdtLiveTopicId(options.document),
            typeId: options.typeId,
            payload: options.envelope,
            contextId: toRallarCrdtContextId(options.document),
            resourceId: options.resourceId,
            roomId: options.document.roomRef?.groupId,
            roomRef: options.document.roomRef,
            scope:
                transportKind === 'ws' && options.document.roomRef
                    ? 'room'
                    : undefined,
        });
        results.push({
            ...result,
            transport: transportKind,
        });
        if (
            isSuccessfulRallarCrdtTransportStatus(result.status) &&
            options.strategy !== 'ws-then-rtc'
        ) {
            break;
        }
    }

    const sentCount = results.filter((result) =>
        isSuccessfulRallarCrdtTransportStatus(result.status),
    ).length;

    return {
        attempted: order,
        results,
        sentCount,
        failedCount: results.length - sentCount,
        status:
            sentCount > 0 ? 'sent' : results.length > 0 ? 'failed' : 'deferred',
        reason: results.find((result) => result.reason)?.reason,
    };
}

function isTransportAllowed(
    document: RallarCrdtDocumentRef,
    transport: RallarCrdtTransportKind,
    policies: readonly RallarCrdtDocumentTypePolicy[] | undefined,
): boolean {
    return evaluateTransportDecision(document, transport, policies).allowed;
}

function evaluateTransportDecision(
    document: RallarCrdtDocumentRef,
    transport: RallarCrdtTransportKind,
    policies: readonly RallarCrdtDocumentTypePolicy[] | undefined,
) {
    if (transport === 'rtc' && document.scope !== 'room') {
        return {
            allowed: false,
            code: 'rtc-scope-unsupported',
            reason:
                'RTC CRDT transport is room-scoped; use WS for app or principal documents.',
            rollout: 'production' as const,
            retryable: false,
        };
    }
    return evaluateRallarCrdtFeaturePolicy({
        document,
        operation: transport === 'ws' ? 'ws-send' : 'rtc-send',
        policies,
    });
}

function toTransportOrder(
    strategy: RallarCrdtTransportStrategy | RallarCrdtTransportKind,
): readonly RallarCrdtTransportKind[] {
    switch (strategy) {
        case 'ws':
            return ['ws'];
        case 'rtc':
            return ['rtc'];
        case 'ws-then-rtc':
            return ['ws', 'rtc'];
        case 'rtc-with-ws-fallback':
            return ['rtc', 'ws'];
        case 'local-only':
            return [];
    }
}

function isLiveTransportScope(ref: RallarCrdtDocumentRef): boolean {
    return (
        (ref.scope === 'room' && ref.roomRef !== undefined) ||
        ref.scope === 'app' ||
        ref.scope === 'principal'
    );
}

function toRallarCrdtContextId(ref: RallarCrdtDocumentRef): string {
    return ref.roomRef?.groupId ?? ref.principalId ?? ref.documentId;
}
