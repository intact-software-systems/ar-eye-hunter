import type { ALReceiptPayload } from '@shared/al-contracts/al-control.ts';

import type { RallarBlackBoxTestWaitCommand } from '../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, RESPONSE_MARGIN_MS } from './alm-conformance-budgets.ts';
import type { AlmConformanceMessageStepInput, AlmConformanceStepInput } from './alm-conformance-scenario-definition.ts';
import { toCommandId, toScenarioTypeId } from './alm-conformance-step-identities.ts';

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
    /** A substring of the event's serialised `data`, so it must follow the emitted key order. */
    readonly contains: string;
}

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

/**
 * One runtime diagnostic event of the page that runs the step. The diagnostics carry no connection to route on, so
 * the text must scope the match itself. The wait starts before the other role's sends, so it owns the verdict budget.
 */
export function toDiagnosticWait(
    { step, name, topic, contains }: AlmConformanceDiagnosticWaitInput
): RallarBlackBoxTestWaitCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(step, name),
        match: { kind: 'diagnostic', topic, payloadPath: 'data', contains },
        timeoutMs: toVerdictTimeoutMs(step.input.deadlineMs)
    };
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
        contains: `"msgId":"${toSentMsgIdReference(step)}","typeId":"${toScenarioTypeId(step)}","origin":"repair"`
    });
}

/** The message id the send of `step.index` returned, resolved from the result cache when the wait is armed. */
function toSentMsgIdReference(step: AlmConformanceMessageStepInput): string {
    return `{resultCache.${toCommandId(step, `send-${step.index}`)}.value.msgId}`;
}

/**
 * A wait for a verdict the page states on its own diagnostics starts before the other role's sends, so it owns the
 * evidence deadline and the whole non-expiring send budget, less the margin the recipe keeps to report.
 */
export function toVerdictTimeoutMs(deadlineMs: number): number {
    return deadlineMs + NON_EXPIRING_SEND_TIMEOUT_MS - RESPONSE_MARGIN_MS;
}
