import {
    runRallarAiEvaluationSuite,
    type RallarAiEvaluationSuiteResult,
    type RunRallarAiEvaluationSuiteInput,
} from './rallar-ai-evaluation.ts';

export type RallarAiLiveEvaluationEnvironment = Readonly<
    Record<string, string | undefined>
>;

export type RallarAiLiveEvaluationRunResult = Readonly<
    | {
        status: 'skipped';
        gate: string;
        reason: string;
    }
    | {
        status: 'ran';
        gate: string;
        report: RallarAiEvaluationSuiteResult;
    }
>;

export function isRallarAiLiveEvaluationEnabled(
    env: RallarAiLiveEvaluationEnvironment,
    gate: string,
): boolean {
    const value = env[gate]?.trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'yes' ||
        value === 'on';
}

export async function runRallarAiEvaluationSuiteIfEnabled(
    input: RunRallarAiEvaluationSuiteInput & Readonly<{
        env: RallarAiLiveEvaluationEnvironment;
        gate: string;
        providerLabel?: string;
    }>,
): Promise<RallarAiLiveEvaluationRunResult> {
    if (!isRallarAiLiveEvaluationEnabled(input.env, input.gate)) {
        return {
            status: 'skipped',
            gate: input.gate,
            reason: `${input.providerLabel ?? input.provider.providerId} live evaluation requires ${input.gate}=1.`,
        };
    }

    return {
        status: 'ran',
        gate: input.gate,
        report: await runRallarAiEvaluationSuite(input),
    };
}
