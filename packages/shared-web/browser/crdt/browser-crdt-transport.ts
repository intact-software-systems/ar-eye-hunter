import type { RallarUnsubscribe } from '@shared-web/browser/rallar-data.ts';
import {
    evaluateRallarCrdtFeaturePolicy,
    RALLAR_CRDT_APP_TOPIC_ID,
    RALLAR_CRDT_APPEND_RESPONSE_TYPE_ID,
    RALLAR_CRDT_CATCH_UP_REQUEST_TYPE_ID,
    RALLAR_CRDT_CATCH_UP_RESPONSE_TYPE_ID,
    RALLAR_CRDT_ROOM_TOPIC_ID,
    RALLAR_CRDT_SYNC_REQUEST_TYPE_ID,
    RALLAR_CRDT_SYNC_RESPONSE_TYPE_ID,
    RALLAR_CRDT_UPDATE_TYPE_ID,
    type RallarCrdtAppendResponseEnvelope,
    type RallarCrdtCatchUpRequestEnvelope,
    type RallarCrdtCatchUpResponseEnvelope,
    type RallarCrdtDocumentRef,
    type RallarCrdtDocumentTypePolicy,
    type RallarCrdtOperationBatch,
    type RallarCrdtSyncRequestEnvelope,
    type RallarCrdtSyncResponseEnvelope,
    type RallarCrdtTransportStrategy,
    type RallarCrdtUpdateEnvelope
} from '@shared/crdt/mod.ts';

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
        input: RallarCrdtTransportSendInput<TPayload>
    ): Promise<RallarCrdtTransportSendResult>;
    onMessage<TPayload>(
        selector: Readonly<{ topicId?: string; typeId?: string; }>,
        handler: (
            message: RallarCrdtTransportMessage<TPayload>
        ) => void | Promise<void>
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

export namespace SubscribeRallarCrdtLiveTransport {
    export type Input<TPayload extends RallarCrdtOperationBatch> = Readonly<{
        ref: RallarCrdtDocumentRef;
        transport: RallarCrdtMessageTransport | undefined;
        strategy: RallarCrdtTransportStrategy;
        onUpdate(
            update: RallarCrdtUpdateEnvelope<TPayload>,
            transport: RallarCrdtTransportKind
        ): void | Promise<void>;
        onSyncRequest?(
            request: RallarCrdtSyncRequestEnvelope,
            transport: RallarCrdtTransportKind
        ): void | Promise<void>;
        onSyncResponse?(
            response: RallarCrdtSyncResponseEnvelope<unknown, TPayload>,
            transport: RallarCrdtTransportKind
        ): void | Promise<void>;
        onAppendResponse?(
            response: RallarCrdtAppendResponseEnvelope<TPayload>,
            transport: RallarCrdtTransportKind
        ): void | Promise<void>;
        onCatchUpResponse?(
            response: RallarCrdtCatchUpResponseEnvelope<unknown, TPayload>,
            transport: Extract<RallarCrdtTransportKind, 'ws'>
        ): void | Promise<void>;
        policies?: readonly RallarCrdtDocumentTypePolicy[];
    }>;
}

export function subscribeRallarCrdtLiveTransport<TPayload extends RallarCrdtOperationBatch>(
    options: SubscribeRallarCrdtLiveTransport.Input<TPayload>
): readonly RallarUnsubscribe[] {
    const topicId = toRallarCrdtLiveTopicId(options.ref);
    const unsubscribes: RallarUnsubscribe[] = [];
    if (
        usesWs(options.strategy) &&
        options.transport?.ws &&
        isTransportAllowed(options.ref, 'ws', options.policies)
    ) {
        unsubscribes.push(...subscribeRallarCrdtWsLane({
            options,
            lane: options.transport.ws,
            topicId
        }));
    }
    if (
        usesRtc(options.strategy) &&
        options.transport?.rtc &&
        isTransportAllowed(options.ref, 'rtc', options.policies)
    ) {
        unsubscribes.push(...subscribeRallarCrdtLane({
            options,
            lane: options.transport.rtc,
            topicId,
            transportKind: 'rtc'
        }));
    }
    return unsubscribes;
}

interface SubscribeRallarCrdtLaneInput<TPayload extends RallarCrdtOperationBatch> {
    readonly options: SubscribeRallarCrdtLiveTransport.Input<TPayload>;
    readonly lane: RallarCrdtTransportLane;
    readonly topicId: string;
    readonly transportKind: RallarCrdtTransportKind;
}

function subscribeRallarCrdtWsLane<TPayload extends RallarCrdtOperationBatch>(
    input: Omit<SubscribeRallarCrdtLaneInput<TPayload>, 'transportKind'>
): readonly RallarUnsubscribe[] {
    const onCatchUpResponse = input.options.onCatchUpResponse;
    const subscriptions = [...subscribeRallarCrdtLane({
        ...input,
        transportKind: 'ws'
    })];
    const catchUp = subscribeOptionalRallarCrdtPayload({
        lane: input.lane,
        topicId: input.topicId,
        typeId: RALLAR_CRDT_CATCH_UP_RESPONSE_TYPE_ID,
        onPayload: onCatchUpResponse
            ? (payload: RallarCrdtCatchUpResponseEnvelope<unknown, TPayload>) => onCatchUpResponse(payload, 'ws')
            : undefined
    });
    if (catchUp) {
        subscriptions.push(catchUp);
    }
    return subscriptions;
}

function subscribeRallarCrdtLane<TPayload extends RallarCrdtOperationBatch>(
    input: SubscribeRallarCrdtLaneInput<TPayload>
): readonly RallarUnsubscribe[] {
    const { lane, options, topicId, transportKind } = input;
    const { onAppendResponse, onSyncRequest, onSyncResponse } = options;
    return withoutMissingSubscriptions([
        subscribeRallarCrdtPayload({
            lane,
            topicId,
            typeId: RALLAR_CRDT_UPDATE_TYPE_ID,
            onPayload: (payload: RallarCrdtUpdateEnvelope<TPayload>) => options.onUpdate(payload, transportKind)
        }),
        subscribeOptionalRallarCrdtPayload({
            lane,
            topicId,
            typeId: RALLAR_CRDT_SYNC_REQUEST_TYPE_ID,
            onPayload: onSyncRequest
                ? (payload: RallarCrdtSyncRequestEnvelope) => onSyncRequest(payload, transportKind)
                : undefined
        }),
        subscribeOptionalRallarCrdtPayload({
            lane,
            topicId,
            typeId: RALLAR_CRDT_SYNC_RESPONSE_TYPE_ID,
            onPayload: onSyncResponse
                ? (payload: RallarCrdtSyncResponseEnvelope<unknown, TPayload>) => onSyncResponse(payload, transportKind)
                : undefined
        }),
        subscribeOptionalRallarCrdtPayload({
            lane,
            topicId,
            typeId: RALLAR_CRDT_APPEND_RESPONSE_TYPE_ID,
            onPayload: onAppendResponse
                ? (payload: RallarCrdtAppendResponseEnvelope<TPayload>) => onAppendResponse(payload, transportKind)
                : undefined
        })
    ]);
}

interface SubscribeRallarCrdtPayloadInput<TPayload> {
    readonly lane: RallarCrdtTransportLane;
    readonly topicId: string;
    readonly typeId: string;
    readonly onPayload: (payload: TPayload) => void | Promise<void>;
}

interface SubscribeOptionalRallarCrdtPayloadInput<TPayload> {
    readonly lane: RallarCrdtTransportLane;
    readonly topicId: string;
    readonly typeId: string;
    readonly onPayload: ((payload: TPayload) => void | Promise<void>) | undefined;
}

function subscribeOptionalRallarCrdtPayload<TPayload>(
    input: SubscribeOptionalRallarCrdtPayloadInput<TPayload>
): RallarUnsubscribe | undefined {
    if (!input.onPayload) {
        return undefined;
    }
    return subscribeRallarCrdtPayload({
        lane: input.lane,
        topicId: input.topicId,
        typeId: input.typeId,
        onPayload: input.onPayload
    });
}

function subscribeRallarCrdtPayload<TPayload>(
    input: SubscribeRallarCrdtPayloadInput<TPayload>
): RallarUnsubscribe {
    return input.lane.onMessage<TPayload>(
        { topicId: input.topicId, typeId: input.typeId },
        async (message) => {
            await input.onPayload(message.payload);
        }
    );
}

function withoutMissingSubscriptions(
    subscriptions: readonly (RallarUnsubscribe | undefined)[]
): readonly RallarUnsubscribe[] {
    return subscriptions.filter(
        (subscription): subscription is RallarUnsubscribe => subscription !== undefined
    );
}

export async function sendRallarCrdtLiveUpdate<TPayload extends RallarCrdtOperationBatch>(
    options: Readonly<{
        update: RallarCrdtUpdateEnvelope<TPayload>;
        transport: RallarCrdtMessageTransport | undefined;
        strategy: RallarCrdtTransportStrategy;
        policies?: readonly RallarCrdtDocumentTypePolicy[];
    }>
): Promise<RallarCrdtLiveSendOutcome> {
    if (options.strategy === 'local-only') {
        return {
            attempted: [],
            results: [],
            sentCount: 0,
            failedCount: 0,
            status: 'deferred',
            reason: 'Document is opened in local-only mode.'
        };
    }

    if (!isLiveTransportScope(options.update.document)) {
        return {
            attempted: [],
            results: [],
            sentCount: 0,
            failedCount: 0,
            status: 'deferred',
            reason: 'Live CRDT transport supports room documents and WS app/principal documents.'
        };
    }

    if (!options.transport) {
        return {
            attempted: [],
            results: [],
            sentCount: 0,
            failedCount: 0,
            status: 'deferred',
            reason: 'No CRDT live transport is configured.'
        };
    }

    switch (options.strategy) {
        case 'ws':
            return await sendThroughOrderedTransports(options, ['ws']);
        case 'rtc':
            return await sendThroughOrderedTransports(options, ['rtc']);
        case 'ws-then-rtc':
            return await sendThroughOrderedTransports(options, ['ws', 'rtc'], {
                continueAfterSuccess: true
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
    }>
): Promise<RallarCrdtLiveSendOutcome> {
    return await sendRallarCrdtControlEnvelope({
        envelope: options.request,
        document: options.request.document,
        transport: options.transport,
        strategy: options.strategy,
        typeId: RALLAR_CRDT_SYNC_REQUEST_TYPE_ID,
        resourceId: options.request.requestId,
        policies: options.policies
    });
}

export async function sendRallarCrdtCatchUpRequest(
    options: Readonly<{
        request: RallarCrdtCatchUpRequestEnvelope;
        transport: RallarCrdtMessageTransport | undefined;
        policies?: readonly RallarCrdtDocumentTypePolicy[];
    }>
): Promise<RallarCrdtLiveSendOutcome> {
    if (!options.transport?.ws) {
        const reason = 'WS CRDT transport is not configured.';
        return toFailedRallarCrdtWsOutcome('missing-transport', reason);
    }

    if (!isLiveTransportScope(options.request.document)) {
        return toDeferredRallarCrdtWsOutcome(
            'CRDT durable catch-up supports room, app, and principal documents over WS.'
        );
    }

    const policy = evaluateRallarCrdtFeaturePolicy({
        document: options.request.document,
        operation: 'durable-catch-up',
        policies: options.policies
    });
    if (!policy.allowed) {
        return toFailedRallarCrdtWsOutcome(policy.code, policy.reason);
    }

    const result = await options.transport.ws.send({
        topicId: toRallarCrdtLiveTopicId(options.request.document),
        typeId: RALLAR_CRDT_CATCH_UP_REQUEST_TYPE_ID,
        payload: options.request,
        contextId: toRallarCrdtContextId(options.request.document),
        resourceId: options.request.requestId,
        roomId: options.request.document.roomRef?.groupId,
        roomRef: options.request.document.roomRef,
        scope: options.request.document.roomRef ? 'room' : undefined
    });
    return toRallarCrdtLiveSendOutcome({
        attempted: ['ws'],
        results: [
            {
                ...result,
                transport: 'ws'
            }
        ]
    });
}

function toFailedRallarCrdtWsOutcome(
    status: string,
    reason: string
): RallarCrdtLiveSendOutcome {
    return toRallarCrdtLiveSendOutcome({
        attempted: ['ws'],
        results: [{ transport: 'ws', status, reason }]
    });
}

function toDeferredRallarCrdtWsOutcome(reason: string): RallarCrdtLiveSendOutcome {
    return {
        attempted: ['ws'],
        results: [],
        sentCount: 0,
        failedCount: 0,
        status: 'deferred',
        reason
    };
}

export async function sendRallarCrdtSyncResponse<TPayload extends RallarCrdtOperationBatch>(
    options: Readonly<{
        response: RallarCrdtSyncResponseEnvelope<unknown, TPayload>;
        transport: RallarCrdtMessageTransport | undefined;
        replyTransport: RallarCrdtTransportKind;
        policies?: readonly RallarCrdtDocumentTypePolicy[];
    }>
): Promise<RallarCrdtLiveSendOutcome> {
    return await sendRallarCrdtControlEnvelope({
        envelope: options.response,
        document: options.response.document,
        transport: options.transport,
        strategy: options.replyTransport,
        typeId: RALLAR_CRDT_SYNC_RESPONSE_TYPE_ID,
        resourceId: options.response.responseId,
        policies: options.policies
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

async function sendThroughOrderedTransports<TPayload extends RallarCrdtOperationBatch>(
    options: Readonly<{
        update: RallarCrdtUpdateEnvelope<TPayload>;
        transport: RallarCrdtMessageTransport | undefined;
        strategy: RallarCrdtTransportStrategy;
        policies?: readonly RallarCrdtDocumentTypePolicy[];
    }>,
    order: readonly RallarCrdtTransportKind[],
    behavior: Readonly<{ continueAfterSuccess?: boolean; }> = {}
): Promise<RallarCrdtLiveSendOutcome> {
    const results: RallarCrdtTransportSendResult[] = [];
    const attempted: RallarCrdtTransportKind[] = [];

    for (const transportKind of order) {
        attempted.push(transportKind);
        const result = await sendRallarCrdtUpdateThroughTransport({
            update: options.update,
            transport: options.transport,
            transportKind,
            policies: options.policies
        });
        results.push(result);
        if (
            isSuccessfulRallarCrdtTransportStatus(result.status) &&
            !behavior.continueAfterSuccess
        ) {
            break;
        }
    }

    return toRallarCrdtLiveSendOutcome({
        attempted,
        results
    });
}

interface SendRallarCrdtUpdateThroughTransportInput<TPayload extends RallarCrdtOperationBatch> {
    readonly update: RallarCrdtUpdateEnvelope<TPayload>;
    readonly transport: RallarCrdtMessageTransport | undefined;
    readonly transportKind: RallarCrdtTransportKind;
    readonly policies: readonly RallarCrdtDocumentTypePolicy[] | undefined;
}

async function sendRallarCrdtUpdateThroughTransport<TPayload extends RallarCrdtOperationBatch>(
    input: SendRallarCrdtUpdateThroughTransportInput<TPayload>
): Promise<RallarCrdtTransportSendResult> {
    const decision = evaluateTransportDecision(
        input.update.document,
        input.transportKind,
        input.policies
    );
    if (!decision.allowed) {
        return {
            transport: input.transportKind,
            status: decision.code,
            reason: decision.reason
        };
    }
    const lane = input.transport?.[input.transportKind];
    if (!lane) {
        return {
            transport: input.transportKind,
            status: 'missing-transport',
            reason: `${input.transportKind.toUpperCase()} CRDT transport is not configured.`
        };
    }

    try {
        return {
            ...await lane.send(
                toRallarCrdtTransportSendInput(input.update, input.transportKind)
            ),
            transport: input.transportKind
        };
    }
    catch (error) {
        return {
            transport: input.transportKind,
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error)
        };
    }
}

function toRallarCrdtTransportSendInput<TPayload extends RallarCrdtOperationBatch>(
    update: RallarCrdtUpdateEnvelope<TPayload>,
    transport: RallarCrdtTransportKind
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
        scope: transport === 'ws' && roomRef ? 'room' : undefined
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
    }>
): Promise<RallarCrdtLiveSendOutcome> {
    if (!options.transport) {
        return {
            attempted: [],
            results: [],
            sentCount: 0,
            failedCount: 0,
            status: 'deferred',
            reason: 'No CRDT live transport is configured.'
        };
    }

    if (!isLiveTransportScope(options.document)) {
        return {
            attempted: [],
            results: [],
            sentCount: 0,
            failedCount: 0,
            status: 'deferred',
            reason: 'Live CRDT sync supports room documents and WS app/principal documents.'
        };
    }

    const order = toTransportOrder(options.strategy);
    const results: RallarCrdtTransportSendResult[] = [];

    for (const transportKind of order) {
        const result = await sendRallarCrdtControlThroughTransport({
            envelope: options.envelope,
            document: options.document,
            transport: options.transport,
            transportKind,
            typeId: options.typeId,
            resourceId: options.resourceId,
            policies: options.policies
        });
        results.push(result);
        if (
            isSuccessfulRallarCrdtTransportStatus(result.status) &&
            options.strategy !== 'ws-then-rtc'
        ) {
            break;
        }
    }

    return toRallarCrdtLiveSendOutcome({
        attempted: order,
        results
    });
}

interface SendRallarCrdtControlThroughTransportInput<TEnvelope> {
    readonly envelope: TEnvelope;
    readonly document: RallarCrdtDocumentRef;
    readonly transport: RallarCrdtMessageTransport;
    readonly transportKind: RallarCrdtTransportKind;
    readonly typeId: string;
    readonly resourceId: string;
    readonly policies: readonly RallarCrdtDocumentTypePolicy[] | undefined;
}

async function sendRallarCrdtControlThroughTransport<TEnvelope>(
    input: SendRallarCrdtControlThroughTransportInput<TEnvelope>
): Promise<RallarCrdtTransportSendResult> {
    const decision = evaluateTransportDecision(
        input.document,
        input.transportKind,
        input.policies
    );
    if (!decision.allowed) {
        return {
            transport: input.transportKind,
            status: decision.code,
            reason: decision.reason
        };
    }
    const lane = input.transport[input.transportKind];
    if (!lane) {
        return { transport: input.transportKind, status: 'missing-transport' };
    }

    return {
        ...await lane.send({
            topicId: toRallarCrdtLiveTopicId(input.document),
            typeId: input.typeId,
            payload: input.envelope,
            contextId: toRallarCrdtContextId(input.document),
            resourceId: input.resourceId,
            roomId: input.document.roomRef?.groupId,
            roomRef: input.document.roomRef,
            scope: input.transportKind === 'ws' && input.document.roomRef
                ? 'room'
                : undefined
        }),
        transport: input.transportKind
    };
}

interface ToRallarCrdtLiveSendOutcomeInput {
    readonly attempted: readonly RallarCrdtTransportKind[];
    readonly results: readonly RallarCrdtTransportSendResult[];
}

function toRallarCrdtLiveSendOutcome(
    input: ToRallarCrdtLiveSendOutcomeInput
): RallarCrdtLiveSendOutcome {
    const sentCount = input.results
        .filter((result) => isSuccessfulRallarCrdtTransportStatus(result.status))
        .length;
    const failedCount = input.results.length - sentCount;
    let status: RallarCrdtLiveSendOutcome['status'] = 'deferred';
    if (sentCount > 0) {
        status = 'sent';
    }
    else if (failedCount > 0) {
        status = 'failed';
    }

    return {
        attempted: input.attempted,
        results: input.results,
        sentCount,
        failedCount,
        status,
        reason: input.results.find((result) => result.reason)?.reason
    };
}

function isTransportAllowed(
    document: RallarCrdtDocumentRef,
    transport: RallarCrdtTransportKind,
    policies: readonly RallarCrdtDocumentTypePolicy[] | undefined
): boolean {
    return evaluateTransportDecision(document, transport, policies).allowed;
}

function evaluateTransportDecision(
    document: RallarCrdtDocumentRef,
    transport: RallarCrdtTransportKind,
    policies: readonly RallarCrdtDocumentTypePolicy[] | undefined
) {
    if (transport === 'rtc' && document.scope !== 'room') {
        return {
            allowed: false,
            code: 'rtc-scope-unsupported',
            reason: 'RTC CRDT transport is room-scoped; use WS for app or principal documents.',
            rollout: 'production' as const,
            retryable: false
        };
    }
    return evaluateRallarCrdtFeaturePolicy({
        document,
        operation: transport === 'ws' ? 'ws-send' : 'rtc-send',
        policies
    });
}

function toTransportOrder(
    strategy: RallarCrdtTransportStrategy | RallarCrdtTransportKind
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
