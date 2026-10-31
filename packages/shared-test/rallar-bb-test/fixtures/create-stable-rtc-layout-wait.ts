import type { RallarBlackBoxDistributedGroupRef } from '../distributed-run.ts';
import type { RallarBlackBoxTestLoopCommand } from '../rallar-black-box-test-contracts.ts';

/** The scale lane measured follow-up replanning 2.7 s after acceptance; retain its 3.5 s observation window. */
const LAYOUT_QUIET_WINDOW_MS = 3_500;
const LAYOUT_RECHECK_INTERVAL_MS = 500;
const LAYOUT_READINESS_TIMEOUT_MS = 5_000;

interface StableRtcLayoutWaitInput {
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly prefix: string;
    readonly timeoutMs: number;
}

/**
 * Observe the current accepted layout throughout setup. Readiness is a point observation, so a planned-event
 * absence alone cannot prove it survived a group-first authority change. The formation owner resets the hold
 * when authority advances or the accepted body disappears. This bounds fixture setup, never message retries.
 */
export function createStableRtcLayoutWait(input: StableRtcLayoutWaitInput): RallarBlackBoxTestLoopCommand {
    const { prefix } = input;
    return {
        kind: 'loop',
        commandId: `${prefix}-layout-stable`,
        count: Math.ceil(input.timeoutMs / LAYOUT_RECHECK_INTERVAL_MS),
        intervalMs: LAYOUT_RECHECK_INTERVAL_MS,
        timeoutMs: input.timeoutMs,
        until: 'first-success',
        commands: [
            {
                kind: 'formation.readiness',
                commandId: `${prefix}-layout-readiness`,
                roomRef: { ...input.group },
                timeoutMs: LAYOUT_READINESS_TIMEOUT_MS
            },
            {
                kind: 'assert',
                commandId: `${prefix}-assert-no-pending-layout`,
                operator: 'equals',
                source: `resultCache.${prefix}-layout-stable:i{loop.iteration}:c1:` +
                    `${prefix}-layout-readiness.value.hasPendingLayout`,
                expected: false
            },
            {
                kind: 'assert',
                commandId: `${prefix}-assert-layout-stable`,
                operator: 'gte',
                source: `resultCache.${prefix}-layout-stable:i{loop.iteration}:c1:` +
                    `${prefix}-layout-readiness.value.acceptedHeldForMs`,
                expected: LAYOUT_QUIET_WINDOW_MS
            }
        ]
    };
}
