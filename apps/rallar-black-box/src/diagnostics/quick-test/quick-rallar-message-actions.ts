import type { RallarMessage } from '@shared-web/browser/rallar.ts';
import {
    createDirectRallarRuntimeEvent,
    runDirectRallarWsSend,
    runDirectRallarWsSubscribe
} from '../../direct-rallar-operations.ts';
import { loadBrowserRallarFacade } from '../../legacy/rallar/load-browser-rallar-facade.ts';
import { rallarBlackBoxRuntimeStore } from '../../runtime-store.ts';
import type { DirectRallarOperationContext } from '../direct-rallar-contracts.ts';
import type {
    QuickRallarJsonValue,
    QuickRallarPayloadResult,
    QuickRallarReceivedMessageRow
} from './quick-rallar-contracts.ts';
import { runQuickRallarOperation } from './quick-rallar-operation-actions.ts';
import type { QuickRallarTestRuntimeState } from './use-quick-rallar-test-state.ts';

export interface QuickRallarMessageActionsInput {
    readonly operationContext: DirectRallarOperationContext;
    readonly activeTypeId: string;
    readonly activeTopicId: string;
    readonly activeContextId: string;
    readonly activeResourceId: string | undefined;
    readonly selectorLabel: string;
    readonly payloadResult: QuickRallarPayloadResult;
    readonly runtimeState: QuickRallarTestRuntimeState;
}

export interface QuickRallarMessageActions {
    subscribeWs(): Promise<void>;
    unsubscribeWs(): void;
    sendWs(): Promise<void>;
}

export function createQuickRallarMessageActions({
    operationContext,
    activeTypeId,
    activeTopicId,
    activeContextId,
    activeResourceId,
    selectorLabel,
    payloadResult,
    runtimeState
}: QuickRallarMessageActionsInput): QuickRallarMessageActions {
    return {
        subscribeWs: () =>
            subscribeQuickRallarWs({
                operationContext,
                activeTypeId,
                activeTopicId,
                activeContextId,
                selectorLabel,
                runtimeState
            }),
        unsubscribeWs: () => unsubscribeQuickRallarWs({ operationContext, selectorLabel, runtimeState }),
        sendWs: () =>
            sendQuickRallarWs({
                operationContext,
                activeTypeId,
                activeTopicId,
                activeContextId,
                activeResourceId,
                payloadResult,
                runtimeState
            })
    };
}

interface SubscribeQuickRallarWsInput {
    readonly operationContext: DirectRallarOperationContext;
    readonly activeTypeId: string;
    readonly activeTopicId: string;
    readonly activeContextId: string;
    readonly selectorLabel: string;
    readonly runtimeState: QuickRallarTestRuntimeState;
}

async function subscribeQuickRallarWs(input: SubscribeQuickRallarWsInput): Promise<void> {
    if (!input.activeTypeId) {
        input.runtimeState.setLocalError('WS subscribe requires a Type ID.');
        return;
    }
    if (!input.operationContext.roomId) {
        input.runtimeState.setLocalError('WS subscribe requires a group.');
        return;
    }
    input.runtimeState.subscriptionRef.current?.unsubscribe();
    input.runtimeState.setSubscription(undefined);
    await runQuickRallarOperation({
        ...input,
        busyLabel: 'Subscribe WS',
        action: () =>
            runDirectRallarWsSubscribe(
                input.operationContext,
                {
                    selector: toQuickRallarWsSelector(input),
                    handler: (message: RallarMessage<QuickRallarJsonValue>) =>
                        recordQuickRallarWsMessage(input, message)
                },
                loadBrowserRallarFacade
            ),
        completedAction: 'Quick Test WS subscribed',
        failedAction: 'Quick Test WS subscribe failed',
        onCompleted: (result) => setQuickRallarSubscription(input, result.unsubscribe)
    });
}

interface QuickRallarWsSelector {
    readonly typeId: string;
    readonly topicId?: string;
}

function toQuickRallarWsSelector({
    activeTypeId,
    activeTopicId
}: SubscribeQuickRallarWsInput): QuickRallarWsSelector {
    return { typeId: activeTypeId, ...(activeTopicId ? { topicId: activeTopicId } : {}) };
}

