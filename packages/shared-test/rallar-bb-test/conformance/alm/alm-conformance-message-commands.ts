import type { ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
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
    readonly ack?: 'receiver' | 'all-logical-recipients';
    readonly reliability?: 'at-least-once';
    readonly durability?: 'local-outbox' | 'local-inbox';
    readonly orderingKey?: string;
    readonly seq?: number;
    readonly minSnapshotVersion?: RallarBlackBoxTestMessagesSendCommand['minSnapshotVersion'];
    /** Absent, the send addresses its room. */
    readonly toPeer?: RallarBlackBoxTestMessagesSendCommand['toPeer'];
}

interface AlmConformanceSendInput extends AlmConformanceMessageStepInput {
    readonly payload: RallarBlackBoxTestJsonValue;
    readonly delivery: AlmConformanceSendDelivery;
}

interface AlmConformanceObserveInput extends AlmConformanceMessageStepInput {
    readonly state: 'admitted' | ALDeliveryState;
    /** Absent: the state's own budget; a scenario whose wait outlasts a carrier's retry budget names its own. */
    readonly budgetMs?: number;
}

interface AlmConformanceControlAdmissionWaitInput {
    readonly step: AlmConformanceMessageStepInput;
    readonly name: string;
    /** The control that answers the send of `step.index`. */
    readonly controlTypeId: string;
    /** A receipt's phase to match; absent, any committed admission of the control matches (a receipt's first). */
    readonly receiptPhase?: ALReceiptPayload['phase'];
}

interface AlmConformanceResultAssertionInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    readonly resultName: string;
    readonly field: string;
    readonly operator: 'equals' | 'matches' | 'gt' | 'contains';
    readonly expected: string | number | boolean;
}

const OUTBOUND_DIAGNOSTICS_TOPIC = 'rallar.browser.alm.outbound_diagnostics';
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
        timeoutMs: toBudgetMs(observe.budgetMs ?? toObserveBudgetMs(observe.state), observe.input.deadlineMs)
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

/** `durable` is the store the admission chose: only a send that opted into a durability is enqueued. */
export function toRetainedEvidenceCommands(
    step: AlmConformanceMessageStepInput,
    durable: boolean
): readonly RallarBlackBoxTestCommand[] {
    const observation = `observe-admitted-${step.index}`;
    return [
        ...toAdmissionCommands(step),
        toResultAssertion({
            step: step,
            name: `assert-enqueued-${step.index}`,
            resultName: observation,
            field: 'enqueued',
            operator: 'equals',
            expected: durable
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

/**
 * The `control-admission` event in which the origin commits a control that answers one of its sends, matched in its
 * emitted key order (`typeId`, `targetMsgId`, `outcome`, then a receipt's `phase` after the `reason`). The verdict is
 * local to the origin, so the wait polls no other page.
 */
export function toCommittedControlAdmissionWait(
    { step, name, controlTypeId, receiptPhase }: AlmConformanceControlAdmissionWaitInput
): RallarBlackBoxTestCommand {
    const targetMsgId = `{resultCache.${toCommandId(step, `send-${step.index}`)}.value.msgId}`;
    const phase = receiptPhase === undefined ? '' : `,"reason":"none","phase":"${receiptPhase}"`;
    return {
        kind: 'wait',
        commandId: toCommandId(step, name),
        match: {
            kind: 'diagnostic',
            topic: OUTBOUND_DIAGNOSTICS_TOPIC,
            payloadPath: 'data',
            contains: `"typeId":"${controlTypeId}","targetMsgId":"${targetMsgId}","outcome":"committed"${phase}`
        },
        timeoutMs: step.input.deadlineMs + NON_EXPIRING_SEND_TIMEOUT_MS - RESPONSE_MARGIN_MS
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

/**
 * The handle reached its receipt after a hand-over: acknowledged, with a settled attempt on each carrier
 * (D56). Which copy the receiver delivered is the receiver's own evidence.
 */
export function toHandedOverAssertions(
    sender: AlmConformanceStepInput,
    resultName: string
): readonly RallarBlackBoxTestCommand[] {
    return [
        toResultAssertion({
            step: sender,
            name: 'assert-acknowledged-1',
            resultName,
            field: 'state',
            operator: 'equals',
            expected: 'acknowledged'
        }),
        ...(['rtc', 'ws'] as const).map((carrier) =>
            toResultAssertion({
                step: sender,
                name: `assert-${carrier}-attempt-1`,
                resultName,
                field: 'attemptCarriers',
                operator: 'contains',
                expected: carrier
            })
        )
    ];
}

/**
 * An addressed send's receipt names one recipient, its addressee (Q11). Which session that is, the identity
 * assessment joins after the run.
 */
export function toAddresseeReceiptAssertions(
    sender: AlmConformanceStepInput,
    resultName: string
): readonly RallarBlackBoxTestCommand[] {
    const facts = [
        ['state', 'acknowledged'],
        ['receiptMode', 'receiver'],
        ['expectedRecipientPeerIds.length', 1],
        ['confirmedRecipientPeerIds.length', 1]
    ] as const;
    return facts.map(([field, expected]) =>
        toResultAssertion({
            step: sender,
            name: `assert-addressee-${field.replace('.length', '-count')}-1`,
            resultName,
            field,
            operator: 'equals',
            expected
        })
    );
}

export function toStorageCountersCommand(
    step: AlmConformanceStepInput,
    name: string,
    reset: boolean
): RallarBlackBoxTestCommand {
    return {
        kind: 'storage.counters',
        commandId: toCommandId(step, name),
        reset,
        timeoutMs: toBudgetMs(STORAGE_COUNTERS_TIMEOUT_MS, step.input.deadlineMs)
    };
}
