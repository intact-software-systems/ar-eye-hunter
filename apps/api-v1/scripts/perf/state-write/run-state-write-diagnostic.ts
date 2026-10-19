import * as files from 'node:fs/promises';

import type { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import type { ResourceInboxAttemptReleaseTelemetry } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import type { StateWriteBenchmarkOptions } from './api-v1-state-write-benchmark-options.ts';
import { runStateWriteBenchmark } from './run-state-write-benchmark.ts';
import type {
    StateWriteBenchmarkDiagnosticPhase,
    StateWriteBenchmarkDiagnostics,
    StateWriteBenchmarkPhaseFacts
} from './state-write-benchmark-diagnostics.ts';
import { STATE_WRITE_DIAGNOSTIC_BUDGET } from './state-write-diagnostic-projection.ts';
import { StateWriteDiagnosticWriter } from './state-write-diagnostic-writer.ts';

export async function runStateWriteDiagnostic(options: StateWriteBenchmarkOptions): Promise<void> {
    if (options.diagnostics.kind !== 'enabled') {
        throw new TypeError('Diagnostic entry requires --diagnostics-dir');
    }
    await runStateWriteBenchmark(options, new StateWriteDiagnosticRun(options));
}

class StateWriteDiagnosticRun implements StateWriteBenchmarkDiagnostics {
    readonly writer: StateWriteDiagnosticWriter;
    constructor(options: StateWriteBenchmarkOptions) {
        this.writer = new StateWriteDiagnosticWriter(options.diagnostics, STATE_WRITE_DIAGNOSTIC_BUDGET, files);
    }
    async start(destination: string): Promise<void> {
        await this.writer.start(destination);
    }
    async readCanonicalDestinationIssues(destination: string): Promise<readonly string[]> {
        return await this.writer.readCanonicalDestinationIssues(destination);
    }
    async finish(completed: boolean) {
        return await this.writer.finish(completed);
    }
    createPhase(): StateWriteBenchmarkDiagnosticPhase {
        return new StateWriteDiagnosticPhaseCapture(this.writer);
    }
}

class StateWriteDiagnosticPhaseCapture implements StateWriteBenchmarkDiagnosticPhase {
    private readonly releases: ResourceInboxAttemptReleaseTelemetry[] = [];
    private readonly writer: StateWriteDiagnosticWriter;
    constructor(writer: StateWriteDiagnosticWriter) {
        this.writer = writer;
    }
    createInboxQueueReader(queue: PSqlQueueBox, ordinaryOptions: InboxQueueReader.Options): InboxQueueReader {
        return new InboxQueueReader(queue, {
            ...ordinaryOptions,
            reservationObservation: 'postgres-ordinary-retry-v1',
            onAttemptReleaseTelemetry: (event) => {
                ordinaryOptions.onAttemptReleaseTelemetry?.(event);
                this.releases.push(event);
            }
        });
    }
    async writePhase(facts: StateWriteBenchmarkPhaseFacts): Promise<void> {
        await this.writer.writePhase({ ...facts, releases: this.releases });
    }
}
