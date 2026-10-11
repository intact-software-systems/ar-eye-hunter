import type * as files from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { StateWriteDiagnosticConfiguration } from './api-v1-state-write-benchmark-options.ts';
import { computeStateWriteDiagnosticPhase } from './state-write-diagnostic-projection.ts';
import type { StateWriteDiagnosticBudget, StateWriteDiagnosticPhase } from './state-write-diagnostic-projection.ts';

export interface StateWriteDiagnosticFilePort {
    readonly mkdir: typeof files.mkdir;
    readonly open: typeof files.open;
    readonly rename: typeof files.rename;
}

export interface StateWriteDiagnosticStatus {
    readonly kind: 'disabled' | 'complete' | 'incomplete';
    readonly stage: 'none' | 'reservation' | 'projection' | 'phase-write' | 'operation' | 'receipt' | 'capacity';
    readonly phases: number;
    readonly bytes: number;
}

const RECEIPT_RESERVE_BYTES = 1024;

export class StateWriteDiagnosticWriter {
    private readonly configuration: StateWriteDiagnosticConfiguration;
    private readonly budget: StateWriteDiagnosticBudget;
    private readonly files: StateWriteDiagnosticFilePort;
    private reserved = false;
    private phases = 0;
    private bytes = 0;
    private stage: StateWriteDiagnosticStatus['stage'] = 'none';
    private finished: StateWriteDiagnosticStatus | undefined;

    constructor(
        configuration: StateWriteDiagnosticConfiguration,
        budget: StateWriteDiagnosticBudget,
        files: StateWriteDiagnosticFilePort
    ) {
        this.configuration = configuration;
        this.budget = budget;
        this.files = files;
    }

    async start(): Promise<void> {
        if (this.configuration.kind === 'disabled' || this.reserved || this.stage !== 'none') {
            return;
        }
        try {
            await this.files.mkdir(dirname(this.configuration.directory), { recursive: true });
            await this.files.mkdir(this.configuration.directory, { mode: 0o700 });
            this.reserved = true;
        }
        catch {
            this.stage = 'reservation';
        }
    }

    async writePhase(phase: StateWriteDiagnosticPhase): Promise<void> {
        if (this.configuration.kind === 'disabled' || !this.reserved || this.finished) {
            return;
        }
        const ordinal = this.phases++;
        let projection;
        try {
            projection = computeStateWriteDiagnosticPhase(
                phase,
                this.budget,
                Math.max(0, this.budget.bytesPerRun - RECEIPT_RESERVE_BYTES - this.bytes)
            );
        }
        catch {
            this.recordFailure('projection');
            return;
        }
        if (!projection.complete) {
            this.recordFailure('projection');
        }
        if (projection.bytes === 0) {
            return;
        }
        this.bytes += projection.bytes;
        const written = await this.writeExclusive(
            join(this.configuration.directory, `phase-${ordinal}.ndjson`),
            projection.serialized
        );
        if (!written) {
            this.recordFailure('phase-write');
        }
    }

    async finish(operationCompleted: boolean): Promise<StateWriteDiagnosticStatus> {
        if (this.finished) {
            return this.finished;
        }
        if (this.configuration.kind === 'disabled') {
            return { kind: 'disabled', stage: 'none', phases: 0, bytes: 0 };
        }
        if (!operationCompleted) {
            this.recordFailure('operation');
        }
        if (!this.reserved) {
            this.recordFailure('reservation');
        }
        const status: StateWriteDiagnosticStatus = {
            kind: this.stage === 'none' ? 'complete' : 'incomplete',
            stage: this.stage,
            phases: this.phases,
            bytes: this.bytes
        };
        const receipt = JSON.stringify({
            ...status,
            byteAccounting: 'phase-bytes-reserved-including-failed-writes',
            receiptReserveBytes: RECEIPT_RESERVE_BYTES
        }) + '\n';
        const receiptBytes = new TextEncoder().encode(receipt).length;
        if (this.reserved && receiptBytes <= Math.min(RECEIPT_RESERVE_BYTES, this.budget.bytesPerRun - this.bytes)) {
            if (!await this.writeExclusive(join(this.configuration.directory, 'receipt.json'), receipt)) {
                this.recordFailure('receipt');
            }
        }
        else if (this.reserved) {
            this.recordFailure('capacity');
        }
        this.finished = { ...status, kind: this.stage === 'none' ? 'complete' : 'incomplete', stage: this.stage };
        return this.finished;
    }

    private recordFailure(stage: StateWriteDiagnosticStatus['stage']): void {
        if (this.stage === 'none') {
            this.stage = stage;
        }
    }

    private async writeExclusive(path: string, serialized: string): Promise<boolean> {
        let handle: Awaited<ReturnType<StateWriteDiagnosticFilePort['open']>> | undefined;
        let written = false;
        try {
            handle = await this.files.open(`${path}.partial`, 'wx', 0o600);
            await handle.writeFile(serialized, 'utf8');
            written = true;
        }
        catch {
            written = false;
        }
        finally {
            try {
                await handle?.close();
            }
            catch {
                written = false;
            }
        }
        if (!written) {
            return false;
        }
        try {
            const reservation = await this.files.open(path, 'wx', 0o600);
            await reservation.close();
            await this.files.rename(`${path}.partial`, path);
            return true;
        }
        catch {
            return false;
        }
    }
}
