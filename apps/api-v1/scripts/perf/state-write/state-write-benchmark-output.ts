import * as files from 'node:fs/promises';
import { dirname } from 'node:path';

import type { StateWriteBenchmarkArtifact } from './api-v1-state-write-benchmark-artifact.ts';

export interface StateWriteDiagnosticStatus {
    readonly kind: 'disabled' | 'complete' | 'incomplete';
    readonly stage: 'none' | 'reservation' | 'projection' | 'phase-write' | 'operation' | 'receipt' | 'capacity';
    readonly phases: number;
    readonly bytes: number;
}

export interface StateWriteDiagnosticOutput {
    readCanonicalDestinationIssues(destination: string): Promise<readonly string[]>;
    finish(operationCompleted: boolean): Promise<StateWriteDiagnosticStatus>;
}

export interface StateWriteBenchmarkOutput {
    readonly artifact: StateWriteBenchmarkArtifact;
    readonly destination: string;
    readonly diagnostics?: StateWriteDiagnosticOutput;
}

export async function writeStateWriteBenchmarkOutput(
    output: StateWriteBenchmarkOutput
): Promise<StateWriteDiagnosticStatus> {
    try {
        const issues = await output.diagnostics?.readCanonicalDestinationIssues(output.destination) ?? [];
        if (issues.length > 0) {
            throw new Error(issues.join('; '));
        }
        await files.mkdir(dirname(output.destination), { recursive: true });
        await files.writeFile(output.destination, `${JSON.stringify(output.artifact, null, 2)}\n`);
    }
    catch (error) {
        await output.diagnostics?.finish(false);
        throw error;
    }
    return await output.diagnostics?.finish(true) ?? { kind: 'disabled', stage: 'none', phases: 0, bytes: 0 };
}
