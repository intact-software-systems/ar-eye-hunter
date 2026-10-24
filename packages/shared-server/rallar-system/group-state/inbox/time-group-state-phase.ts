import type { StateScope } from '@shared/api/state-types.ts';

import { timeRallarAsync, type RallarTimingSink } from '../../observability/timing.ts';

export interface GroupStatePhaseTiming {
    readonly timing: RallarTimingSink | undefined;
    readonly component: 'group-retention' | 'group-quick-join';
    readonly serviceId: string;
    readonly requestId: string;
    readonly scope: StateScope;
    /** Quick Join has no selected room when its read begins. */
    readonly groupId: string | undefined;
    /** Internal maintenance has no authenticated principal or session. */
    readonly principalId: string | undefined;
    readonly sessionId: string | undefined;
    readonly attempt: number;
}

type GroupStatePhaseOperation = 'read' | 'compute' | 'validate' | 'write';

/** Measures a shell phase. Write includes atomic completion; clocks and sinks stay outside its transaction. */
export async function timeGroupStatePhase<Result>(
    input: GroupStatePhaseTiming,
    operation: GroupStatePhaseOperation,
    action: () => Result | Promise<Result>
): Promise<Result> {
    return await timeRallarAsync(input.timing, {
        component: input.component,
        operation,
        serviceId: input.serviceId,
        requestId: input.requestId,
        ...input.scope,
        groupId: input.groupId,
        principalId: input.principalId,
        sessionId: input.sessionId,
        details: { attempt: input.attempt }
    }, async () => await action());
}
