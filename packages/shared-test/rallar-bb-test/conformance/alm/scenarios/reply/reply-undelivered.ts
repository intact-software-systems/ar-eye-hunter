import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { EXPIRY_TTL_MS, NON_EXPIRING_SEND_TIMEOUT_MS } from '../../alm-conformance-budgets.ts';
import type { AlmConformanceCarrier } from '../../alm-conformance-carriers.ts';
import { toTypeDropFaultCommands } from '../../alm-conformance-fault-commands.ts';
import { toAdmissionCommands, toSendCommand } from '../../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toAwaitReplyCommands } from './reply-commands.ts';

const REPLY_UNDELIVERED_CARRIERS: readonly AlmConformanceCarrier[] = ['ws'];

/**
 * D445, the `deadline-expiry.ts` pattern: the transport fault port drops the `command` on its only carrier, and the
 * receiver never receives it. The reply wait is armed at admission, while the request is alive, and outlasts its short
 * deadline; the deadline ends the wait `undelivered` on the `expired` request, before the wait's own timeout.
 */
export const replyUndelivered: AlmConformanceScenarioDefinition = {
    scenarioId: 'reply-undelivered',
    scenarioKey: 'reply-undelivered',
    tags: FULL_TAGS,
    carriers: REPLY_UNDELIVERED_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'addressed',
    toSenderCommands: toReplyUndeliveredSenderCommands,
    toRecipientCommands: (receiver) => [toReceivedCommand({ ...receiver, index: 1, count: 1, absent: true })]
};

function toReplyUndeliveredSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toTypeDropFaultCommands(sender, 'fault', 'until-cleared'),
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, carrier: sender.input.carrier },
            delivery: { toPeer: 'receiver', ack: 'receiver', ttlMs: EXPIRY_TTL_MS }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        ...toAwaitReplyCommands(
            { ...sender, index: 1 },
            { timeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS, status: 'undelivered', requestState: 'expired' }
        ),
        ...toTypeDropFaultCommands(sender, 'release', 0)
    ];
}
