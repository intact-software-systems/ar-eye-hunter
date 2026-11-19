import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS } from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_RTC_ALONE_CARRIERS } from '../../alm-conformance-carriers.ts';
import {
    ALM_OUTBOUND_DIAGNOSTICS_TOPIC,
    toDiagnosticWait,
    toSentMsgIdReference
} from '../../alm-conformance-diagnostic-waits.ts';
import { toObserveCommand, toResultAssertion } from '../../alm-conformance-message-commands.ts';
import {
    toHeldGapCommands,
    toOrderedSendCommands,
    type AlmConformanceOrderedSendOptions
} from '../../alm-conformance-ordering-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import { ALM_CONFORMANCE_THREE_AGENT_ROLES, type AlmConformanceRole } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toCueStep } from '../receipted-audience.ts';
import {
    toCueListenCommands,
    toCueSendCommands,
    toCueWait
} from '../topic-subscription/topic-subscription-publications.ts';

const ONE_REPAIR: AlmConformanceOrderedSendOptions = { maxRepairs: 1 };

/**
 * A repair budget that runs out ends on the handle: every send states a budget of one retransmit per receiver, the
 * sender's second frame stays held through every retransmission, and each receiver orders the track itself and reports
 * the gap once the third frame arrives. Each receiver's first report spends its own one retransmit; the range stays
 * missing, so the receiver renews it 1 to 1.5 s later, and that renewal, its request numbered 2, finds its budget
 * spent: the sender settles the second frame `skipped` with reason `repair-exhausted`, and the settlement ends the
 * message, so no repair of it commits in the window after its handle read `failed`. Both receivers delivered the
 * first send only: the third and fourth wait for a second that never arrives. The cell is not run over `ws`, where the
 * server orders the track and requests its gaps; it is untested there since the budget became per requester. Over
 * `rtc-with-ws-fallback` the held frame's run of `not-ready` attempts hands it to WS (D56), where it is no longer the
 * RTC repair's to exhaust; what a handed-over held frame ends as is undocumented, so the cell asserts `rtc` alone.
 */
export const repairExhausted: AlmConformanceScenarioDefinition = {
    scenarioId: 'repair-exhausted',
    scenarioKey: 'repair-exhausted',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_RTC_ALONE_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    toSenderCommands: toRepairExhaustedSenderCommands,
    toRecipientCommands: toRepairExhaustedRecipientCommands
};

/**
 * Each receiver reports the gap again once the fourth frame arrives. That report repeats its requester's first
 * request number and charges nothing (D573), so the exhausting request is a renewal. The hold is never released: a
 * late second frame would reach a receiver inside its absence window. The gap is opened only once both receivers
 * delivered the first frame: a receiver whose first frame is the third enters the track there, reads the first as
 * before its entry and never reports the gap (D630), and its channel reads the third and fourth.
 */
function toRepairExhaustedSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    const cue = toCueStep(sender);
    const observation = 'observe-failed-2';
    return [
        ...toCueListenCommands(cue),
        ...toOrderedSendCommands(sender, 1, ONE_REPAIR),
        ...sender.roles.filter((role) => role !== 'sender').map((role) => toCueWait(cue, toDeliveredCue(role))),
        ...toHeldGapCommands(sender, ONE_REPAIR),
        ...toOrderedSendCommands(sender, 4, ONE_REPAIR),
        toObserveCommand({ ...sender, index: 2, state: 'failed', budgetMs: NON_EXPIRING_SEND_TIMEOUT_MS }),
        toResultAssertion({
            step: sender,
            name: 'assert-skipped-2',
            resultName: observation,
            field: 'failure.kind',
            operator: 'equals',
            expected: 'skipped'
        }),
        toResultAssertion({
            step: sender,
            name: 'assert-repair-exhausted-2',
            resultName: observation,
            field: 'failure.reason',
            operator: 'equals',
            expected: 'repair-exhausted'
        }),
        toNoRepairCommitAfterFailedWait(sender)
    ];
}

/**
 * The settlement ends the message: no repair dispatch of the second send commits in the window after its handle read
 * `failed`. The exhausting request's own commit, which ends the message, is stated before the handle reads `failed`,
 * so the wait starts its history at its own first event, after both. The lane reads the commit, not the frame: whether
 * a frame left the page is not in the snapshot.
 */
function toNoRepairCommitAfterFailedWait(sender: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    const step = { ...sender, index: 2 };
    const wait = toDiagnosticWait({
        step,
        name: 'no-repair-commit-after-failed-2',
        topic: ALM_OUTBOUND_DIAGNOSTICS_TOPIC,
        historyFrom: 'cell',
        absent: true,
        contains: `"msgId":"${toSentMsgIdReference(step)}"`,
        payloadFields: { 'data.kind': 'commit-phases', 'data.origin': 'repair', 'data.commitOutcome': 'committed' }
    });
    return { ...wait, match: { ...wait.match, sinceCommandIdPrefix: wait.commandId } };
}

/** A receiver's first arrival is the first frame, since nothing later is sent before its cue; then only absence. */
function toRepairExhaustedRecipientCommands(
    recipient: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toReceivedCommand({ ...recipient, index: 1, count: 1, absent: false }),
        ...toCueSendCommands(toCueStep(recipient), toDeliveredCue(recipient.role)),
        toReceivedCommand({ ...recipient, index: 2, count: 2, absent: true })
    ];
}

function toDeliveredCue(role: AlmConformanceRole): string {
    return `${role}-delivered-1`;
}
