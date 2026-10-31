import type {
    RallarBlackBoxTestMessagesReceivedCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import {
    CONNECT_READINESS_TIMEOUT_MS,
    NON_EXPIRING_SEND_TIMEOUT_MS,
    RESPONSE_MARGIN_MS
} from '../../alm-conformance-budgets.ts';
import { toPayloadWait, toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId, toScenarioTypeId } from '../../alm-conformance-step-identities.ts';
import { PUBLICATION_CADENCE_MS } from './publication-commands.ts';

/**
 * A `not-yet` read's window, counted from the arrival before it. The local lane at one cadence counted from the read's
 * start went red on every cell and carrier: the read starts after that arrival, so its window spans the next
 * opportunity's arrival, which then violates the absence. Half a cadence leaves half a cadence each side.
 */
const PUBLICATION_NOT_YET_WINDOW_MS = PUBLICATION_CADENCE_MS / 2;

/** Two cadences past the last expected arrival, so a value a later opportunity carried would arrive inside it. */
const PUBLICATION_NO_FURTHER_ARRIVAL_WINDOW_MS = 2 * PUBLICATION_CADENCE_MS;

/**
 * The receiver holds `count` arrivals of the cell's type, the last carried by the `opportunity`-th boundary after the
 * lead's admission: the window opens before the sender's prologue, so it spans the sender's whole send budget, that
 * boundary, and one cadence more.
 */
export function toArrivalCountCommand(
    receiver: AlmConformanceStepInput,
    count: number,
    opportunity: number
): RallarBlackBoxTestMessagesReceivedCommand {
    // Receiver observation starts before sender setup; include its bounded RTC settling time.
    // Publication admission, TTL and negative-arrival windows keep their own unchanged budgets.
    const timeoutMs = receiver.input.deadlineMs + NON_EXPIRING_SEND_TIMEOUT_MS +
        (receiver.input.carrier === 'ws' ? 0 : CONNECT_READINESS_TIMEOUT_MS) +
        (opportunity + 1) * PUBLICATION_CADENCE_MS;
    return {
        ...toReceivedCommand({ ...receiver, index: count, count, absent: false }),
        windowMs: timeoutMs - RESPONSE_MARGIN_MS,
        timeoutMs
    };
}

/** No arrival past the `count - 1` the receiver holds within `windowMs`, which opens at the last expected one. */
export function toNoFurtherArrivalCommand(
    receiver: AlmConformanceStepInput,
    count: number
): RallarBlackBoxTestMessagesReceivedCommand {
    return {
        ...toReceivedCommand({ ...receiver, index: count, count, absent: true }),
        windowMs: PUBLICATION_NO_FURTHER_ARRIVAL_WINDOW_MS,
        timeoutMs: PUBLICATION_NO_FURTHER_ARRIVAL_WINDOW_MS + RESPONSE_MARGIN_MS
    };
}

/** The specimen carrying `seq` has arrived; its wait's result holds the arrival's own `atEpochMs`. */
export function toSeqArrivalWait(receiver: AlmConformanceStepInput, seq: number): RallarBlackBoxTestWaitCommand {
    return toSeqWait(receiver, seq, 'arrived');
}

/**
 * The specimen carrying `seq` is still absent half a cadence after the arrival of `afterSeq`, which the receiver awaited
 * right before: the window counts from that arrival's own epoch (D481), so it orders that arrival before the specimen a
 * later opportunity carries, about one cadence after it. A window opened when the read starts would span the next
 * boundary, and a receiver that reads late checks the window against its history at once.
 */
export function toSeqNotYetWait(
    receiver: AlmConformanceStepInput,
    seq: number,
    afterSeq: number
): RallarBlackBoxTestWaitCommand {
    return {
        ...toSeqWait(receiver, seq, 'not-yet'),
        timeoutFrom: `{resultCache.${toCommandId(receiver, toSeqWaitName(afterSeq, 'arrived'))}.value.event.atEpochMs}`,
        timeoutMs: PUBLICATION_NOT_YET_WINDOW_MS
    };
}

function toSeqWait(
    receiver: AlmConformanceStepInput,
    seq: number,
    expectation: 'arrived' | 'not-yet'
): RallarBlackBoxTestWaitCommand {
    const wait = toPayloadWait({
        step: receiver,
        name: toSeqWaitName(seq, expectation),
        payload: { specimen: 'paced', seq },
        absent: expectation === 'not-yet'
    });
    return { ...wait, match: { ...wait.match, payloadFields: { 'data.typeId': toScenarioTypeId(receiver) } } };
}

function toSeqWaitName(seq: number, expectation: 'arrived' | 'not-yet'): string {
    return `${expectation}-seq-${seq}`;
}
