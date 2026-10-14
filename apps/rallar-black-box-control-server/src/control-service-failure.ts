import type { ControlDistributedRunCommandPhase } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { ControlDistributedRunState } from './control-service-state.ts';

export type ControlServiceFailureCode =
    | 'command-kind-not-allowed'
    | 'command-payload-conflict'
    | 'command-rate-limited'
    | 'distributed-run-exists'
    | 'distributed-run-not-found'
    | 'distributed-run-terminal';

export interface ControlServiceFailure {
    readonly code: ControlServiceFailureCode;
    readonly message: string;
}

export function toControlServiceFailure<TValue>(
    code: ControlServiceFailureCode,
    message: string
): Either<ControlServiceFailure, TValue> {
    return Either.ofLeft({ code, message });
}

export function toDistributedRunNotFound<TValue>(distributedRunId: string): Either<ControlServiceFailure, TValue> {
    return toControlServiceFailure('distributed-run-not-found', `Distributed run not found: ${distributedRunId}.`);
}

export function toDistributedRunTerminal<TValue>(
    distributedRun: ControlDistributedRunState,
    action: ControlDistributedRunCommandPhase
): Either<ControlServiceFailure, TValue> {
    return toControlServiceFailure(
        'distributed-run-terminal',
        `Cannot ${action} distributed run ${distributedRun.distributedRunId} in terminal state ${distributedRun.state}.`
    );
}
