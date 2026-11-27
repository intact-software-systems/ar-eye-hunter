import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { toOrderedSendCommands } from '../../alm-conformance-ordering-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { resolveAlmCarrierMatrixCellCarriers } from '../../carrier-matrix/resolve-alm-carrier-matrix-cell-carriers.ts';
import { STREAM_SENDS, toOrderedStreamReceiverCommands, toSequences } from './ordered-stream.ts';
import { toLossDroppedAssertion, toSeededLossCommand } from './seeded-loss-stream.ts';

/**
 * An ordered unreceipted stream keeps every send under the seeded loss of `seeded-loss-stream`: all twenty arrive in
 * sequence order and nothing arrives twice, with no receipt to retry a send. A gap is repaired only once a later frame
 * reveals it, so the loss is released before the last send: send 20 always arrives and reveals what is still missing.
 * A lost last frame under `ack: 'none'` is a stated limit, pinned by `lost-repair-frame-stream.test.ts`. The release
 * must read at least one dropped frame. The cell runs over `ws`, where the server orders the track and asks for what it
 * misses; over `rtc` a lost unreceipted frame has no such hop.
 */
export const seededLossUnreceiptedStream: AlmConformanceScenarioDefinition = {
    scenarioId: 'seeded-loss-unreceipted-stream',
    scenarioKey: 'seeded-loss-unreceipted-stream',
    tags: FULL_TAGS,
    carriers: resolveAlmCarrierMatrixCellCarriers('seeded-loss-unreceipted-stream'),
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toSeededLossUnreceiptedStreamSenderCommands,
    toRecipientCommands: toOrderedStreamReceiverCommands
};

function toSeededLossUnreceiptedStreamSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toSeededLossCommand(sender, 'arm'),
        ...toSequences(1, STREAM_SENDS - 1).flatMap((seq) => toOrderedSendCommands(sender, seq, { ack: 'none' })),
        toSeededLossCommand(sender, 'release'),
        toLossDroppedAssertion(sender),
        ...toOrderedSendCommands(sender, STREAM_SENDS, { ack: 'none' })
    ];
}
