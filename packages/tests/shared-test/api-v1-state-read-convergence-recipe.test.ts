import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const recipePath = path.join(
  repoRoot,
  'packages/shared-test/black-box-runner/tests/api-v1/api-v1-state-read-convergence.json',
);

interface StateReadRecipeStep {
  readonly name?: string;
  readonly connection?: string;
  readonly actual?: Record<string, unknown>;
  readonly expect?: {
    readonly status?: number;
    readonly body?: Record<string, unknown>;
  };
}

describe('API-v1 state-read convergence recipe', () => {
  it('proves tertiary scalar and causal floors with revision and source headers', () => {
    const recipe = JSON.parse(readFileSync(recipePath, 'utf8')) as {
      steps: StateReadRecipeStep[];
    };
    const clientRead = recipe.steps.find((step) => step.name === 'readClientFloorOnTertiary');
    const groupRead = recipe.steps.find((step) => step.name === 'readGroupFloorOnTertiary');
    const assertion = recipe.steps.find((step) => step.name === 'assertReadConvergenceEvidence');

    expect(clientRead).toMatchObject({ connection: 'tertiary', expect: { status: 200 } });
    expect(groupRead).toMatchObject({ connection: 'tertiary', expect: { status: 200 } });
    expect(assertion?.actual).toMatchObject({
      clientRevisionBody: '{resultsByName.readClientFloorOnTertiary.0.actual.body.stateRevision}',
      clientRevisionHeader:
        '{resultsByName.readClientFloorOnTertiary.0.actual.headers.rallar-state-revision}',
      clientSource:
        '{resultsByName.readClientFloorOnTertiary.0.actual.headers.rallar-state-source}',
      groupRevisionBody:
        '{resultsByName.readGroupFloorOnTertiary.0.actual.body.causalRevision.groupRevision}',
      groupRevisionHeader:
        '{resultsByName.readGroupFloorOnTertiary.0.actual.headers.rallar-group-revision}',
      presenceRevisionBody:
        '{resultsByName.readGroupFloorOnTertiary.0.actual.body.causalRevision.presenceRevision}',
      presenceRevisionHeader:
        '{resultsByName.readGroupFloorOnTertiary.0.actual.headers.rallar-presence-revision}',
      groupSource: '{resultsByName.readGroupFloorOnTertiary.0.actual.headers.rallar-state-source}',
    });
    expect(assertion?.expect?.body).toMatchObject({
      clientRevisionBody: '{clientFloor}',
      clientRevisionHeader: '{clientFloorString}',
      clientSource: 'string',
      groupRevisionBody: '{groupFloor}',
      groupRevisionHeader: '{groupFloorString}',
      presenceRevisionBody: '{presenceFloor}',
      presenceRevisionHeader: '{presenceFloorString}',
      groupSource: 'string',
    });
  });
});
