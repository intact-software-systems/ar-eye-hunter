import { NON_EXPIRING_SEND_TIMEOUT_MS } from '../../alm-conformance-budgets.ts';
import type { AlmConformanceCarrier } from '../../alm-conformance-carriers.ts';
import { toAddresseeReceiptAssertions, toReceiptsCommand } from '../../alm-conformance-message-commands.ts';
import { toAddressedSendCommands, type AlmConformanceReceiptRoles } from '../../alm-conformance-receipt-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';
import {
    toAwaitReplyCommands,
    toReplyCommands,
    toReplyIdentityCommands
} from './reply-commands.ts';

/** Replies travel over WS only, so over the fallback carrier the request may arrive on RTC and its reply on WS. */
const REPLY_CORRELATED_CARRIERS: readonly AlmConformanceCarrier[] = ['ws', 'rtc-with-ws-fallback'];

const RECEIVER_CONFIRMED: AlmConformanceReceiptRoles = { confirmed: ['receiver'], unconfirmed: [] };

/**
 * D445: a `command` addressed to the receiver reads `replied`. The reply names the request's msgId as its
 * `replyToMsgId` and its `corrId`, its sender is the session the request's receipt confirmed, and the receiver reads
 * its reply acknowledged.
 */
export const replyCorrelated: AlmConformanceScenarioDefinition = {
    scenarioId: 'reply-correlated',
    scenarioKey: 'reply-correlated',
    tags: FULL_TAGS,
    carriers: REPLY_CORRELATED_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'addressed',
    toReceiptRoles: () => RECEIVER_CONFIRMED,
    toSenderCommands: (sender) => [
        ...toAddressedSendCommands(sender, 'receiver'),
        ...toAddresseeReceiptAssertions(sender, 'observe-acknowledged-1'),
        toReceiptsCommand({ ...sender, index: 1 }),
        ...toAwaitReplyCommands({ ...sender, index: 1 }, {
            timeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS,
            status: 'replied'
        }),
        ...toReplyIdentityCommands(
            { ...sender, index: 1 },
            `{resultCache.${toCommandId(sender, 'observe-acknowledged-1')}.value.confirmedRecipientPeerIds.0}`
        )
    ],
    toRecipientCommands: (receiver) => [
        toReceivedCommand({ ...receiver, index: 1, count: 1, absent: false }),
        ...toReplyCommands({ ...receiver, index: 1 })
    ]
};
