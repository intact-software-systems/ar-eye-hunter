import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const recipePath = path.join(
    repoRoot,
    'packages/shared-test/black-box-runner/tests/api-v1/api-v1-state-medium-scale-churn.json'
);

const expectedGroupReads = [
    { group: 'one', name: 'readoneGroupThroughPrimary', connection: 'apiPrimary' },
    { group: 'two', name: 'readtwoGroupThroughSecondary', connection: 'apiSecondary' },
    { group: 'three', name: 'readthreeGroupThroughTertiary', connection: 'apiTertiary' },
    { group: 'four', name: 'readfourGroupThroughPrimary', connection: 'apiPrimary' },
    { group: 'five', name: 'readfiveGroupThroughSecondary', connection: 'apiSecondary' }
] as const;

interface MediumScaleRecipeStep {
    readonly name?: string;
    readonly connection?: string;
    readonly groups?: ReadonlyArray<{
        readonly name?: string;
        readonly steps?: readonly MediumScaleRecipeStep[];
    }>;
}

describe('API-v1 medium-scale recipe routing identities', () => {
    it('names every group poll for the API node that executes it', () => {
        const recipe = JSON.parse(readFileSync(recipePath, 'utf8')) as {
            steps: MediumScaleRecipeStep[];
        };
        const polls = recipe.steps.filter((step) => String(step.name).startsWith('pollConvergenceAttempt'));

        expect(polls).toHaveLength(5);
        for (const poll of polls) {
            for (const expectedRead of expectedGroupReads) {
                const group = poll.groups?.find(
                    (candidate) => candidate.name === `cluster-group-${expectedRead.group}`
                );
                expect(group?.steps).toContainEqual(
                    expect.objectContaining({
                        name: expectedRead.name,
                        connection: expectedRead.connection
                    })
                );
            }
        }

        const recipeText = JSON.stringify(recipe);
        expect(recipeText).not.toContain('readtwoGroupThroughPrimary');
        expect(recipeText).not.toContain('readthreeGroupThroughPrimary');
        expect(recipeText).not.toContain('readfiveGroupThroughPrimary');
    });
});
