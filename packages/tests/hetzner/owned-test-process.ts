import { execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import type { TestContext } from 'vitest';
import { toError } from '../../shared/resilience/to-error.ts';

export interface OwnedTestProcessInput {
    readonly executable: string;
    readonly args: readonly string[];
    readonly options: ExecFileOptions;
}

export interface OwnedTestProcessOutcome {
    readonly stdout: string;
    readonly stderr: string;
}

const execFileAsync = promisify(execFile);

export async function runOwnedTestProcess(context: TestContext, input: OwnedTestProcessInput): Promise<OwnedTestProcessOutcome> {
    const signal = input.options.signal === undefined
        ? context.signal
        : AbortSignal.any([context.signal, input.options.signal]);
    const execution = execFileAsync(input.executable, [...input.args], { ...input.options, encoding: 'utf8', signal });
    const closed = new Promise<void>((resolve) => execution.child.once('close', () => resolve()));
    const outcome = execution.then(
        (output) => ({ output, error: null }),
        (reason) => ({ output: null, error: toError(reason) })
    );
    let accounted = false;
    // Vitest runs finish hooks in reverse registration order: this hook is
    // registered after directory acquisition, so it joins the child before rm.
    context.onTestFinished(async () => {
        if (execution.child.exitCode === null && execution.child.signalCode === null) {
            execution.child.kill('SIGKILL');
        }
        await closed;
        const settled = await outcome;
        if (!accounted && settled.error !== null) {
            throw settled.error;
        }
    });
    const settled = await outcome;
    await closed;
    accounted = true;
    if (settled.error !== null) {
        throw settled.error;
    }
    return settled.output;
}
