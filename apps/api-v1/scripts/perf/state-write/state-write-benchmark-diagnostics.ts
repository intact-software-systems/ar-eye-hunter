import type { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import type { StateWriteDiagnosticOutput } from './state-write-benchmark-output.ts';
import type { StateWriteCommandBoundary, StateWriteDiagnosticCommand } from './state-write-workload.ts';

export interface StateWriteBenchmarkPhaseFacts {
    readonly workload: 'uncontended' | 'shared' | 'hot';
    readonly phase: 'warmup' | 'measured';
    readonly runIndex: number;
    readonly scope: StateScope;
    readonly groupCount: number;
    readonly serviceIds: readonly string[];
    readonly performanceTimeOriginEpochMs: number;
    readonly startedAtMonotonicMs: number;
    readonly endedAtMonotonicMs: number | 'unavailable';
    readonly commands: readonly StateWriteDiagnosticCommand[];
    readonly boundaries: readonly StateWriteCommandBoundary[];
    readonly timingEvents: readonly RallarTimingEvent[];
    readonly outcome: 'completed' | 'operation-failed';
}

export interface StateWriteBenchmarkDiagnostics extends StateWriteDiagnosticOutput {
    start(canonicalDestination: string): Promise<void>;
    createPhase(): StateWriteBenchmarkDiagnosticPhase;
}

export interface StateWriteBenchmarkDiagnosticPhase {
    createInboxQueueReader(queue: PSqlQueueBox, ordinaryOptions: InboxQueueReader.Options): InboxQueueReader;
    writePhase(facts: StateWriteBenchmarkPhaseFacts): Promise<void>;
}
