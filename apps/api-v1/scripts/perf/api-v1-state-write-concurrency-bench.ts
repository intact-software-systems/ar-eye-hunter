import {
    parseBenchmarkOptions,
    type StateWriteBenchmarkOptions
} from './state-write/api-v1-state-write-benchmark-options.ts';
import { runStateWriteBenchmark } from './state-write/run-state-write-benchmark.ts';

interface StateWriteDiagnosticEntry {
    runStateWriteDiagnostic(options: StateWriteBenchmarkOptions): Promise<void>;
}

/** The fixed diagnostic module is admitted before it can open a database or start work. */
async function runStateWriteBenchmarkMode(options: StateWriteBenchmarkOptions): Promise<void> {
    if (options.diagnostics.kind === 'disabled') {
        await runStateWriteBenchmark(options);
        return;
    }
    const diagnosticModuleUrl = new URL('./state-write/run-state-write-diagnostic.ts', import.meta.url).href;
    const diagnosticModule: unknown = await import(diagnosticModuleUrl);
    if (
        diagnosticModule === null || typeof diagnosticModule !== 'object' ||
        !('runStateWriteDiagnostic' in diagnosticModule) ||
        typeof diagnosticModule.runStateWriteDiagnostic !== 'function'
    ) {
        throw new TypeError('State-write diagnostic module has no runStateWriteDiagnostic entry');
    }
    await (diagnosticModule as StateWriteDiagnosticEntry).runStateWriteDiagnostic(options);
}

if (import.meta.main) {
    await runStateWriteBenchmarkMode(parseBenchmarkOptions(Deno.args));
}
