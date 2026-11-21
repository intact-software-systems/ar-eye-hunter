import type { RallarBlackBoxTestWaitCommand } from '../../rallar-black-box-test-contracts.ts';

import {
    ALM_OUTBOUND_DIAGNOSTICS_TOPIC,
    toDiagnosticWait,
    toSentMsgIdReference
} from './alm-conformance-diagnostic-waits.ts';
import type { AlmConformanceMessageStepInput, AlmConformanceStepInput } from './alm-conformance-scenario-definition.ts';
import { toScenarioTypeId } from './alm-conformance-step-identities.ts';

interface AlmConformanceGapNackWaitInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    /** The tracks' ordering key; a NACK names a track `<ordering key>:<sender peer id>`, unknown when authored. */
    readonly orderingKey: string;
    readonly absent: boolean;
}

/**
 * The `commit-phases` event of the retransmission a repair hint dispatched for the send of `step.index`, matched in
 * its emitted key order (`msgId`, `typeId`, `origin`); the sender's peer id precedes them and is unknown when the
 * recipe is authored. The commit states the event whether or not its frame then leaves, so a hold on the frame does
 * not hide the dispatch.
 */
export function toRepairDispatchWait(
    step: AlmConformanceMessageStepInput,
    name: string
): RallarBlackBoxTestWaitCommand {
    return toDiagnosticWait({
        step,
        name,
        topic: ALM_OUTBOUND_DIAGNOSTICS_TOPIC,
        historyFrom: 'cell',
        contains: `"msgId":"${toSentMsgIdReference(step)}",${toRepairDispatchText(step)}`
    });
}

/**
 * No repair dispatched any message of the cell's type from this page, and no gap NACK about the cell's tracks reached
 * it, whatever its origin made of one: a NACK whose repair was refused dispatches nothing, yet its admission states
 * the NACK's reason and track. The first wait listens one window; the second reads the cell's history, that window
 * included.
 * A minted send names no index to pin either by.
 */
export function toNoGapRepairWaits(step: AlmConformanceStepInput): readonly RallarBlackBoxTestWaitCommand[] {
    const noGapNack = toGapNackWait({ step, name: 'no-gap-nack', orderingKey: step.scenarioKey, absent: true });
    return [toNoRepairDispatchWait(step, 'no-repair-dispatch'), { ...noGapNack, timeoutMs: 0 }];
}

/**
 * The page admitted a gap NACK about one of its tracks on `orderingKey`, whatever its origin made of it, from the cell's
 * history on: some hop saw a later sequence of the track before an earlier one. `absent`, no such NACK reached it.
 */
export function toGapNackWait(
    { step, name, orderingKey, absent }: AlmConformanceGapNackWaitInput
): RallarBlackBoxTestWaitCommand {
    return toDiagnosticWait({
        step,
        name,
        topic: ALM_OUTBOUND_DIAGNOSTICS_TOPIC,
        historyFrom: 'cell',
        contains: `"nackReason":"gap","nackOrderingKey":"${orderingKey}:`,
        absent
    });
}

/** No repair dispatched any message of the cell's type from this page: a minted send names no index to pin it by. */
function toNoRepairDispatchWait(step: AlmConformanceStepInput, name: string): RallarBlackBoxTestWaitCommand {
    return toDiagnosticWait({
        step,
        name,
        topic: ALM_OUTBOUND_DIAGNOSTICS_TOPIC,
        historyFrom: 'cell',
        contains: toRepairDispatchText(step),
        absent: true
    });
}

function toRepairDispatchText(step: AlmConformanceStepInput): string {
    return `"typeId":"${toScenarioTypeId(step)}","origin":"repair"`;
}
