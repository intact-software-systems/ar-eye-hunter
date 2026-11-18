import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_SINGLE_HOP_CARRIERS } from '../../alm-conformance-carriers.ts';
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

/**
 * One draw per matching frame, retransmissions included: the seed fixes how many of the first frames are lost, whatever
 * the timing of a run.
 */
const LOSS = { kind: 'loss', action: { loss: { ratio: 0.25, seed: 7 } } } as const;

/**
 * An ordered receipted stream keeps every send under a seeded loss of its own data frames: all twenty arrive in
 * sequence order, nothing arrives twice, and every handle ends `acknowledged`. Over `ws` the loss stands from the first
 * send: the server orders the track and asks for what it misses. Over `rtc` the first send is sent and acknowledged
 * before the loss is armed, so the receiver has entered the track at its start; what a lost start does there is
 * `lost-stream-start`'s to state. The cell runs where one hop carries the track, as `ordering-gap-repair` does.
 *
 * The loss is held, not counted: a count runs out after a number of frames, which a retry loop spends before the
 * window a cell means to cover. It stands while the sends are admitted and is released after the last one, so the
 * recovery that follows is not itself lossy.
 */
export const seededLossStream: AlmConformanceScenarioDefinition = {
    scenarioId: 'seeded-loss-stream',
    scenarioKey: 'seeded-loss-stream',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_SINGLE_HOP_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toSeededLossStreamSenderCommands,
    toRecipientCommands: (receiver) => toStreamReceivedCommands(receiver, FAULT_STREAM_SENDS)
};

function toSeededLossStreamSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const entered = sender.input.carrier === 'rtc' ? 1 : 0;
    return [
        ...toStreamSendCommands(sender, 1, entered),
        ...toStreamAcknowledgedCommands(sender, 1, entered),
        toSeededFaultArmCommand(sender, LOSS),
        ...toStreamSendCommands(sender, entered + 1, FAULT_STREAM_SENDS),
        ...toSeededFaultReleaseCommands(sender, LOSS, { decision: 'drop', floor: 1 }),
        ...toStreamAcknowledgedCommands(sender, entered + 1, FAULT_STREAM_SENDS)
    ];
}
