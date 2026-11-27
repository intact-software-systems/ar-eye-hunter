import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toHeldMessageFaultCommands, toHeldSendCommands } from '../../alm-conformance-fault-commands.ts';
import { toCancelCommand, toResultAssertion } from '../../alm-conformance-message-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import {
    toAlmReloadCheckpoint,
    toReloadCommand,
    toReloadPhaseHealthCommand,
    toRestoredReconnectCommand
} from '../../cell/to-alm-reload-checkpoint.ts';
import { toSettledStateCommands } from '../../to-settled-state-commands.ts';
import { toSequences } from '../fault-streams/ordered-stream.ts';
import {
    toEdgeOrderArrivalWait,
    toEdgeOrderedArrivalCommands,
    toEdgeOrderSendCommands
} from './edge-order-commands.ts';
import { EDGE_ORDER_STREAM_SENDS } from './edge-order-stream.ts';

/** The first run's last send, which stays open while the second run is sent. */
const OPEN_SEND = 4;
const SECOND_RUN_SENDS = toSequences(OPEN_SEND + 1, EDGE_ORDER_STREAM_SENDS);

/**
 * A receiver that first hears an edge-ordered stream mid-way waits out its entry window, starts at the first position
 * it heard, and never reports what came before. The lane admits a fresh page to a cell's room mid-cell only by
 * reloading the `sender` role's page, so here the roles' names are the reload pair's: `receiver` sends the stream and
 * `sender` is the page that joins late.
 *
 * The stream's sender sends 1 to 3, each acknowledged by the joining page's first document, then 4, which a native
 * hold keeps on the page. That document reloads, and the new one reconnects on the session the old one kept: its
 * received ledger and its edge order start empty. Only once it is connected does the stream's sender send 5 to 8. The
 * stamp of 5 says 4 can still arrive, so the new document holds 5 for its 500 ms entry window, then records 5 to 8 in
 * send order, nothing twice and nothing of 1 to 4, and states no gap. The stream's sender then cancels 4, which never
 * left its page.
 *
 * The joining page is a new document of the session that heard the first run, not another session or agent: a cell
 * with a third page would need that page to leave and rejoin the room around the first run, and an edge-ordered cell
 * can send no cue to order the steps between pages, since its channels refuse a send that asks for no receipt.
 */
export const edgeOrderLateJoin: AlmConformanceScenarioDefinition = {
    scenarioId: 'edge-order-late-join',
    scenarioKey: 'edge-order-late-join',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    order: 'edge',
    toSenderCommands: toJoiningPageCommands,
    toRecipientCommands: toStreamSenderCommands,
    toReloadCheckpoint: (step) =>
        toAlmReloadCheckpoint(step, {
            senderPrefixEnd: 'health-before',
            senderSuffixEnd: 'reconnect',
            receiverReadyEnd: 'health-before',
            receiverAbsenceEnd: 'health-first-run-sent',
            receiverRecoveryEnd: 'health-during-reload'
        })
};

/** The joining page's first document only hears the first run; the one after its reload hears the second. */
function toJoiningPageCommands(joiner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toReloadPhaseHealthCommand(joiner, 'health-before'),
        toReloadCommand(joiner),
        toRestoredReconnectCommand(joiner),
        toEdgeOrderArrivalWait(joiner, 'held-at-entry', 'held'),
        ...toEdgeOrderedArrivalCommands(joiner, SECOND_RUN_SENDS.length)
    ];
}

/**
 * The first run goes out while the joining page's first document is connected, the second only once its reload has
 * reconnected. The hold arms after 1 to 3 are acknowledged, so it meets send 4 alone.
 */
function toStreamSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const open = { ...sender, index: OPEN_SEND };
    const acknowledgedFirstRun = toSequences(1, OPEN_SEND - 1);
    return [
        toReloadPhaseHealthCommand(sender, 'health-before'),
        ...acknowledgedFirstRun.flatMap((seq) => toEdgeOrderSendCommands(sender, seq)),
        ...acknowledgedFirstRun.flatMap((seq) => toSettledStateCommands({ ...sender, index: seq }, 'acknowledged')),
        ...toHeldSendCommands(open, toEdgeOrderSendCommands(sender, OPEN_SEND)),
        toReloadPhaseHealthCommand(sender, 'health-first-run-sent'),
        toReloadPhaseHealthCommand(sender, 'health-during-reload'),
        ...SECOND_RUN_SENDS.flatMap((seq) => toEdgeOrderSendCommands(sender, seq)),
        ...SECOND_RUN_SENDS.flatMap((seq) => toSettledStateCommands({ ...sender, index: seq }, 'acknowledged')),
        toCancelCommand(open),
        toResultAssertion({
            step: sender,
            name: `assert-cancelled-${OPEN_SEND}`,
            resultName: `cancel-${OPEN_SEND}`,
            field: 'state',
            operator: 'equals',
            expected: 'cancelled'
        }),
        ...toHeldMessageFaultCommands(open, `release-message-${OPEN_SEND}`, 0)
    ];
}
