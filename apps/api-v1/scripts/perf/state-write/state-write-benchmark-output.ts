import * as files from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StateWriteBenchmarkArtifact } from './api-v1-state-write-benchmark-artifact.ts';
import type { StateWriteDiagnosticStatus, StateWriteDiagnosticWriter } from './state-write-diagnostic-writer.ts';

export interface StateWriteBenchmarkOutput {
    readonly artifact: StateWriteBenchmarkArtifact;
    readonly destination: string;
    readonly diagnostics: StateWriteDiagnosticWriter;
}

export async function writeStateWriteBenchmarkOutput(
    output: StateWriteBenchmarkOutput
): Promise<StateWriteDiagnosticStatus> {
    await files.mkdir(dirname(output.destination), { recursive: true });
    await files.writeFile(output.destination, `${JSON.stringify(output.artifact, null, 2)}\n`);
    return await output.diagnostics.finish(true);
}
