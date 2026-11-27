import { describe, expect, it } from 'vitest';
import {
    createDefaultRallarBlackBoxTestRuntime,
    type RallarBlackBoxTestLoopCommand,
    type RallarBlackBoxTestRtcSendCommand,
    type RallarBlackBoxTestRuntime
} from '../../../shared-test/rallar-bb-test/mod.ts';
import { isJsonRecordValue } from '../../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';

const LOOP_STARTED_AT_EPOCH_MS = 1_800_000_000_000;
const SEND_DURATION_MS = 250;

/** Three sends that carry the stamp alone, beside the elapsed time, and inside a longer string. */
const STAMPED_SEND_LOOP: RallarBlackBoxTestLoopCommand = {
    kind: 'loop',
    commandId: 'stamped-loop',
    count: 3,
    commands: [
        {
            kind: 'rtc.send',
            commandId: 'stamped-send',
            send: {
                data: {
                    sentAtEpochMs: '{loop.atEpochMs}',
                    elapsedMs: '{loop.elapsedMs}',
                    label: 'at-{loop.atEpochMs}'
                }
            }
        }
    ]
};

interface CapturingRuntime {
    readonly runtime: RallarBlackBoxTestRuntime;
    readonly sentCommands: readonly RallarBlackBoxTestRtcSendCommand[];
}

/** `readClock` is the runtime clock; `afterSend` runs once each send has been captured as the loop resolved it. */
function createCapturingRuntime(readClock: () => number, afterSend: () => void): CapturingRuntime {
    const sentCommands: RallarBlackBoxTestRtcSendCommand[] = [];
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        now: readClock,
        commandExecutor: (command, context) => {
            if (command.kind !== 'rtc.send') {
                return undefined;
            }
            sentCommands.push(command);
            afterSend();
            return { status: 'ok', value: {}, nextStatus: context.state().status };
        }
    });
    return { runtime, sentCommands };
}

/** The loop start one child saw: its stamp less its elapsed time. Not a number while either placeholder is unresolved. */
function computeLoopStartSeenByChild(command: RallarBlackBoxTestRtcSendCommand): number {
    const payload = isJsonRecordValue(command.send) ? command.send.data : undefined;
    return isJsonRecordValue(payload) &&
            typeof payload.sentAtEpochMs === 'number' &&
            typeof payload.elapsedMs === 'number'
        ? payload.sentAtEpochMs - payload.elapsedMs
        : Number.NaN;
}

describe('rallar-bb runtime loop epoch placeholder', () => {
    it('resolves {loop.atEpochMs} to the runtime clock at each child command\'s start, as a number', async () => {
        let now = LOOP_STARTED_AT_EPOCH_MS;
        const { runtime, sentCommands } = createCapturingRuntime(() => now, () => {
            now += SEND_DURATION_MS;
        });

        const result = await runtime.execute(STAMPED_SEND_LOOP);

        expect(result.ok).toBe(true);
        expect(sentCommands.map((command) => command.send)).toEqual([
            { data: { sentAtEpochMs: 1_800_000_000_000, elapsedMs: 0, label: 'at-1800000000000' } },
            { data: { sentAtEpochMs: 1_800_000_000_250, elapsedMs: 250, label: 'at-1800000000250' } },
            { data: { sentAtEpochMs: 1_800_000_000_500, elapsedMs: 500, label: 'at-1800000000500' } }
        ]);
    });

    it('takes {loop.atEpochMs} and {loop.elapsedMs} of one child from one clock read', async () => {
        let now = LOOP_STARTED_AT_EPOCH_MS;
        // Every read moves this clock, so a stamp and an elapsed time taken from two reads would disagree.
        const { runtime, sentCommands } = createCapturingRuntime(() => now++, () => undefined);

        const result = await runtime.execute(STAMPED_SEND_LOOP);

        expect(result.ok).toBe(true);
        expect(sentCommands).toHaveLength(3);
        for (const loopStartSeenByChild of sentCommands.map(computeLoopStartSeenByChild)) {
            expect(result.value).toMatchObject({ pacing: { startedAtEpochMs: loopStartSeenByChild } });
        }
    });
});
