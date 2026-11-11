import type { ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import type { ALReceiptProofRefusal } from '@shared/al-contracts/receipt-proof/al-receipt-proof.ts';
import type { ALInboundOrderingPosition } from '@shared/alm/inbound/admission/to-al-inbound-ordering-position.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import type { RallarBlackBoxTestWaitCommand } from '../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, RESPONSE_MARGIN_MS } from './alm-conformance-budgets.ts';
import type { AlmConformanceMessageStepInput, AlmConformanceStepInput } from './alm-conformance-scenario-definition.ts';
import { toCommandId, toScenarioTypeId } from './alm-conformance-step-identities.ts';
import { SUBSCRIPTION_ABSENCE_MS } from './scenarios/topic-subscription/topic-subscription-polls.ts';

/** The page's runtime diagnostics topics; an event's `data` is the runtime event itself, in its emitted key order. */
export const ALM_OUTBOUND_DIAGNOSTICS_TOPIC = 'rallar.browser.alm.outbound_diagnostics';
export const ALM_INBOUND_DIAGNOSTICS_TOPIC = 'rallar.browser.alm.inbound_diagnostics';
export const ALM_STORAGE_DIAGNOSTICS_TOPIC = 'rallar.browser.alm.storage';

export type AlmConformanceDiagnosticsTopic =
    | typeof ALM_OUTBOUND_DIAGNOSTICS_TOPIC
    | typeof ALM_INBOUND_DIAGNOSTICS_TOPIC
    | typeof ALM_STORAGE_DIAGNOSTICS_TOPIC;

interface AlmConformanceDiagnosticWaitInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    readonly topic: AlmConformanceDiagnosticsTopic;
    /**
     * A substring of the event's serialised `data`, so it must follow the emitted key order; absent, `payloadFields`
     * alone scopes the match, for a page whose lanes hear one tracked topic only.
     */
    readonly contains?: string;
    /** Exact values at paths of the event, whatever their key order; `data.kind` names the event. */
    readonly payloadFields?: Readonly<Record<string, ApiJsonValue>>;
    /** The page states no such event before the wait or within `SUBSCRIPTION_ABSENCE_MS` of its start. */
    readonly absent?: boolean;
}

interface AlmConformanceOrderingPositionTrack {
    readonly name: string;
    readonly status: ALInboundOrderingPosition['status'];
    /**
     * The track's key up to its epoch, `<ordering key>:<sender peer id>`. The peer id is unknown when the recipe is
     * authored, so it is a result reference to an arrival the page received from that sender.
     */
    readonly track: string;
}

/** The event the page states, at `priorSeq`; or, `absent`, no event of the status on the track, whatever its prior. */
type AlmConformanceOrderingPositionWaitInput =
    | (AlmConformanceOrderingPositionTrack & { readonly priorSeq: number | null; })
    | (AlmConformanceOrderingPositionTrack & { readonly absent: true; });

interface AlmConformanceControlAdmissionWaitInput {
    readonly step: AlmConformanceMessageStepInput;
    readonly name: string;
    /** The control that answers the send of `step.index`. */
    readonly controlTypeId: string;
    /** The admission outcome to match; `undefined` matches the control's arrival, whatever the origin made of it. */
    readonly outcome: 'committed' | undefined;
    /** A committed receipt's phase to match; absent, any admission of the control matches (a receipt's first). */
    readonly receiptPhase?: ALReceiptPayload['phase'];
}

interface AlmConformanceControlProofRefusalWaitInput {
    readonly step: AlmConformanceMessageStepInput;
    readonly name: string;
    /** The raw control's authored msgId; it may name result references, which `contains` resolves. */
    readonly controlMsgId: string;
    readonly controlTypeId: string;
    readonly proofRefusal: ALReceiptProofRefusal['kind'];
}

/**
 * One runtime diagnostic event of the page that runs the step. The diagnostics carry no connection to route on, so
 * the text must scope the match itself. The wait starts before the other role's sends, so it owns the verdict budget.
 */
export function toDiagnosticWait(
    { step, name, topic, contains, payloadFields, absent }: AlmConformanceDiagnosticWaitInput
): RallarBlackBoxTestWaitCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(step, name),
        match: {
            kind: 'diagnostic',
            topic,
            payloadPath: 'data',
            ...(contains === undefined ? {} : { contains }),
            ...(payloadFields === undefined ? {} : { payloadFields })
        },
        ...(absent === true ? { absent: true } : {}),
        timeoutMs: absent === true ? SUBSCRIPTION_ABSENCE_MS : toVerdictTimeoutMs(step.input.deadlineMs)
    };
}

/**
 * The `ordering-position` event the page's inbound admission states after its commit, for one sender's track. Its
 * `workerId` names the inbound lane's worker, not the arrival, so the track and the position identify the event.
 */
