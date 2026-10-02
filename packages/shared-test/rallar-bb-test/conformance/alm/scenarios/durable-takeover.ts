import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { CONNECT_TIMEOUT_MS, NON_EXPIRING_SEND_TIMEOUT_MS } from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import { toHeldFaultCommands } from '../alm-conformance-fault-commands.ts';
import {
    toResultAssertion,
    toRetainedEvidenceCommands,
    toSendCommand
} from '../alm-conformance-message-commands.ts';
import { toPayloadWait, toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';
import {
    toOriginalStorePrefix,
    toRecoveryTtlMs,
    toStoreRecoveryWait
} from '../alm-conformance-session-commands.ts';

/**
 * One durable owner per session: the sender's page admits a durable send it cannot deliver and closes, and the
 * successor, a second page of the same browser context and session, connects once that page's lease has lapsed, takes
 * the session's durable work over, reports the original's store restored with the row claimed, and delivers the
 * original once.
 */
export const durableTakeover: AlmConformanceScenarioDefinition = {
    scenarioId: 'durable-takeover',
    scenarioKey: 'durable-takeover',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver', 'successor'],
    laneFamily: 'same-context',
    toSenderCommands: (page) => page.role === 'successor' ? toSuccessorCommands(page) : toOwnerCommands(page),
    toRecipientCommands: toDurableTakeoverReceiverCommands
};

/** The native hold ends only with the owner's page, so no attempt of the owner ever leaves it. */
function toOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toHeldFaultCommands(owner, 'takeover-hold', 'until-cleared'),
        toSendCommand({
            ...owner,
            index: 1,
            payload: toPayload(owner),
            delivery: {
                ack: 'receiver',
                durability: 'local-outbox',
                ttlMs: toRecoveryTtlMs(owner.input.deadlineMs),
                commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
            }
        }),
        ...toRetainedEvidenceCommands({ ...owner, index: 1 }, true)
    ];
}

/** The takeover's first batch claims the original from the store that held it; the recovery it reports says so. */
function toSuccessorCommands(successor: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toStoreRecoveryWait(successor, {
            name: 'recovered-original-store',
            storeIdPrefix: toOriginalStorePrefix(successor.input.carrier),
            lane: '',
            connectName: 'connect',
            timeoutMs: toRecoveryTtlMs(successor.input.deadlineMs)
        }),
        toResultAssertion({
            step: successor,
            name: 'assert-recovered-claimed',
            resultName: 'recovered-original-store',
            field: 'event.payload.data.outcome.claimed',
            operator: 'gt',
            expected: 0
        })
    ];
}

/**
 * Over `ws` the arrival wait starts before the sender connects, so it covers that connect and the original's whole
 * lifetime; over the RTC carriers the receiver's connect waits for one ready peer, so the wait starts once the owner is
 * ready and its budget only grows more generous. The trailing window proves no second copy follows the first.
 */
function toDurableTakeoverReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        {
            ...toPayloadWait({ step: receiver, name: 'receive-original', payload: toPayload(receiver), absent: false }),
            timeoutMs: CONNECT_TIMEOUT_MS + toRecoveryTtlMs(receiver.input.deadlineMs)
        },
        toReceivedCommand({ ...receiver, index: 1, count: 2, absent: true })
    ];
}

/** The payload names its carrier, so a wait never matches another carrier's cell. */
function toPayload(step: AlmConformanceStepInput): Readonly<Record<string, string>> {
    return { marker: step.scenarioId, carrier: step.input.carrier };
}
