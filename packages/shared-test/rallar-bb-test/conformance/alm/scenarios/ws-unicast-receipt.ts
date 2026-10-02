import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import { toAddresseeReceiptAssertions, toReceiptsCommand } from '../alm-conformance-message-commands.ts';
import { toAddressedSendCommands, type AlmConformanceReceiptRoles } from '../alm-conformance-receipt-commands.ts';
import { toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';

const RECEIVER_CONFIRMED: AlmConformanceReceiptRoles = { confirmed: ['receiver'], unconfirmed: [] };

/**
 * On every carrier: a `command` addressed to the receiver by its lane role ends `acknowledged` on the addressee's
 * own receipt. On two agents a room send would yield the same evidence; the identity assessment joins the receipt to
 * the receiver's session after the run.
 */
export const wsUnicastReceipt: AlmConformanceScenarioDefinition = {
    scenarioId: 'ws-unicast-receipt',
    scenarioKey: 'ws-unicast-receipt',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'addressed',
    toReceiptRoles: () => RECEIVER_CONFIRMED,
    toSenderCommands: toWsUnicastReceiptSenderCommands,
    toRecipientCommands: (
        receiver
    ) => [toReceivedCommand({ ...receiver, index: 1, count: 1, absent: false })]
};

function toWsUnicastReceiptSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toAddressedSendCommands(sender, 'receiver'),
        ...toAddresseeReceiptAssertions(sender, 'observe-acknowledged-1'),
        toReceiptsCommand({ ...sender, index: 1 })
    ];
}
