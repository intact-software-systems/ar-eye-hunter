import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceCarrier } from '../../alm-conformance-carriers.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';

import {
    FAULT_STREAM_SENDS,
    toSeededFaultArmCommand,
    toSeededFaultReleaseCommands,
    toStreamAcknowledgedCommands,
    toStreamReceivedCommands,
    toStreamSendCommands
} from './fault-stream-commands.ts';

/** An RTC channel applies no delay, so a jitter has one carrier. */
const JITTER_CARRIERS: readonly AlmConformanceCarrier[] = ['ws'];

const JITTER = { kind: 'jitter', action: { jitter: { minDelayMs: 0, maxDelayMs: 80, seed: 11 } } } as const;

/** Half the stream: a jitter that delayed fewer frames reordered too little to claim anything. */
const JITTER_DELAYED_FLOOR = FAULT_STREAM_SENDS / 2;

/**
 * An ordered receipted stream keeps its order when every data frame leaves after a seeded delay of 0 to 80 ms, so
 * frames reach the server out of order: all twenty arrive in sequence order, nothing arrives twice, and every handle
 * ends `acknowledged`.
 */
export const seededJitterStream: AlmConformanceScenarioDefinition = {
    scenarioId: 'seeded-jitter-stream',
    scenarioKey: 'seeded-jitter-stream',
    tags: FULL_TAGS,
    carriers: JITTER_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toSeededJitterStreamSenderCommands,
    toRecipientCommands: (receiver) => toStreamReceivedCommands(receiver, FAULT_STREAM_SENDS)
};

function toSeededJitterStreamSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toSeededFaultArmCommand(sender, JITTER),
        ...toStreamSendCommands(sender, 1, FAULT_STREAM_SENDS),
        ...toStreamAcknowledgedCommands(sender, 1, FAULT_STREAM_SENDS),
        ...toSeededFaultReleaseCommands(sender, JITTER, { decision: 'delay', floor: JITTER_DELAYED_FLOOR })
    ];
}
