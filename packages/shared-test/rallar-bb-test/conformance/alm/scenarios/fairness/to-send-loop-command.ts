import type {
    RallarBlackBoxTestLoopCommand,
    RallarBlackBoxTestMessagesSendCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';

/**
 * The pause after each send of a loop, which awaits the send before it pauses: at most about 13 sends a second, under
 * the RTC lane's 20 a second limiter, which the receiver's own ACKs and control frames share.
 */
export const FAIRNESS_SEND_INTERVAL_MS = 75;

/**
 * The most one loop iteration, a send and its pause, may take. A send awaits its admission commit, so an iteration
 * runs far slower than the pause alone: on GitHub runners (runs 45009025510 to 45068154152) the 280-send loop of
 * `churn-bounded-tracks` averaged 328 to 648 ms an iteration, and while the receiver waited a send took a median of
 * up to 1,491 ms.
 */
const SEND_LOOP_ITERATION_CEILING_MS = 1_500;

/** The time a loop of `count` sends may take; the loop ends as soon as its sends are done. */
export function computeSendLoopBudgetMs(count: number): number {
    return count * SEND_LOOP_ITERATION_CEILING_MS;
}

interface AlmFairnessSendLoopInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    readonly count: number;
    readonly send: RallarBlackBoxTestMessagesSendCommand;
}

/**
 * `count` sends of one template, each awaited and then followed by a pause of `FAIRNESS_SEND_INTERVAL_MS`. A loop
 * substitutes `{loop.index}` (0-based) in every string of its template before the send runs, so each send names a
 * handle of its own, and a template may name its ordering key the same way.
 */
export function toSendLoopCommand(
    { step, name, count, send }: AlmFairnessSendLoopInput
): RallarBlackBoxTestLoopCommand {
    return {
        kind: 'loop',
        commandId: toCommandId(step, name),
        count,
        intervalMs: FAIRNESS_SEND_INTERVAL_MS,
        commands: [{ ...send, commandId: toCommandId(step, `${name}-send`), handleId: `${send.handleId}-{loop.index}` }]
    };
}
