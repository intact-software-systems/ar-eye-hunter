import { NON_EXPIRING_SEND_TIMEOUT_MS, NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import type { AlmConformanceCarrier } from '../../alm-conformance-carriers.ts';
import { toAdmissionCommands, toSendCommand } from '../../alm-conformance-message-commands.ts';
import { toAddressedSendCommands } from '../../alm-conformance-receipt-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import { toAwaitReplyCommands, toReplyCommands, toReplyLateWait } from './reply-commands.ts';

const REPLY_TIMEOUT_LATE_CARRIERS: readonly AlmConformanceCarrier[] = ['ws'];

/** Short beside the cell, since the receiver holds its reply until the sender's release, which follows the timeout. */
const REPLY_TIMEOUT_MS = 1_000;

/**
 * D445: the reply wait on an acknowledged `command` times out, and the request stays `acknowledged`. Only then does the
 * sender release the receiver with a second send; the receiver replies to the first, and the sender drops that reply
 * as `reply-late` with `cause` `timed-out`.
 */
export const replyTimeoutLate: AlmConformanceScenarioDefinition = {
    scenarioId: 'reply-timeout-late',
    scenarioKey: 'reply-timeout-late',
    tags: FULL_TAGS,
    carriers: REPLY_TIMEOUT_LATE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'addressed',
    toSenderCommands: (sender) => [
        ...toAddressedSendCommands(sender, 'receiver'),
        ...toAwaitReplyCommands(
            { ...sender, index: 1 },
            { timeoutMs: REPLY_TIMEOUT_MS, status: 'timeout', requestState: 'acknowledged' }
        ),
        toSendCommand({
            ...sender,
            index: 2,
            payload: { marker: sender.scenarioId, carrier: sender.input.carrier, release: true },
            delivery: {
                toPeer: 'receiver',
                ack: 'receiver',
                ttlMs: NON_EXPIRING_TTL_MS,
                commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
            }
        }),
        ...toAdmissionCommands({ ...sender, index: 2 }),
        toReplyLateWait({ ...sender, index: 1 }, 'timed-out')
    ],
    toRecipientCommands: (receiver) => [
        toReceivedCommand({ ...receiver, index: 1, count: 1, absent: false }),
        toReceivedCommand({ ...receiver, index: 2, count: 2, absent: false }),
        ...toReplyCommands({ ...receiver, index: 1 })
    ]
};
