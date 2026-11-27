import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import {
    toAdmissionCommands,
    toSendCommand,
    toVerdictCommands
} from '../../alm-conformance-message-commands.ts';
import { toAudiencePayload, toSelfAbsenceCommand } from '../../alm-conformance-receipt-commands.ts';
import { toReceivedCommand, toSingleArrivalReceiverCommands } from '../../alm-conformance-receiver-commands.ts';
import { ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { ALM_CARRIER_MATRIX } from '../../carrier-matrix/alm-carrier-matrix.ts';
import { resolveAlmCarrierMatrixCellCarriers } from '../../carrier-matrix/resolve-alm-carrier-matrix-cell-carriers.ts';
import { toAlmCarrierOutcomeFacts } from '../../carrier-matrix/to-alm-carrier-outcome-facts.ts';

/** What the world send comes to on each carrier, which decides the sender's verdict and whether anybody receives it. */
const WORLD_BROADCAST_CELLS = ALM_CARRIER_MATRIX['world-broadcast'].cells;

/**
 * The sender addresses its authenticated scope on an `app.` topic of its own. Over `ws` the server delivers the send to
 * every other live session of the scope, which in the lane are the room's other two sessions; over `rtc` the carrier
 * refuses it `unsupported` and the handle ends rejected, so nobody receives it; over `rtc-with-ws-fallback` the browser
 * routes it to WS at once: one WS attempt and no hand-over from an RTC leg. On every carrier the sender's own channel
 * never receives it. The lane's scope holds the room's sessions alone, so the proof that a world send is bound to the
 * sender's authenticated scope lives in the server tests.
 */
export const worldRouting: AlmConformanceScenarioDefinition = {
    scenarioId: 'world-routing',
    scenarioKey: 'world-routing',
    tags: FULL_TAGS,
    carriers: resolveAlmCarrierMatrixCellCarriers('world-routing'),
    roles: ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES,
    laneFamily: 'same-principal',
    topic: 'world',
    toSenderCommands: toWorldSenderCommands,
    toRecipientCommands: (recipient) =>
        WORLD_BROADCAST_CELLS[recipient.input.carrier].outcome.kind === 'refused'
            ? [toReceivedCommand({ ...recipient, index: 1, count: 1, absent: true })]
            : toSingleArrivalReceiverCommands(recipient)
};

function toWorldSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const send = toSendCommand({
        ...sender,
        index: 1,
        payload: toAudiencePayload(sender),
        delivery: { scope: 'world' }
    });
    return [send, ...toWorldVerdictCommands(sender), toSelfAbsenceCommand(sender)];
}

function toWorldVerdictCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const outcome = WORLD_BROADCAST_CELLS[sender.input.carrier].outcome;
    switch (outcome.kind) {
        case 'delivered':
            return toAdmissionCommands({ ...sender, index: 1 });
        case 'refused':
            return toVerdictCommands(sender, 'rejected', toAlmCarrierOutcomeFacts(outcome));
        case 'handed-to-ws':
            return toVerdictCommands(sender, 'transport-accepted', toAlmCarrierOutcomeFacts(outcome));
    }
}
