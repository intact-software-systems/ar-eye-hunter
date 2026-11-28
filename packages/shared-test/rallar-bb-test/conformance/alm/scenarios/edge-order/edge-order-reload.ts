import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS } from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toHeldSendCommands } from '../../alm-conformance-fault-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
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
import { toEdgeOrderArrivalWait, toEdgeOrderGapWait, toEdgeOrderSendCommands } from './edge-order-commands.ts';
import { EDGE_ORDER_STREAM_SENDS } from './edge-order-stream.ts';

/** The old document's sends: 1 arrives, 2 never leaves the page, 3 arrives before it. */
const HELD_SEND = 2;
const OVERTAKING_SEND = 3;
/** The new document's first send. */
const FIRST_RELOADED_SEND = OVERTAKING_SEND + 1;
/** The receiver hands send 1 over, then the new document's sends, then send 3 once send 2 can no longer arrive. */
const OVERTAKING_TURN = EDGE_ORDER_STREAM_SENDS - 1;

/**
 * An edge-ordered stream ends with the page that sent it, and the page's next stream neither waits for it nor closes
 * it. The old document sends 1, which is acknowledged; then 2, which a native hold keeps on the page until the
 * document ends; then 3, which is acknowledged, so the receiver states that it holds 3 for its turn before the reload.
 * The reloaded document reconnects on the session it kept and sends 4 to 8 on a stream it mints anew, each
 * acknowledged. The receiver records 1, then 4 to 8 in send order while 3 is still held, then 3 once send 2's lifetime
 * ended: it states the gap at position 2 of the old stream as `cannot-arrive`, not `ended-at-sender`, and records
 * nothing twice. The payload's `turn` states the order the receiver records them in.
 *
 * Send 2 lives for the cell's deadline, which the reload, the reconnect and the five new sends must fit in: a reload
 * slower than that hands 3 over before the new sends and fails the order. Send 3 outlives it by a send's budget, so
 * the receiver hands 3 over at send 2's end, not its own. Nothing is restored: edge order keeps no state across a
 * document, and every send is volatile.
 */
export const edgeOrderReload: AlmConformanceScenarioDefinition = {
    scenarioId: 'edge-order-reload',
    scenarioKey: 'edge-order-reload',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    order: 'edge',
    toSenderCommands: toEdgeOrderReloadSenderCommands,
    toRecipientCommands: toEdgeOrderReloadReceiverCommands,
    toReloadCheckpoint: (step) =>
        toAlmReloadCheckpoint(step, {
            senderPrefixEnd: `assert-acknowledged-${OVERTAKING_SEND}`,
            senderSuffixEnd: `assert-acknowledged-${EDGE_ORDER_STREAM_SENDS}`,
            receiverReadyEnd: 'health-before',
            receiverAbsenceEnd: 'held-overtaking-send',
            receiverRecoveryEnd: `received-${EDGE_ORDER_STREAM_SENDS - 1}`
        })
};

function toEdgeOrderReloadSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const heldLifetimeMs = sender.input.deadlineMs;
    const reloadedSends = toSequences(FIRST_RELOADED_SEND, EDGE_ORDER_STREAM_SENDS);
    return [
        ...toEdgeOrderSendCommands(sender, 1, { turn: 1 }),
        ...toSettledStateCommands({ ...sender, index: 1 }, 'acknowledged'),
        ...toHeldSendCommands(
            { ...sender, index: HELD_SEND },
            toEdgeOrderSendCommands(sender, HELD_SEND, { ttlMs: heldLifetimeMs })
        ),
        ...toEdgeOrderSendCommands(sender, OVERTAKING_SEND, {
            turn: OVERTAKING_TURN,
            ttlMs: heldLifetimeMs + NON_EXPIRING_SEND_TIMEOUT_MS
        }),
        ...toSettledStateCommands({ ...sender, index: OVERTAKING_SEND }, 'acknowledged'),
        toReloadCommand(sender),
        toRestoredReconnectCommand(sender),
        ...reloadedSends.flatMap((seq) =>
            toEdgeOrderSendCommands(sender, seq, { turn: seq - FIRST_RELOADED_SEND + 2 })
        ),
        ...reloadedSends.flatMap((seq) => toSettledStateCommands({ ...sender, index: seq }, 'acknowledged'))
    ];
}

/**
 * Seven of the eight sends arrive, in the order their `turn` states. The wait for them starts beside the sender's
 * reload, so its budget of the deadline and a send's covers send 2's lifetime.
 */
function toEdgeOrderReloadReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const received = EDGE_ORDER_STREAM_SENDS - 1;
    return [
        toReloadPhaseHealthCommand(receiver, 'health-before'),
        toEdgeOrderArrivalWait(receiver, 'held-overtaking-send', 'held'),
        toReceivedCommand({ ...receiver, index: received, count: received, absent: false, ascendingBy: 'turn' }),
        toEdgeOrderGapWait(receiver, 'held-send-cannot-arrive', {
            fromPosition: HELD_SEND,
            toPosition: HELD_SEND,
            reason: 'cannot-arrive'
        }),
        toReceivedCommand({ ...receiver, index: received + 1, count: received + 1, absent: true })
    ];
}
