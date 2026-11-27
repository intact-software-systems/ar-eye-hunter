import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS } from '../../alm-conformance-budgets.ts';
import type { AlmConformanceCarrier } from '../../alm-conformance-carriers.ts';
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
import { ALM_CARRIER_MATRIX } from '../../carrier-matrix/alm-carrier-matrix.ts';
import { resolveAlmCarrierMatrixCellCarriers } from '../../carrier-matrix/resolve-alm-carrier-matrix-cell-carriers.ts';
import { toCueStep } from '../receipted-audience.ts';
import {
    toCueListenCommands,
    toCueSendCommands,
    toCueWait
} from '../topic-subscription/topic-subscription-publications.ts';

const ONE_REPAIR: AlmConformanceOrderedSendOptions = { maxRepairs: 1 };

/** What the held second send comes to on each carrier once a requester's budget is spent, as the matrix states it. */
const EXHAUSTED_CELLS = ALM_CARRIER_MATRIX['repair-budget-exhausted'].cells;

/**
 * A repair budget that runs out ends on the handle: every send states a budget of one retransmit per requester, the
 * sender's second frame stays held through every retransmission, and the hop that orders the track reports the gap once
 * the third frame arrives. Over `rtc` each receiver orders the track itself, so there are two requesters; over `ws` the
 * server orders it and is the one requester. A requester's first report spends its one retransmit; the range stays
 * missing, so the requester renews it 1 to 1.5 s later, and that renewal, its request numbered 2, finds its budget
 * spent: the sender settles the second frame `skipped` with reason `repair-exhausted`, and the settlement ends the
 * message, so no repair of it commits in the window after its handle read `failed`. Both receivers delivered the
 * first send only: the third and fourth wait for a second that never arrives, in each receiver's own buffer over `rtc`
 * and in the server's over `ws`, which delivers no frame of a track past a sequence it still waits for. Over
 * `rtc-with-ws-fallback` the held frame's run of `not-ready` attempts hands it to WS (D56), where it is no longer the
 * RTC repair's to exhaust; held there too, it sends nothing and ends `expired` at its 30 s deadline, while the cell
 * observes it for at most 10 s (`handed-over-send-held-on-ws.test.ts`), so the cell runs over `ws` and `rtc`.
 */
export const repairExhausted: AlmConformanceScenarioDefinition = {
    scenarioId: 'repair-exhausted',
    scenarioKey: 'repair-exhausted',
    tags: FULL_TAGS,
    carriers: resolveAlmCarrierMatrixCellCarriers('repair-exhausted'),
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    toSenderCommands: toRepairExhaustedSenderCommands,
    toRecipientCommands: toRepairExhaustedRecipientCommands
};

/**
 * Each requester reports the gap again once the fourth frame arrives. That report repeats its requester's first
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
    const failure = toExhaustedFailureFields(sender.input.carrier);
    return [
        ...toCueListenCommands(cue),
        ...toOrderedSendCommands(sender, 1, ONE_REPAIR),
        ...sender.roles.filter((role) => role !== 'sender').map((role) => toCueWait(cue, toDeliveredCue(role))),
        ...toHeldGapCommands(sender, ONE_REPAIR),
        ...toOrderedSendCommands(sender, 4, ONE_REPAIR),
        toObserveCommand({ ...sender, index: 2, state: 'failed', budgetMs: NON_EXPIRING_SEND_TIMEOUT_MS }),
        ...failure.map(([field, expected]) =>
            toResultAssertion({
                step: sender,
                name: `assert-${expected}-2`,
                resultName: observation,
                field,
                operator: 'equals',
                expected
            })
        ),
        toNoRepairCommitAfterFailedWait(sender)
    ];
}

/**
 * The failure the held second send's handle ends with over `carrier`, field by field. The scenario runs only over a
 * carrier whose cell names it as a lane proof, and each such cell states that failure.
 */
function toExhaustedFailureFields(carrier: AlmConformanceCarrier): readonly (readonly [string, string])[] {
    const { outcome } = EXHAUSTED_CELLS[carrier];
    if (outcome.kind !== 'undelivered') {
        throw new Error(`repair-exhausted has no failure to assert over ${carrier}: its cell states ${outcome.kind}.`);
    }
    return [['failure.kind', outcome.failure.kind], ['failure.reason', outcome.failure.reason]];
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
