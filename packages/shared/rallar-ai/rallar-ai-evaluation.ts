import { canonicalRallarAiJson } from './rallar-ai-hashing.ts';
import type { RallarAiJsonProvider, RallarAiJsonRequest, RallarAiJsonResult } from './rallar-ai-types.ts';

export type RallarAiEvaluationCase<TValue = unknown, TContext = unknown> = Readonly<{
    caseId: string;
    request: RallarAiJsonRequest<TContext>;
    expectedValue?: TValue;
    expectValidationOk?: boolean;
    validateResult?: (
        result: RallarAiJsonResult<TValue>
    ) => readonly string[] | void;
}>;

export type RallarAiEvaluationCaseResult<TValue = unknown> = Readonly<{
    caseId: string;
    ok: boolean;
    providerId: string;
    modelId?: string;
    validationOk?: boolean;
    result?: RallarAiJsonResult<TValue>;
    errors: readonly string[];
}>;

export type RallarAiEvaluationSuiteResult = Readonly<{
    suiteId: string;
    providerId: string;
    modelId?: string;
    passed: number;
    failed: number;
    results: readonly RallarAiEvaluationCaseResult[];
}>;

export type RunRallarAiEvaluationSuiteInput = Readonly<{
    suiteId: string;
    provider: RallarAiJsonProvider;
    cases: readonly RallarAiEvaluationCase[];
}>;

export async function runRallarAiEvaluationSuite(
    input: RunRallarAiEvaluationSuiteInput
): Promise<RallarAiEvaluationSuiteResult> {
    const results: RallarAiEvaluationCaseResult[] = [];

    for (const testCase of input.cases) {
        results.push(await runEvaluationCase(input.provider, testCase));
    }

    const passed = results.filter((result) => result.ok).length;
    return {
        suiteId: input.suiteId,
        providerId: input.provider.providerId,
        modelId: input.provider.modelId,
        passed,
        failed: results.length - passed,
        results
    };
}

async function runEvaluationCase(
    provider: RallarAiJsonProvider,
    testCase: RallarAiEvaluationCase
): Promise<RallarAiEvaluationCaseResult> {
    try {
        const result = await provider.generateJson(testCase.request);
        const errors = collectEvaluationErrors(result, testCase);
        return {
            caseId: testCase.caseId,
            ok: errors.length === 0,
            providerId: result.providerId,
            modelId: result.modelId,
            validationOk: result.validation.ok,
            result,
            errors
        };
    }
    catch (error) {
        return {
            caseId: testCase.caseId,
            ok: false,
            providerId: provider.providerId,
            modelId: provider.modelId,
            errors: [
                error instanceof Error ? error.message : String(error)
            ]
        };
    }
}

function collectEvaluationErrors(
    result: RallarAiJsonResult,
    testCase: RallarAiEvaluationCase
): readonly string[] {
    const errors: string[] = [];
    const expectedValidationOk = testCase.expectValidationOk ?? true;
    if (result.validation.ok !== expectedValidationOk) {
        errors.push(
            `Expected validation.ok=${expectedValidationOk}, got ${result.validation.ok}.`
        );
    }

    if (
        testCase.expectedValue !== undefined &&
        canonicalRallarAiJson(result.value) !==
            canonicalRallarAiJson(testCase.expectedValue)
    ) {
        errors.push('Generated value did not match the expected value.');
    }

    errors.push(...(testCase.validateResult?.(result) ?? []));
    return errors;
}
