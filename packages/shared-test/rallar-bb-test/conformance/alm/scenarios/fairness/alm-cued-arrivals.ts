import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { toSenderStorageBaselineCommand } from '../../alm-conformance-cell-parts.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { computeCommandsTimeoutMs } from '../../cell/compute-commands-timeout-ms.ts';
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
    /** The sender's body up to its cue; every command in it but a close names its own timeout, which sizes the wait. */
    readonly toSends: (sender: AlmConformanceStepInput) => readonly RallarBlackBoxTestCommand[];
}

/** The sender's sends, then its cue. */
export function toCuedArrivalsSenderCommands(
    sender: AlmConformanceStepInput,
    arrivals: AlmCuedArrivals
): readonly RallarBlackBoxTestCommand[] {
    return [...arrivals.toSends(sender), ...toCuedArrivalsCueCommands(sender, arrivals)];
}

/** The sender's cue that its sends are done; it has left the page once its handle reads `transport-accepted`. */
export function toCuedArrivalsCueCommands(
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
 * The receiver's wait for the cue opens with the sender's body, so it covers every sender command the body runs up to
 * and including the cue: the storage baseline that opens a sender's body, since the sender does not lead with a cue
 * subscription, then its sends and its cue. A command's timeout reads only the cell's input, so any role's step sizes
 * the sender's commands. It is the cell's longest step: each role's recipe runs that much longer than an ordinary one.
 */
export function computeCuedArrivalsWaitMs(step: AlmConformanceStepInput, arrivals: AlmCuedArrivals): number {
    const sender: AlmConformanceStepInput = { ...step, role: 'sender' };
    return computeCommandsTimeoutMs(
        [toSenderStorageBaselineCommand(sender), ...toCuedArrivalsSenderCommands(sender, arrivals)],
        `the receiver's wait for the ${arrivals.cue} cue`
    );
}
