import type { RallarBlackBoxTestBarrierCommand } from '../../../rallar-black-box-test-contracts.ts';

import { toAlmCohortCommandPrefix } from './to-alm-cohort-command-prefix.ts';

export interface AlmCohortBarrierInput {
    /** The cohort's name: every role of it meets at the barrier `<scope>-<phase>`. */
    readonly scope: string;
    /** The role whose recipe holds the command, so each role's command keeps an id of its own. */
    readonly roleName: string;
    readonly phase: string;
    readonly timeoutMs: number;
}

/** One phase every agent of a cohort reaches before any of them goes on. */
export function createAlmCohortBarrier(barrier: AlmCohortBarrierInput): RallarBlackBoxTestBarrierCommand {
    return {
        kind: 'barrier',
        commandId: `${toAlmCohortCommandPrefix(barrier.scope, barrier.roleName)}-${barrier.phase}`,
        barrierId: `${barrier.scope}-${barrier.phase}`,
        timeoutMs: barrier.timeoutMs
    };
}
