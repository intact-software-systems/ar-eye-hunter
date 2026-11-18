import { describe, expect, it } from 'vitest';

import { toCommandId } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-step-identities.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { toResultComparisonAssertion } from '@shared-test/rallar-bb-test/conformance/alm/to-result-comparison-assertion.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

describe('toResultComparisonAssertion', () => {
    it('compares two fields of one named result, under the cell\'s history prefix', () => {
        const input = toConformanceInput('ws');
        const scenario = createAlmConformanceRecipes(input).find((candidate) => candidate.scenarioId === 'paced-latest')!;
        const step = {
            input,
            scenarioId: scenario.scenarioId,
            scenarioKey: scenario.scenarioKey,
            role: 'sender',
            roles: scenario.roles,
            messages: {},
            connect: undefined
        } as const;

        const command = toResultComparisonAssertion({
            step,
            name: 'assert-pair',
            resultName: 'stats-x',
            field: 'a.b',
            operator: 'gte',
            comparedField: 'c.d'
        });

        const resultPath = `resultCache.${toCommandId(step, 'stats-x')}.value`;
        expect(command).toMatchObject({
            kind: 'assert',
            commandId: toCommandId(step, 'assert-pair'),
            source: `${resultPath}.a.b`,
            operator: 'gte',
            comparisonSource: `${resultPath}.c.d`
        });
        expect(command).not.toHaveProperty('expected');
        expect(command.timeoutMs).toBeGreaterThan(0);
    });
});
