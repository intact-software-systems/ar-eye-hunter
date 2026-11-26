import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { CONNECT_TIMEOUT_MS, NON_EXPIRING_SEND_TIMEOUT_MS } from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import { toHeldFaultCommands } from '../alm-conformance-fault-commands.ts';
import {
    toCancelCommand,
    toReceiptsCommand,
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
import { toCommandId } from '../alm-conformance-step-identities.ts';
import { toPauseCommand } from '../to-pause-command.ts';

const HAND_OVER_POLL_INTERVAL_MS = 200;
/**
 * How long the owner keeps its page after the cancel, so the cancel reaches storage before the page dies: `cancel()`
 * returns before its end is stored (D754), and a hosted runner closed the page 65 ms after it with nothing stored
 * (D763). The page still closes inside the message's 2 s receipt timer, which the proof needs.
 */
const CANCEL_STORAGE_WINDOW_MS = 750;
const ORIGINAL_MARKER = 'durable-takeover';
const CANCELLED_MARKER = 'durable-takeover-cancelled';

type TakeoverMarker = typeof ORIGINAL_MARKER | typeof CANCELLED_MARKER;

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

/**
 * The native hold ends only with the owner's page, so no attempt of the owner ever leaves it. Over the fallback
 * carrier the owner's recipe ends only once its held RTC attempts have handed the original to WS and a WS attempt is
 * recorded, which the hold keeps too, so the row the successor restores is committed in the WS client store. The
 * owner's last commands send and cancel a second durable message.
 */
function toOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toHeldFaultCommands(owner, 'takeover-hold', 'until-cleared'),
        toDurableSend(owner, 1, ORIGINAL_MARKER),
        ...toRetainedEvidenceCommands({ ...owner, index: 1 }, true),
        ...(owner.input.carrier === 'rtc-with-ws-fallback' ? [toHandOverPoll(owner)] : []),
        ...toCancelledBeforeCloseCommands(owner)
    ];
}

/**
 * The cancel is the owner's last message command. Its page stays for `CANCEL_STORAGE_WINDOW_MS` and closes a few
 * hundred milliseconds later, before the message's 2 s receipt timer (`first-hop-timeout` over WS, `ack-timeout` over
 * RTC) comes due. Only a stored end keeps that timer row from the successor: it would find the cancelled send's row
 * gone, charge the attempt and send it again.
 */
function toCancelledBeforeCloseCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toDurableSend(owner, 2, CANCELLED_MARKER),
        ...toRetainedEvidenceCommands({ ...owner, index: 2 }, true),
        toCancelCommand({ ...owner, index: 2 }),
        toResultAssertion({
            step: owner,
            name: 'assert-cancelled-2',
            resultName: 'cancel-2',
            field: 'state',
            operator: 'equals',
            expected: 'cancelled'
        }),
        toPauseCommand(owner, 'cancel-reaches-storage', CANCEL_STORAGE_WINDOW_MS)
    ];
}

function toDurableSend(
    owner: AlmConformanceStepInput,
    index: number,
    marker: TakeoverMarker
): RallarBlackBoxTestCommand {
    return toSendCommand({
        ...owner,
        index,
        payload: toPayload(owner, marker),
        delivery: {
            ack: 'receiver',
            durability: 'local-outbox',
            ttlMs: toRecoveryTtlMs(owner.input.deadlineMs),
            commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
        }
    });
}

/**
 * The hand-over changes no delivery state, so the owner reads its receipt until its carrier-fallback evidence names WS
 * and a WS attempt follows, within the budget a fallback send gets to reach its WS copy. The evidence is recorded
 * before the RTC receipt ends and the WS leg is admitted, in two later transactions; a WS attempt exists only once the
 * WS row is committed and claimed. Each read is the loop child of its iteration.
 */
function toHandOverPoll(owner: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    const name = 'await-hand-over-1';
    const receipts = { ...owner, index: 1 };
    const resultName = `${name}:i{loop.iteration}:c1:${toCommandId(receipts, 'receipts-1')}`;
    return {
        kind: 'loop',
        commandId: toCommandId(owner, name),
        until: 'first-success',
        count: NON_EXPIRING_SEND_TIMEOUT_MS / HAND_OVER_POLL_INTERVAL_MS,
        intervalMs: HAND_OVER_POLL_INTERVAL_MS,
        commands: [
            toReceiptsCommand(receipts),
            toResultAssertion({
                step: owner,
                name: 'assert-handed-over-to-ws-1',
                resultName,
                field: 'carrierFallback.to',
                operator: 'equals',
                expected: 'ws'
            }),
            toResultAssertion({
                step: owner,
                name: 'assert-ws-attempt-1',
                resultName,
                field: 'attemptCarriers',
                operator: 'contains',
                expected: 'ws'
            })
        ]
    };
}

/** The takeover's first batch claims the original from the store that held it; the recovery it reports says so. */
function toSuccessorCommands(successor: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toStoreRecoveryWait(successor, {
            name: 'recovered-original-store',
            storeIdPrefix: toOriginalStorePrefix(successor.input.carrier),
            lane: '',
            connectName: 'connect',
            historyFrom: 'page',
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
 * ready and its budget only grows more generous. The successor's first batch would send the cancelled message beside
 * the original, so its absence follows the original's arrival and also reads arrivals retained before it. The
 * trailing window proves no second copy follows the first.
 */
function toDurableTakeoverReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        {
            ...toPayloadWait({
                step: receiver,
                name: 'receive-original',
                payload: toPayload(receiver, ORIGINAL_MARKER),
                absent: false
            }),
            timeoutMs: CONNECT_TIMEOUT_MS + toRecoveryTtlMs(receiver.input.deadlineMs)
        },
        toPayloadWait({
            step: receiver,
            name: 'absent-cancelled',
            payload: toPayload(receiver, CANCELLED_MARKER),
            absent: true
        }),
        toReceivedCommand({ ...receiver, index: 1, count: 2, absent: true })
    ];
}

/** The payload names its carrier, so a wait never matches another carrier's cell. */
function toPayload(step: AlmConformanceStepInput, marker: TakeoverMarker): Readonly<Record<string, string>> {
    return { marker, carrier: step.input.carrier };
}
