import { AL_CONTROL_REPAIR_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';

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
 * No receiver asked this page to repair anything: no gap NACK about the cell's tracks and no repair control reached
 * it, whatever its admission made of either (every outcome states the event). A receiver sends a `missing-seq` repair
 * control beside a gap NACK, or beside an `expired` or `overloaded` NACK for a copy that also opens a gap, and a
 * `retransmit` control with no NACK when it owns a child it cannot reach (`planRepair`, `toRepairEffects`). The origin
 * repairs on whichever of a gap NACK and its control it admits first, so both are read. A repair control's event
 * names neither its reason nor its track, so that absence covers every track. A timer's retransmission (a first hop
 * or a receipt that timed out) admits no control and is no repair request. The first wait listens one window; the
 * second reads the cell's history, that window included. A minted send names no index to pin either by.
 */
export function toNoRepairRequestWaits(step: AlmConformanceStepInput): readonly RallarBlackBoxTestWaitCommand[] {
    const noGapNack = toGapNackWait({ step, name: 'no-gap-nack', orderingKey: step.scenarioKey, absent: true });
    const noRepairControl = toDiagnosticWait({
        step,
        name: 'no-repair-control',
        topic: ALM_OUTBOUND_DIAGNOSTICS_TOPIC,
        historyFrom: 'cell',
        payloadFields: { 'data.kind': 'control-admission', 'data.typeId': AL_CONTROL_REPAIR_TYPE_ID },
        absent: true
    });
    return [noGapNack, { ...noRepairControl, timeoutMs: 0 }];
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

function toRepairDispatchText(step: AlmConformanceStepInput): string {
    return `"typeId":"${toScenarioTypeId(step)}","origin":"repair"`;
}
