import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import { toAddresseeReceiptAssertions } from '../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';

import { toAddressedSendCommands } from './to-addressed-send-commands.ts';

/** The server is no RTC peer: an RTC strategy refuses a send addressed to it before admission. */
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
    laneFamily: 'addressed',
    toSenderCommands: toServerCommandSenderCommands,
    toRecipientCommands: (
        receiver
    ) => [toReceivedCommand({ ...receiver, index: 1, count: 1, absent: true })]
};

function toServerCommandSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toAddressedSendCommands(sender, 'server'),
        ...toAddresseeReceiptAssertions(sender, 'observe-acknowledged-1')
    ];
}
