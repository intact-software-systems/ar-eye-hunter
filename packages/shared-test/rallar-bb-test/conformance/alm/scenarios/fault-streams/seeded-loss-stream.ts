import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestTransportFaultInjectCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import { toBudgetMs } from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_SINGLE_HOP_CARRIERS } from '../../alm-conformance-carriers.ts';
import { FAULT_TIMEOUT_MS } from '../../alm-conformance-fault-commands.ts';
import { toResultAssertion } from '../../alm-conformance-message-commands.ts';
import { toOrderedSendCommands } from '../../alm-conformance-ordering-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toCommandId, toScenarioTypeId } from '../../alm-conformance-step-identities.ts';
import { toSettledStateCommands } from '../../to-settled-state-commands.ts';
import { STREAM_SENDS, toOrderedStreamReceiverCommands, toSequences } from './ordered-stream.ts';

/**
 * One draw per matching frame, retransmissions included: the seed fixes how many of the first frames are lost, whatever
 * the timing of a run.
 */
const LOSS = { loss: { ratio: 0.25, seed: 7 } } as const;

/**
 * An ordered receipted stream keeps every send under a seeded loss of its own data frames: all twenty arrive in
 * sequence order, nothing arrives twice, and every handle ends `acknowledged`. Over `ws` the loss stands from the first
 * send: the server orders the track and asks for what it misses. Over `rtc` the first send is sent and acknowledged
 * before the loss is armed, so the receiver has entered the track at its start; what a lost start does there is
 * `lost-stream-start`'s to state. The cell runs where one hop carries the track, as `ordering-gap-repair` does.
 *
 * The loss is held, not counted: a count runs out after a number of frames, which a retry loop spends before the
 * window a cell means to cover. It stands while the sends are admitted and is released after the last one, so the
 * recovery that follows is not itself lossy. The release must read at least one dropped frame.
 */
export const seededLossStream: AlmConformanceScenarioDefinition = {
    scenarioId: 'seeded-loss-stream',
    scenarioKey: 'seeded-loss-stream',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_SINGLE_HOP_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toSeededLossStreamSenderCommands,
    toRecipientCommands: toOrderedStreamReceiverCommands
};

function toSeededLossStreamSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const entered = sender.input.carrier === 'rtc' ? 1 : 0;
    return [
        ...toSequences(1, entered).flatMap((seq) => toOrderedSendCommands(sender, seq, { ack: 'receiver' })),
        ...toSequences(1, entered).flatMap((seq) => toSettledStateCommands({ ...sender, index: seq }, 'acknowledged')),
        toSeededLossCommand(sender, 'arm'),
        ...toSequences(entered + 1, STREAM_SENDS).flatMap((seq) =>
            toOrderedSendCommands(sender, seq, { ack: 'receiver' })
        ),
        toSeededLossCommand(sender, 'release'),
        toLossDroppedAssertion(sender),
        ...toSequences(entered + 1, STREAM_SENDS).flatMap((seq) =>
            toSettledStateCommands({ ...sender, index: seq }, 'acknowledged')
        )
    ];
}

/** The loss's release read at least one dropped frame, so the loss disturbed the stream. */
export function toLossDroppedAssertion(sender: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return toResultAssertion({
        step: sender,
        name: 'assert-loss-dropped',
        resultName: 'loss-release',
        field: 'acted.drop',
        operator: 'gte',
        expected: 1
    });
}

/** Held on the data frames of the cell's type until its release. A control frame carries another type and passes. */
export function toSeededLossCommand(
    sender: AlmConformanceStepInput,
    phase: 'arm' | 'release'
): RallarBlackBoxTestTransportFaultInjectCommand {
    const carrier = sender.input.carrier === 'ws' ? 'ws' : 'rtc';
    const typeId = toScenarioTypeId(sender);
    return {
        kind: 'fault.inject',
        commandId: toCommandId(sender, `loss-${phase}`),
        faultId: `loss-${carrier}-${typeId}`,
        carrier,
        match: { typeId },
        action: LOSS,
        remaining: phase === 'arm' ? 'until-cleared' : 0,
        timeoutMs: toBudgetMs(FAULT_TIMEOUT_MS, sender.input.deadlineMs)
    };
}
