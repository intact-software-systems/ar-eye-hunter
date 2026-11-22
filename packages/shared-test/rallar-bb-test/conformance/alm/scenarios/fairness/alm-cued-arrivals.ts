import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCueStep } from '../receipted-audience.ts';
import {
    toCueListenCommands,
    toCueSendCommands,
    toCueWait
} from '../topic-subscription/topic-subscription-publications.ts';

/**
 * A cell whose receiver counts its arrivals only once the sender cued that its sends are done, however long they took.
 * A count reads every arrival its page logged, those before the count started too.
 */
export interface AlmCuedArrivals {
    readonly cue: string;
    readonly count: number;
    /** The sender's body up to its cue; every command in it names its own timeout, except a close. */
    readonly toSends: (sender: AlmConformanceStepInput) => readonly RallarBlackBoxTestCommand[];
}

/** The sender's sends, then its cue. */
export function toCuedArrivalsSenderCommands(
    sender: AlmConformanceStepInput,
    arrivals: AlmCuedArrivals
): readonly RallarBlackBoxTestCommand[] {
    return [...arrivals.toSends(sender), ...toArrivalsCueCommands(sender, arrivals)];
}

/** The sender's cue that its sends are done; it has left the page once its handle reads `transport-accepted`. */
export function toArrivalsCueCommands(
    sender: AlmConformanceStepInput,
    arrivals: AlmCuedArrivals
): readonly RallarBlackBoxTestCommand[] {
    return toCueSendCommands(toCueStep(sender), arrivals.cue);
}

/**
 * The receiver listens in its arming run, waits for the sender's cue, then counts with a positive window that opens at
 * the cue.
 */
export function toCuedArrivalsReceiverCommands(
    receiver: AlmConformanceStepInput,
    arrivals: AlmCuedArrivals
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(toCueStep(receiver)),
        { ...toCueWait(toCueStep(receiver), arrivals.cue), timeoutMs: computeCuedArrivalsWaitMs(receiver, arrivals) },
        toReceivedCommand({ ...receiver, index: 1, count: arrivals.count, absent: false })
    ];
}

/**
 * The receiver's wait for the cue opens with the sender's body, so it covers every sender command up to and including
 * the cue. A command's timeout reads only the cell's input, so any role's step sizes the sender's commands. It is the
 * cell's longest step: each role's recipe runs that much longer than an ordinary one.
 */
export function computeCuedArrivalsWaitMs(step: AlmConformanceStepInput, arrivals: AlmCuedArrivals): number {
    return computeCommandsTimeoutMs(toCuedArrivalsSenderCommands({ ...step, role: 'sender' }, arrivals));
}

/**
 * The longest `commands` may take one after another: each command's own timeout, and a connect's readiness wait after
 * it; a close names none and adds none.
 */
export function computeCommandsTimeoutMs(commands: readonly RallarBlackBoxTestCommand[]): number {
    return commands.reduce((sum, command) => {
        const readinessMs = command.kind === 'rtc.connect' ? command.readiness?.timeoutMs ?? 0 : 0;
        return sum + (command.timeoutMs ?? 0) + readinessMs;
    }, 0);
}
