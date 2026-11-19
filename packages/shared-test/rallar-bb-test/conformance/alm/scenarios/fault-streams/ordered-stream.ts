import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';

/** The sends of the ordered stream a fault-stream cell disturbs. */
export const STREAM_SENDS = 20;

export function toSequences(from: number, to: number): readonly number[] {
    return Array.from({ length: to - from + 1 }, (_, offset) => from + offset);
}

/** Every send of the stream arrives, in sequence order, and nothing arrives twice. */
export function toOrderedStreamReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toReceivedCommand({ ...receiver, index: STREAM_SENDS, count: STREAM_SENDS, absent: false, ascendingBy: 'seq' }),
        toReceivedCommand({ ...receiver, index: STREAM_SENDS + 1, count: STREAM_SENDS + 1, absent: true })
    ];
}
