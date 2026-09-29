import {
    AL_VOLATILE_SESSION_INBOUND_COUNTED_LIFETIME_MS,
    AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    type ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import {
    CONNECT_READINESS_TIMEOUT_MS,
    NON_EXPIRING_SEND_TIMEOUT_MS,
    NON_EXPIRING_TTL_MS,
    RESPONSE_MARGIN_MS
} from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import {
    toAdmissionCommands,
    toObserveCommand,
    toResultAssertion,
    toSendCommand
} from '../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';
import { toConnectCommand } from '../alm-conformance-session-commands.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';

/**
 * The scenario is deterministic only while 2 * S + B < maxBytes < 3 * S, where S is one send's envelope (the filler
 * plus about 0.7 KB of envelope, about 55.7 KB) and B is the platform's own state sync the lowered session admits
 * inbound when the reconnect joins the room again (the close keeps the membership): `group-state.event`,
 * `client-state.snapshot` and `event`, 6 entries and about 26 KB in a fresh two-member room, each counted for at most
 * 30 s. The sender waits that long after the reconnect before its first send, so B has left the budget however large
 * a long-lived hosted room makes it. The admitted sends stay counted until their 30 s deadline, so the third never
 * fits (about 167.2 KB > 163.8 KB), and the second keeps about 52 KB of headroom for state sync that arrives during
 * the sends. The count bound keeps its constant, so bytes alone decide.
 */
const CAPACITY_FILLER = 'x'.repeat(55_000);
const CAPACITY_LIMITS: ALVolatileSessionLimits = {
    maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    maxBytes: 160 * 1024
};
const REJOIN_SETTLE_MS = AL_VOLATILE_SESSION_INBOUND_COUNTED_LIFETIME_MS + 1_000;
const REJOIN_SETTLE_TOPIC = 'rallar.black-box.alm.capacity-rejoin-settled';
const ADMITTED_INDEXES = [1, 2] as const;
const REFUSED_INDEX = 3;
const REFUSAL = [['failure.kind', 'refused'], ['failure.reason', 'capacity'], ['attempts', 0]] as const;

/**
 * D74 and D78: the sender reconnects under a lowered bound, sends up to it, and the next send ends `rejected` with
 * `refused`/`capacity` and no carrier attempt, so no fallback; the admitted sends are still acknowledged. A session
 * reads its bound once, when it initialises, so the sender closes first and reconnects without the field after.
 */
export const capacity: AlmConformanceScenarioDefinition = {
    scenarioId: 'capacity',
    scenarioKey: 'capacity',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'addressed',
    toSenderCommands: toCapacitySenderCommands,
    toRecipientCommands: toCapacityReceiverCommands
};

function toCapacitySenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toReconnectCommands(sender, 'lowered', CAPACITY_LIMITS),
        toRejoinSettleWait(sender),
        ...ADMITTED_INDEXES.flatMap((
            index
        ) => [toCapacitySend(sender, index), ...toAdmissionCommands({ ...sender, index })]),
        toCapacitySend(sender, REFUSED_INDEX),
        toObserveCommand({ ...sender, index: REFUSED_INDEX, state: 'rejected' }),
        toResultAssertion({
            step: sender,
            name: `assert-status-${REFUSED_INDEX}`,
            resultName: `send-${REFUSED_INDEX}`,
            field: 'status',
            operator: 'equals',
            expected: 'rejected'
        }),
        ...REFUSAL.map(([field, expected]) =>
            toResultAssertion({
                step: sender,
                name: `assert-${field.replace('.', '-')}-${REFUSED_INDEX}`,
                resultName: `observe-rejected-${REFUSED_INDEX}`,
                field,
                operator: 'equals',
                expected
            })
        ),
        ...ADMITTED_INDEXES.flatMap((index) => toAcknowledgedCommands(sender, index)),
        ...toReconnectCommands(sender, 'restored', undefined)
    ];
}

function toReconnectCommands(
    sender: AlmConformanceStepInput,
    name: 'lowered' | 'restored',
    limits: ALVolatileSessionLimits | undefined
): readonly RallarBlackBoxTestCommand[] {
    const connect = toConnectCommand(sender);
    return [
        { kind: 'close', commandId: toCommandId(sender, `close-before-${name}`) },
        {
            ...connect,
            commandId: toCommandId(sender, `connect-${name}`),
            rallar: limits === undefined
                ? connect.rallar
                : {
                    ...connect.rallar,
                    almVolatileLimits: {
                        maxAdmissions: limits.maxAdmissions,
                        maxBytes: limits.maxBytes
                    }
                }
        }
    ];
}

/** Holds the whole window: nothing emits the topic, so it only lets the rejoin's state sync leave the budget. */
function toRejoinSettleWait(sender: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(sender, 'rejoin-settles'),
        match: { kind: 'diagnostic', topic: REJOIN_SETTLE_TOPIC },
        absent: true,
        timeoutMs: REJOIN_SETTLE_MS
    };
}

function toCapacitySend(sender: AlmConformanceStepInput, index: number): RallarBlackBoxTestCommand {
    return toSendCommand({
        ...sender,
        index,
        payload: {
            marker: sender.scenarioId,
            carrier: sender.input.carrier,
            index,
            filler: CAPACITY_FILLER
        },
        delivery: {
            ack: 'receiver',
            ttlMs: NON_EXPIRING_TTL_MS,
            commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
        }
    });
}

function toAcknowledgedCommands(
    sender: AlmConformanceStepInput,
    index: number
): readonly RallarBlackBoxTestCommand[] {
    return [
        toObserveCommand({ ...sender, index, state: 'acknowledged' }),
        toResultAssertion({
            step: sender,
            name: `assert-acknowledged-${index}`,
            resultName: `observe-acknowledged-${index}`,
            field: 'state',
            operator: 'equals',
            expected: 'acknowledged'
        })
    ];
}

/** The receiver's window opens before the sender's reconnect, so it also owns one RTC readiness budget and the wait. */
function toCapacityReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    const timeoutMs = receiver.input.deadlineMs + NON_EXPIRING_SEND_TIMEOUT_MS +
        CONNECT_READINESS_TIMEOUT_MS + REJOIN_SETTLE_MS;
    return [{
        ...toReceivedCommand({
            ...receiver,
            index: 1,
            count: ADMITTED_INDEXES.length,
            absent: false
        }),
        windowMs: timeoutMs - RESPONSE_MARGIN_MS,
        timeoutMs
    }];
}
