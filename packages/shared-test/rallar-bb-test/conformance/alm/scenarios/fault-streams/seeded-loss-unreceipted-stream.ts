import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceCarrier } from '../../alm-conformance-carriers.ts';
import { toResultAssertion } from '../../alm-conformance-message-commands.ts';
import { toOrderedSendCommands } from '../../alm-conformance-ordering-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { STREAM_SENDS, toSeededLossCommand, toSequences } from './seeded-loss-stream.ts';

/** The server orders the track and asks for what it misses; over `rtc` a lost unreceipted frame has no such hop. */
const UNRECEIPTED_LOSS_CARRIERS: readonly AlmConformanceCarrier[] = ['ws'];

/**
 * An ordered unreceipted stream keeps every send under the seeded loss of `seeded-loss-stream`: all twenty arrive in
 * sequence order and nothing arrives twice, with no receipt to retry a send. A gap is repaired only once a later frame
 * reveals it, so the loss is released before the last send: send 20 always arrives and reveals what is still missing.
 * A lost last frame under `ack: 'none'` is a stated limit, pinned by `lost-repair-frame-stream.test.ts`. The release
 * must read at least one dropped frame.
 */
export const seededLossUnreceiptedStream: AlmConformanceScenarioDefinition = {
    scenarioId: 'seeded-loss-unreceipted-stream',
    scenarioKey: 'seeded-loss-unreceipted-stream',
    tags: FULL_TAGS,
    carriers: UNRECEIPTED_LOSS_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toSeededLossUnreceiptedStreamSenderCommands,
    toRecipientCommands: toSeededLossUnreceiptedStreamReceiverCommands
};

function toSeededLossUnreceiptedStreamSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toSeededLossCommand(sender, 'arm'),
        ...toSequences(1, STREAM_SENDS - 1).flatMap((seq) => toOrderedSendCommands(sender, seq, { ack: 'none' })),
        toSeededLossCommand(sender, 'release'),
        toResultAssertion({
            step: sender,
            name: 'assert-loss-dropped',
            resultName: 'loss-release',
            field: 'acted.drop',
            operator: 'gte',
            expected: 1
        }),
        ...toOrderedSendCommands(sender, STREAM_SENDS, { ack: 'none' })
    ];
}

function toSeededLossUnreceiptedStreamReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toReceivedCommand({ ...receiver, index: STREAM_SENDS, count: STREAM_SENDS, absent: false, ascendingBy: 'seq' }),
        toReceivedCommand({ ...receiver, index: STREAM_SENDS + 1, count: STREAM_SENDS + 1, absent: true })
    ];
}
