import { AL_DELIVERY_ADMITTED_STATES, type ALDeliveryState } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestJsonValue,
    RallarBlackBoxTestMessagesSendCommand
} from '../../rallar-black-box-test-contracts.ts';

import {
    ASSERT_TIMEOUT_MS,
    MESSAGE_CONTROL_TIMEOUT_MS,
    NON_EXPIRING_SEND_TIMEOUT_MS,
    RESPONSE_MARGIN_MS,
    toBudgetMs
} from './alm-conformance-budgets.ts';
import type { AlmConformanceMessageStepInput, AlmConformanceStepInput } from './alm-conformance-scenario-definition.ts';
import {
    ALM_CONFORMANCE_TOPIC_ID,
    toCommandId,
    toRoomRef,
    toScenarioTypeId,
    toSendHandleId
} from './alm-conformance-step-identities.ts';

interface AlmConformanceSendDelivery {
    readonly ttlMs?: number;
    /** Command budget when it must stay independent of `ttlMs`. */
    readonly commandTimeoutMs?: number;
    readonly ack?: 'receiver';
    readonly reliability?: 'at-least-once';
    readonly orderingKey?: string;
    readonly seq?: number;
    readonly minSnapshotVersion?: RallarBlackBoxTestMessagesSendCommand['minSnapshotVersion'];
}

interface AlmConformanceSendInput extends AlmConformanceMessageStepInput {
    readonly payload: RallarBlackBoxTestJsonValue;
    readonly delivery: AlmConformanceSendDelivery;
}

interface AlmConformanceObserveInput extends AlmConformanceMessageStepInput {
    readonly state: 'admitted' | ALDeliveryState;
}

interface AlmConformanceResultAssertionInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    readonly resultName: string;
    readonly field: string;
    readonly operator: 'equals' | 'matches' | 'gt';
    readonly expected: string | number | boolean;
}

const STORAGE_COUNTERS_TIMEOUT_MS = 3_000;
const OBSERVE_TIMEOUT_BASE_MS = 2_000;

export function toSendCommand(send: AlmConformanceSendInput): RallarBlackBoxTestMessagesSendCommand {
    const input = send.input;
    const typeId = toScenarioTypeId(send);
    const { commandTimeoutMs, ...delivery } = send.delivery;
    return {
        kind: 'messages.send',
        commandId: toCommandId(send, `send-${send.index}`),
        connection: input.senderConnection,
        carrier: input.carrier,
        typeId,
        topicId: ALM_CONFORMANCE_TOPIC_ID,
        payload: send.payload,
        handleId: toSendHandleId(send),
        timeoutMs: toBudgetMs(
            commandTimeoutMs ?? delivery.ttlMs ?? NON_EXPIRING_SEND_TIMEOUT_MS,
            input.deadlineMs
        ),
        ...(input.carrier === 'ws' ? {} : { roomRef: toRoomRef(input.group) }),
        ...delivery
    };
}

export function toObserveCommand(observe: AlmConformanceObserveInput): RallarBlackBoxTestCommand {
    return {
        kind: 'messages.observe',
        commandId: toCommandId(observe, `observe-${observe.state}-${observe.index}`),
        connection: observe.input.senderConnection,
        handleId: toSendHandleId(observe),
        state: observe.state === 'admitted' ? AL_DELIVERY_ADMITTED_STATES : [observe.state],
        timeoutMs: toBudgetMs(toObserveBudgetMs(observe.state), observe.input.deadlineMs)
    };
}

/** Expiry and carrier acceptance can outlast admission on a loaded runner. Other states are local. */
function toObserveBudgetMs(state: AlmConformanceObserveInput['state']): number {
    return state === 'expired' || state === 'acknowledged' || state === 'transport-accepted'
        ? NON_EXPIRING_SEND_TIMEOUT_MS
        : OBSERVE_TIMEOUT_BASE_MS + RESPONSE_MARGIN_MS;
}

/** A terminal wait also resolves for rejection or failure; the recipe must prove successful admission. */
export function toAdmissionCommands(admission: AlmConformanceMessageStepInput): readonly RallarBlackBoxTestCommand[] {
    const observation = toObserveCommand({ ...admission, state: 'admitted' });
    return [
        observation,
        {
            kind: 'assert',
            commandId: toCommandId(admission, `assert-admitted-${admission.index}`),
            source: `resultCache.${observation.commandId}.value.state`,
            operator: 'matches',
            expected: '^(accepted|queued|transport-accepted|acknowledged)$',
            timeoutMs: toBudgetMs(ASSERT_TIMEOUT_MS, admission.input.deadlineMs)
        }
    ];
}

export function toRetainedEvidenceCommands(step: AlmConformanceMessageStepInput): readonly RallarBlackBoxTestCommand[] {
    const observation = `observe-admitted-${step.index}`;
    return [
        ...toAdmissionCommands(step),
        toResultAssertion({
            step: step,
            name: `assert-enqueued-${step.index}`,
            resultName: observation,
            field: 'enqueued',
            operator: 'equals',
            expected: true
        }),
        toResultAssertion({
            step: step,
            name: `assert-retained-${step.index}`,
            resultName: observation,
            field: 'state',
            operator: 'matches',
            expected: '^(accepted|queued)$'
        }),
        toResultAssertion({
            step: step,
            name: `assert-unsubmitted-${step.index}`,
            resultName: observation,
            field: 'submitted',
            operator: 'equals',
            expected: false
        })
    ];
}

export function toCancelCommand(cancel: AlmConformanceMessageStepInput): RallarBlackBoxTestCommand {
    return {
        kind: 'messages.cancel',
        commandId: toCommandId(cancel, `cancel-${cancel.index}`),
        connection: cancel.input.senderConnection,
        handleId: toSendHandleId(cancel),
        timeoutMs: toBudgetMs(MESSAGE_CONTROL_TIMEOUT_MS, cancel.input.deadlineMs)
    };
}

export function toReceiptsCommand(receipts: AlmConformanceMessageStepInput): RallarBlackBoxTestCommand {
    return {
        kind: 'messages.receipts',
        commandId: toCommandId(receipts, `receipts-${receipts.index}`),
        connection: receipts.input.senderConnection,
        handleId: toSendHandleId(receipts),
        timeoutMs: toBudgetMs(MESSAGE_CONTROL_TIMEOUT_MS, receipts.input.deadlineMs)
    };
}

export function toResultAssertion(
    { step, name, resultName, field, operator, expected }: AlmConformanceResultAssertionInput
): RallarBlackBoxTestCommand {
    return {
        kind: 'assert',
        commandId: toCommandId(step, name),
        source: `resultCache.${toCommandId(step, resultName)}.value.${field}`,
        operator,
        expected,
        timeoutMs: toBudgetMs(ASSERT_TIMEOUT_MS, step.input.deadlineMs)
    };
}

export function toStorageCountersCommand(step: AlmConformanceStepInput, name: string): RallarBlackBoxTestCommand {
    return {
        kind: 'storage.counters',
        commandId: toCommandId(step, name),
        reset: false,
        timeoutMs: toBudgetMs(STORAGE_COUNTERS_TIMEOUT_MS, step.input.deadlineMs)
    };
}
