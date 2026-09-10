import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ScenarioRecipe } from '@shared-test/black-box-runner/recipes/read-scenario-recipe-includes.ts';

type ApiV1RecipeStep = NonNullable<ScenarioRecipe['steps']>[number];
type ApiV1RecipeSteps = readonly ApiV1RecipeStep[];

interface ApiV1RecipeStepGroup {
    readonly steps?: ApiV1RecipeSteps;
}

export interface ApiV1MatrixEntry {
    readonly id: string;
    readonly recipe: string;
    readonly category: string;
    readonly mode: string;
    readonly tier?: number;
    readonly profiles: readonly string[];
    readonly expectedExitCode: number;
    readonly artifactName?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly description?: string;
    readonly requires?: {
        readonly httpServices?: ReadonlyArray<{
            readonly name: string;
            readonly env: string;
            readonly default?: string;
        }>;
        readonly playwright?: boolean;
    };
}

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const runnerRoot = path.join(repoRoot, 'packages/shared-test/black-box-runner');

export function readApiV1Matrix(): { entries: ApiV1MatrixEntry[]; } {
    return JSON.parse(readFileSync(path.join(runnerRoot, 'recipe-matrix.json'), 'utf8'));
}

export function readApiV1Recipe(relativePath: string): ScenarioRecipe {
    const recipe = JSON.parse(
        readFileSync(path.join(runnerRoot, relativePath), 'utf8')
    ) as ScenarioRecipe;
    if (recipe === null || typeof recipe !== 'object' || Array.isArray(recipe)) {
        throw new TypeError(`API-v1 recipe ${relativePath} must contain a JSON object.`);
    }
    return recipe;
}

export function toFlatApiV1RecipeSteps(
    steps: ApiV1RecipeSteps
): ApiV1RecipeStep[] {
    return steps.flatMap((step) => {
        const nested = Array.isArray(step.steps)
            ? toFlatApiV1RecipeSteps(step.steps as ApiV1RecipeSteps)
            : [];
        const grouped = Array.isArray(step.groups)
            ? (step.groups as readonly ApiV1RecipeStepGroup[]).flatMap((group) => toFlatApiV1RecipeSteps(group.steps ?? []))
            : [];
        return [step, ...nested, ...grouped];
    });
}
