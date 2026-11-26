import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { toHeldMessageFaultCommands, toHeldSendCommands } from '../../alm-conformance-fault-commands.ts';
import { toSentCommands } from '../../alm-conformance-ordering-commands.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toPauseCommand } from '../../to-pause-command.ts';
import { STREAM_SENDS, toSequences } from './ordered-stream.ts';

export interface ReorderedStreamInput {
    readonly sender: AlmConformanceStepInput;
    /** One send of the stream and its admission, by its sequence. */
    readonly toSend: (seq: number) => readonly RallarBlackBoxTestCommand[];
    /** The longest a frame the page sent may wait before its socket write. */
    readonly longestFrameDelayMs: number;
}

/** The send the stream holds, and the later one that reaches the server first. */
const HELD_SEQ = 2;
const OVERTAKING_SEQ = 3;

/**
 * The stream's sends, of which send 2 reaches the server after send 3. The hold arms once send 1 has left the page, so
 * it meets send 2 alone, and keeps send 2 by its message id until send 3 has left the page and a frame's longest delay
 * before its socket write has passed: send 3 is then on the socket first, so the server meets a gap whatever else
 * delays the frames.
 */
export function toReorderedStreamSendCommands(
    { sender, toSend, longestFrameDelayMs }: ReorderedStreamInput
): readonly RallarBlackBoxTestCommand[] {
    const held = { ...sender, index: HELD_SEQ };
    return [
        ...toSequences(1, HELD_SEQ - 1).flatMap(toSend),
        ...toSentCommands({ ...sender, index: HELD_SEQ - 1 }),
        ...toHeldSendCommands(held, toSend(HELD_SEQ)),
        ...toSend(OVERTAKING_SEQ),
        ...toSentCommands({ ...sender, index: OVERTAKING_SEQ }),
        toPauseCommand(sender, `frame-delay-${OVERTAKING_SEQ}`, longestFrameDelayMs),
        ...toHeldMessageFaultCommands(held, `release-message-${HELD_SEQ}`, 0),
        ...toSequences(OVERTAKING_SEQ + 1, STREAM_SENDS).flatMap(toSend)
    ];
}