function setQuickRallarSubscription(
    input: SubscribeQuickRallarWsInput,
    unsubscribe: (() => void) | undefined
): void {
    if (!unsubscribe) {
        return;
    }
    input.runtimeState.setSubscription({
        transport: 'ws',
        label: input.selectorLabel,
        groupId: input.operationContext.roomId ?? '',
        subscribedAtEpochMs: Date.now(),
        unsubscribe
    });
    input.runtimeState.setWaitStatus('subscribed');
}

interface QuickRallarInboundMessage {
    readonly receivedAtEpochMs: number;
    readonly senderId: string;
    readonly roomId?: string;
    readonly typeId: string;
    readonly topicId: string;
    readonly contextId: string;
    readonly resourceId: string;
    readonly payload: QuickRallarJsonValue;
}

function recordQuickRallarWsMessage(
    input: SubscribeQuickRallarWsInput,
    message: QuickRallarInboundMessage
): void {
    const row = toQuickRallarReceivedMessageRow(input, message);
    input.runtimeState.setReceivedMessages((current) => [...current, row].slice(-50));
    rallarBlackBoxRuntimeStore.recordRuntimeEvent(
        createDirectRallarRuntimeEvent({
            kind: 'message',
            topic: 'rallar.direct.ws.message',
            context: input.operationContext,
            transport: 'ws',
            payload: row
        }),
        'Quick Test WS message received'
    );
}

function toQuickRallarReceivedMessageRow(
    input: SubscribeQuickRallarWsInput,
    message: QuickRallarInboundMessage
): QuickRallarReceivedMessageRow {
    return {
        rowId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        atEpochMs: message.receivedAtEpochMs,
        transport: 'ws',
        senderId: message.senderId,
        roomId: message.roomId ?? input.operationContext.roomId ?? '-',
        typeId: message.typeId || input.activeTypeId || '-',
        topicId: message.topicId || input.activeTopicId || '-',
        contextId: message.contextId || input.activeContextId || '-',
        resourceId: message.resourceId || '-',
        payload: message.payload
    };
}

function unsubscribeQuickRallarWs({
    operationContext,
    selectorLabel,
    runtimeState
}: Pick<QuickRallarMessageActionsInput, 'operationContext' | 'selectorLabel' | 'runtimeState'>): void {
    runtimeState.subscriptionRef.current?.unsubscribe();
    runtimeState.setSubscription(undefined);
    runtimeState.setWaitStatus('unsubscribed');
    rallarBlackBoxRuntimeStore.recordRuntimeEvent(
        createDirectRallarRuntimeEvent({
            topic: 'rallar.direct.ws.unsubscribe.completed',
            context: operationContext,
            transport: 'ws',
            payload: { groupId: operationContext.roomId, selector: selectorLabel }
        }),
        'Quick Test WS unsubscribed'
    );
}

interface SendQuickRallarWsInput extends
    Pick<
        QuickRallarMessageActionsInput,
        | 'operationContext'
        | 'activeTypeId'
        | 'activeTopicId'
        | 'activeContextId'
        | 'activeResourceId'
        | 'payloadResult'
        | 'runtimeState'
    > {}

async function sendQuickRallarWs(input: SendQuickRallarWsInput): Promise<void> {
    if (!input.payloadResult.ok) {
        input.runtimeState.setLocalError(input.payloadResult.error ?? 'WS send requires valid JSON.');
        return;
    }
    if (!input.operationContext.roomId) {
        input.runtimeState.setLocalError('WS send requires a group.');
        return;
    }
    const payload = input.payloadResult.value;
    await runQuickRallarOperation({
        ...input,
        busyLabel: 'Send WS JSON',
        action: () =>
            runDirectRallarWsSend(input.operationContext, {
                scope: 'room',
                typeId: input.activeTypeId,
                topicId: input.activeTopicId,
                contextId: input.activeContextId,
                resourceId: input.activeResourceId,
                payload
            }, loadBrowserRallarFacade),
        completedAction: 'Quick Test WS JSON sent',
        failedAction: 'Quick Test WS send failed'
    });
}
