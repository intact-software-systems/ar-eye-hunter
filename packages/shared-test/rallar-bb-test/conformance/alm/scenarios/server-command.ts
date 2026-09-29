import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, NON_EXPIRING_TTL_MS } from '../alm-conformance-budgets.ts';
import type { AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import {
    toAddresseeReceiptAssertions,
    toAdmissionCommands,
    toObserveCommand,
    toSendCommand
} from '../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';

/** The server is no RTC peer: an RTC strategy refuses a send addressed to it before admission (C9). */
const SERVER_COMMAND_CARRIERS: readonly AlmConformanceCarrier[] = ['ws'];

/**
 * D57 as applied: a `command` addressed to the WS server ends `acknowledged` on the server's own ACK, and the server
 * keeps it, so the room's other member receives nothing for the whole window.
 */
export const serverCommand: AlmConformanceScenarioDefinition = {
    scenarioId: 'server-command',
    scenarioKey: 'server-command',
    tags: FULL_TAGS,
    carriers: SERVER_COMMAND_CARRIERS,
    roles: ['sender', 'receiver'],
    toSenderCommands: toServerCommandSenderCommands,
    toRecipientCommands: (
        receiver
    ) => [toReceivedCommand({ ...receiver, index: 1, count: 1, absent: true })]
};

function toServerCommandSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, carrier: sender.input.carrier },
            delivery: {
                toPeer: 'server',
                ack: 'receiver',
                ttlMs: NON_EXPIRING_TTL_MS,
                commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
            }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toObserveCommand({ ...sender, index: 1, state: 'acknowledged' }),
        ...toAddresseeReceiptAssertions(sender, 'observe-acknowledged-1')
    ];
}
