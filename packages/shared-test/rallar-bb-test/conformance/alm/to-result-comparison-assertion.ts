import type { RallarBlackBoxTestAssertComparisonOperator } from '../../assert/is-assert-comparison.ts';
import type { RallarBlackBoxTestCommand } from '../../rallar-black-box-test-contracts.ts';

import { ASSERT_TIMEOUT_MS, toBudgetMs } from './alm-conformance-budgets.ts';
import type { AlmConformanceStepInput } from './alm-conformance-scenario-definition.ts';
import { toCommandId } from './alm-conformance-step-identities.ts';

interface AlmConformanceResultComparisonInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    readonly resultName: string;
    readonly field: string;
    readonly operator: Exclude<RallarBlackBoxTestAssertComparisonOperator, 'sameUniqueStringSet'>;
    /** A second field of the same result. */
    readonly comparedField: string;
}

export function toResultComparisonAssertion(
    { step, name, resultName, field, operator, comparedField }: AlmConformanceResultComparisonInput
): RallarBlackBoxTestCommand {
    const resultPath = `resultCache.${toCommandId(step, resultName)}.value`;
    return {
        kind: 'assert',
        commandId: toCommandId(step, name),
        source: `${resultPath}.${field}`,
        operator,
        comparisonSource: `${resultPath}.${comparedField}`,
        timeoutMs: toBudgetMs(ASSERT_TIMEOUT_MS, step.input.deadlineMs)
    };
}
