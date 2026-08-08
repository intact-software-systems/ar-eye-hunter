import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ApiV1MatrixEntry {
  readonly id: string;
  readonly recipe: string;
  readonly category: string;
  readonly mode: string;
  readonly profiles: readonly string[];
  readonly expectedExitCode: number;
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

export function readApiV1Matrix(): { entries: ApiV1MatrixEntry[] } {
  return JSON.parse(readFileSync(path.join(runnerRoot, 'recipe-matrix.json'), 'utf8'));
}

export function readApiV1Recipe(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(runnerRoot, relativePath), 'utf8'));
}

export function toFlatApiV1RecipeSteps(
  steps: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return steps.flatMap((step) => {
    const nested = Array.isArray(step.steps)
      ? toFlatApiV1RecipeSteps(step.steps as Array<Record<string, unknown>>)
      : [];
    const grouped = Array.isArray(step.groups)
      ? (step.groups as Array<{ steps?: Array<Record<string, unknown>> }>).flatMap((group) =>
          toFlatApiV1RecipeSteps(group.steps ?? []),
        )
      : [];
    return [step, ...nested, ...grouped];
  });
}
