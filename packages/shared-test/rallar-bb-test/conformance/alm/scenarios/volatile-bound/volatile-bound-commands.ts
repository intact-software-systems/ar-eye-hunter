import type {
    ALVolatileSessionLimit,
    ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesReceivedCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import {
    CONNECT_READINESS_TIMEOUT_MS,
    NON_EXPIRING_SEND_TIMEOUT_MS,
    RESPONSE_MARGIN_MS
} from '../../alm-conformance-budgets.ts';
import { toObserveCommand, toResultAssertion } from '../../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toConnectCommand } from '../../alm-conformance-session-commands.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';

/** One field the refused send's observation states, and the value it must hold. */
export type AlmVolatileBoundRefusalFact = readonly [field: string, expected: string | number];

/** The refusal of a send the session's volatile bound turned away: no carrier attempt, so no fallback. */
export const VOLATILE_BOUND_REFUSAL_FACTS: readonly AlmVolatileBoundRefusalFact[] = [
    ['failure.kind', 'refused'],
    ['failure.reason', 'capacity'],
    ['attempts', 0]
];

/** That refusal, naming the bound of the session ledger the send would pass. */
export function toLimitRefusalFacts(limit: ALVolatileSessionLimit): readonly AlmVolatileBoundRefusalFact[] {
    return [...VOLATILE_BOUND_REFUSAL_FACTS, ['failure.limit', limit]];
}

/**
 * A session reads its bound once, when it initialises, so the sender closes first and reconnects with the lowered
 * limits, written as given; the page reads an age or track limit the override leaves out as its constant.
 * `restored` reconnects without the field.
 */
export function toBoundReconnectCommands(
    sender: AlmConformanceStepInput,
    name: 'lowered' | 'restored',
    limits:
        | (
            & Pick<ALVolatileSessionLimits, 'maxAdmissions' | 'maxBytes'>
            & Partial<Pick<ALVolatileSessionLimits, 'maxAgeMs' | 'maxTracks'>>
        )
        | undefined
): readonly RallarBlackBoxTestCommand[] {
    const connect = toConnectCommand(sender);
    return [
        { kind: 'close', commandId: toCommandId(sender, `close-before-${name}`) },
        {
            ...connect,
            commandId: toCommandId(sender, `connect-${name}`),
            rallar: limits === undefined ? connect.rallar : { ...connect.rallar, almVolatileLimits: { ...limits } }
        }
    ];
}

/** The send ends `rejected`, its command result says so, and each fact holds on the rejected observation. */
export function toBoundRefusalCommands(
    sender: AlmConformanceStepInput,
    index: number,
    facts: readonly AlmVolatileBoundRefusalFact[]
): readonly RallarBlackBoxTestCommand[] {
    return [
        toObserveCommand({ ...sender, index, state: 'rejected' }),
        toResultAssertion({
            step: sender,
            name: `assert-status-${index}`,
            resultName: `send-${index}`,
            field: 'status',
            operator: 'equals',
            expected: 'rejected'
        }),
        ...facts.map(([field, expected]) =>
            toResultAssertion({
                step: sender,
                name: `assert-${field.replace('.', '-')}-${index}`,
                resultName: `observe-rejected-${index}`,
                field,
                operator: 'equals',
                expected
            })
        )
    ];
}

export function toAcknowledgedCommands(
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

/**
 * The receiver's window opens before the sender's reconnect, so it also owns one RTC readiness budget and whatever
 * the sender waits after the reconnect before it sends.
 */
export function toReconnectedArrivalsCommand(
    receiver: AlmConformanceStepInput,
    count: number,
    settleMs: number
): RallarBlackBoxTestMessagesReceivedCommand {
    const timeoutMs = receiver.input.deadlineMs + NON_EXPIRING_SEND_TIMEOUT_MS + CONNECT_READINESS_TIMEOUT_MS +
        settleMs;
    return {
        ...toReceivedCommand({ ...receiver, index: 1, count, absent: false }),
        windowMs: timeoutMs - RESPONSE_MARGIN_MS,
        timeoutMs
    };
}
