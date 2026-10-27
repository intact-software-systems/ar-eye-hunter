import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import type { AlmConformanceCarrier } from '../../alm-conformance-carriers.ts';
import {
    toAudienceSendCommands,
    toReceiptWindowCommands,
    type AlmConformanceReceiptRoles
} from '../../alm-conformance-receipt-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toCommandId, toConnectionName } from '../../alm-conformance-step-identities.ts';
import {
    toAwaitReplyCommands,
    toReplyCommands,
    toReplyIdentityCommands,
    toReplyLateWait
} from './reply-commands.ts';

const REPLY_FIRST_WINS_CARRIERS: readonly AlmConformanceCarrier[] = ['ws'];

const BOTH_CONFIRMED: AlmConformanceReceiptRoles = { confirmed: ['receiver', 'recipient-b'], unconfirmed: [] };

/**
 * D445: a room request asking for every logical recipient, which both recipients answer. The sender reads `replied`
 * once, drops the other reply as `reply-late` with `cause` `replied`, and after its receipt window finds the reply's
 * sender among the recipients its receipt confirmed. Each recipient's closing window, through which no second copy
 * arrives, keeps its page until its ACK of the request has left.
 */
export const replyFirstWins: AlmConformanceScenarioDefinition = {
    scenarioId: 'reply-first-wins',
    scenarioKey: 'reply-first-wins',
    tags: FULL_TAGS,
    carriers: REPLY_FIRST_WINS_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    toReceiptRoles: () => BOTH_CONFIRMED,
    toSenderCommands: toReplyFirstWinsSenderCommands,
    toRecipientCommands: (recipient) => [
        toReceivedCommand({ ...recipient, index: 1, count: 1, absent: false }),
        ...toReplyCommands({ ...recipient, index: 1 }),
        toReceivedCommand({ ...recipient, index: 2, count: 2, absent: true })
    ]
};

function toReplyFirstWinsSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toAudienceSendCommands({ sender, ttlMs: NON_EXPIRING_TTL_MS, ack: 'all-logical-recipients' }),
        ...toAwaitReplyCommands({ ...sender, index: 1 }, {
            timeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS,
            status: 'replied'
        }),
        ...toReplyIdentityCommands({ ...sender, index: 1 }, undefined),
        toReplyLateWait({ ...sender, index: 1 }, 'replied'),
        ...toReceiptWindowCommands(sender, { roles: BOTH_CONFIRMED, ending: 'acknowledged', mode: 'receiver' }),
        toReplySenderConfirmedWait(sender)
    ];
}

/** The receipt read is stated before this wait runs, so the wait reads the history once. */
function toReplySenderConfirmedWait(sender: AlmConformanceStepInput): RallarBlackBoxTestWaitCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(sender, 'reply-sender-confirmed-1'),
        match: {
            kind: 'diagnostic',
            topic: 'rallar.bb.messages.receipts',
            commandId: toCommandId(sender, 'receipts-1'),
            connection: toConnectionName(sender),
            payloadPath: 'data.confirmedRecipientPeerIds',
            contains: `"{resultCache.${toCommandId(sender, 'await-reply-1')}.value.reply.senderId}"`
        },
        timeoutMs: 0
    };
}
