import type { ALDurabilityAlgo } from '@shared/al-contracts/al-policy.ts';
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
    toCommandId,
    toConnectionName,
    toRoomRef,
    toScenarioTopicId,
    toScenarioTypeId,
    toSendHandleId
} from './alm-conformance-step-identities.ts';

interface AlmConformanceSendDelivery {
    readonly ttlMs?: number;
    /** Command budget when it must stay independent of `ttlMs`. */
    readonly commandTimeoutMs?: number;
    readonly ack?: 'receiver' | 'all-logical-recipients' | 'group-leader';
    /** Absent, the channel's purpose decides: at-least-once for both. */
    readonly reliability?: RallarBlackBoxTestMessagesSendCommand['reliability'];
    readonly durability?: Exclude<ALDurabilityAlgo, 'volatile'>;
    /** Absent, the channel refuses a durable send its storage cannot take. */
    readonly onStorageUnavailable?: 'refuse' | 'volatile';
    readonly orderingKey?: string;
    readonly seq?: number;
    readonly minSnapshotVersion?: RallarBlackBoxTestMessagesSendCommand['minSnapshotVersion'];
    /** Absent, the send addresses its room. */
    readonly toPeer?: RallarBlackBoxTestMessagesSendCommand['toPeer'];
    /** Absent, the room. */
    readonly scope?: RallarBlackBoxTestMessagesSendCommand['scope'];
    readonly principalId?: string;
    /** Absent, the send names no fixed audience. */
    readonly recipientPeer?: RallarBlackBoxTestMessagesSendCommand['recipientPeer'];
    /** Absent, the send is `shared`. */
    readonly ownership?: RallarBlackBoxTestMessagesSendCommand['ownership'];
    /** Absent, the product mints a fresh resource for the send. */
    readonly resourceId?: string;
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

interface AlmConformanceResultAssertionInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    readonly resultName: string;
    readonly field: string;
    readonly operator: 'equals' | 'matches' | 'gt' | 'contains' | 'exists';
    readonly expected: string | number | boolean;
}

/** One fact a scenario reads from the observation of its first send: the assertion name, the field, how and what. */
export type AlmConformanceVerdictFact = readonly [
    name: string,
    field: string,
    operator: 'exists' | 'equals',
    expected: string | number | boolean
];

const STORAGE_COUNTERS_TIMEOUT_MS = 3_000;
const OBSERVE_TIMEOUT_BASE_MS = 2_000;

export function toSendCommand(send: AlmConformanceSendInput): RallarBlackBoxTestMessagesSendCommand {
    const input = send.input;
    const typeId = toScenarioTypeId(send);
    const { commandTimeoutMs, ...delivery } = send.delivery;
    return {
        kind: 'messages.send',
        commandId: toCommandId(send, `send-${send.index}`),
        connection: toConnectionName(send),
        carrier: input.carrier,
        typeId,
        topicId: toScenarioTopicId(send),
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
        connection: toConnectionName(observe),
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
        connection: toConnectionName(cancel),
        handleId: toSendHandleId(cancel),
        timeoutMs: toBudgetMs(MESSAGE_CONTROL_TIMEOUT_MS, cancel.input.deadlineMs)
    };
}

export function toReceiptsCommand(receipts: AlmConformanceMessageStepInput): RallarBlackBoxTestCommand {
    return {
        kind: 'messages.receipts',
        commandId: toCommandId(receipts, `receipts-${receipts.index}`),
        connection: toConnectionName(receipts),
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

/** The first send's handle reaches `state`, and each fact holds on that observation. */
export function toVerdictCommands(
    sender: AlmConformanceStepInput,
    state: ALDeliveryState,
    facts: readonly AlmConformanceVerdictFact[]
): readonly RallarBlackBoxTestCommand[] {
    return [
        toObserveCommand({ ...sender, index: 1, state }),
        ...facts.map(([name, field, operator, expected]) =>
            toResultAssertion({
                step: sender,
                name: `assert-${name}-1`,
                resultName: `observe-${state}-1`,
                field,
                operator,
                expected
            })
        )
    ];
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
 * An addressed send's receipt names one recipient, its addressee. Which session that is, the identity
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
