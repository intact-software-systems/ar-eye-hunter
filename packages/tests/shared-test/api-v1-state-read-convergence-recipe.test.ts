import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const recipePath = path.join(
    repoRoot,
    'packages/shared-test/black-box-runner/tests/api-v1/api-v1-state-read-convergence.json'
);

interface StateReadRecipeStep {
    readonly name?: string;
    readonly connection?: string;
    readonly actual?: Record<string, unknown>;
    readonly expect?: {
        readonly status?: number;
        readonly headers?: Record<string, unknown>;
        readonly body?: Record<string, unknown>;
    };
}

describe('API-v1 state-read convergence recipe', () => {
    it('defines run-scoped identifiers as interpolated string values', () => {
        const recipe = JSON.parse(readFileSync(recipePath, 'utf8')) as {
            variables: Record<string, unknown>;
        };

        expect(recipe.variables).toMatchObject({
            applicationId: 'state-read-{runId}',
            workspaceId: 'default-{runId}',
            groupId: 'snapshot-room-{runId}'
        });
    });

    it('proves tertiary scalar and causal floors with revision and source headers', () => {
        const recipe = JSON.parse(readFileSync(recipePath, 'utf8')) as {
            steps: StateReadRecipeStep[];
        };
        const clientRead = recipe.steps.find((step) => step.name === 'readClientFloorOnTertiary');
        const groupRead = recipe.steps.find((step) => step.name === 'readGroupFloorOnTertiary');
        const assertion = recipe.steps.find((step) => step.name === 'assertReadConvergenceEvidence');

        expect(clientRead).toMatchObject({
            connection: 'tertiary',
            expect: {
                status: 200,
                headers: {
                    'Rallar-State-Revision': '{clientFloorString}',
                    'Rallar-State-Source': 'string'
                }
            }
        });
        expect(groupRead).toMatchObject({
            connection: 'tertiary',
            expect: {
                status: 200,
                headers: {
                    'Rallar-Group-Revision': '{groupFloorString}',
                    'Rallar-Presence-Revision': '{presenceFloorString}',
                    'Rallar-State-Source': 'string'
                }
            }
        });
        expect(assertion?.actual).toMatchObject({
            clientRevisionBody: '{resultsByName.readClientFloorOnTertiary.0.actual.body.stateRevision}',
            groupRevisionBody: '{resultsByName.readGroupFloorOnTertiary.0.actual.body.causalRevision.groupRevision}',
            presenceRevisionBody: '{resultsByName.readGroupFloorOnTertiary.0.actual.body.causalRevision.presenceRevision}'
        });
        expect(assertion?.expect?.body).toMatchObject({
            clientRevisionBody: '{clientFloor}',
            groupRevisionBody: '{groupFloor}',
            presenceRevisionBody: '{presenceFloor}'
        });
        expect(JSON.stringify(assertion)).not.toContain('.actual.headers.');
    });
});