export function toOrderingPositionWait(
    step: AlmConformanceStepInput,
    position: AlmConformanceOrderingPositionWaitInput
): RallarBlackBoxTestWaitCommand {
    const kind = { 'data.kind': 'ordering-position', 'data.status': position.status };
    return toDiagnosticWait({
        step,
        name: position.name,
        topic: ALM_INBOUND_DIAGNOSTICS_TOPIC,
        contains: `"trackKey":"${position.track}:`,
        ...('absent' in position
            ? { payloadFields: kind, absent: true }
            : { payloadFields: { ...kind, 'data.priorSeq': position.priorSeq } })
    });
}

/**
 * The `control-admission` event in which the origin admits a control that answers one of its sends, matched in its
 * emitted key order (`typeId`, `targetMsgId`, `outcome`, then a receipt's `phase` after the `reason`). The verdict is
 * local to the origin, so the wait polls no other page.
 */
export function toControlAdmissionWait(
    { step, name, controlTypeId, outcome, receiptPhase }: AlmConformanceControlAdmissionWaitInput
): RallarBlackBoxTestWaitCommand {
    const admitted = outcome === undefined ? '' : `,"outcome":"${outcome}"`;
    const phase = receiptPhase === undefined ? '' : `,"reason":"none","phase":"${receiptPhase}"`;
    return toDiagnosticWait({
        step,
        name,
        topic: ALM_OUTBOUND_DIAGNOSTICS_TOPIC,
        contains: `"typeId":"${controlTypeId}","targetMsgId":"${toSentMsgIdReference(step)}"${admitted}${phase}`
    });
}

/**
 * The origin's `rejected` admission of one raw control whose proof it refused, whatever issue its reason names first
 * (a duplicate issue can precede the proof issue), so the refusal kind is matched on the event's `proofRefusal` field.
 */
export function toControlProofRefusalWait(
    { step, name, controlMsgId, controlTypeId, proofRefusal }: AlmConformanceControlProofRefusalWaitInput
): RallarBlackBoxTestWaitCommand {
    return toDiagnosticWait({
        step,
        name,
        topic: ALM_OUTBOUND_DIAGNOSTICS_TOPIC,
        contains:
            `"msgId":"${controlMsgId}","typeId":"${controlTypeId}","targetMsgId":"${toSentMsgIdReference(step)}",` +
            '"outcome":"rejected","reason":"',
        payloadFields: { 'data.kind': 'control-admission', 'data.proofRefusal': proofRefusal }
    });
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
        contains: `"msgId":"${toSentMsgIdReference(step)}",${toRepairDispatchText(step)}`
    });
}

/**
 * No repair dispatched any message of the cell's type from this page, and no gap NACK about the cell's tracks reached
 * it, whatever its origin made of one: a NACK whose repair was refused dispatches nothing, yet its admission states
 * the NACK's reason and track. The first wait listens one window, the second reads the history that window kept.
 * A minted send names no index to pin either by.
 */
export function toNoGapRepairWaits(step: AlmConformanceStepInput): readonly RallarBlackBoxTestWaitCommand[] {
    const noGapNack = toDiagnosticWait({
        step,
        name: 'no-gap-nack',
        topic: ALM_OUTBOUND_DIAGNOSTICS_TOPIC,
        contains: `"nackReason":"gap","nackOrderingKey":"${step.scenarioKey}:`,
        absent: true
    });
    return [toNoRepairDispatchWait(step, 'no-repair-dispatch'), { ...noGapNack, timeoutMs: 0 }];
}

/** No repair dispatched any message of the cell's type from this page: a minted send names no index to pin it by. */
function toNoRepairDispatchWait(step: AlmConformanceStepInput, name: string): RallarBlackBoxTestWaitCommand {
    return toDiagnosticWait({
        step,
        name,
        topic: ALM_OUTBOUND_DIAGNOSTICS_TOPIC,
        contains: toRepairDispatchText(step),
        absent: true
    });
}

function toRepairDispatchText(step: AlmConformanceStepInput): string {
    return `"typeId":"${toScenarioTypeId(step)}","origin":"repair"`;
}

/** The message id the send of `step.index` returned, resolved from the result cache when the wait is armed. */
export function toSentMsgIdReference(step: AlmConformanceMessageStepInput): string {
    return `{resultCache.${toCommandId(step, `send-${step.index}`)}.value.msgId}`;
}

/**
 * A wait for a verdict the page states on its own diagnostics starts before the other role's sends, so it owns the
 * evidence deadline and the whole non-expiring send budget, less the margin the recipe keeps to report.
 */
export function toVerdictTimeoutMs(deadlineMs: number): number {
    return deadlineMs + NON_EXPIRING_SEND_TIMEOUT_MS - RESPONSE_MARGIN_MS;
}
