import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { EXPIRY_TTL_MS } from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import { toTypeDropFaultCommands } from '../alm-conformance-fault-commands.ts';
import { toAdmissionCommands, toSendCommand } from '../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
import {
    SMOKE_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';
import { toSettledStateCommands } from '../to-settled-state-commands.ts';

export const deadlineExpiry: AlmConformanceScenarioDefinition = {
    scenarioId: 'deadline-expiry',
    scenarioKey: 'deadline-expiry',
    tags: SMOKE_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toDeadlineExpirySenderCommands,
    toRecipientCommands: toDeadlineExpiryReceiverCommands
};

function toDeadlineExpiryReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [toReceivedCommand({
        ...receiver,
        index: 1,
        count: 1,
        absent: true
    })];
}

function toDeadlineExpirySenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toTypeDropFaultCommands(sender, 'fault', 'until-cleared'),
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, carrier: sender.input.carrier },
            delivery: { ttlMs: EXPIRY_TTL_MS, ack: 'receiver' }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        ...toSettledStateCommands({ ...sender, index: 1 }, 'expired'),
        ...toTypeDropFaultCommands(sender, 'release', 0)
    ];
}
