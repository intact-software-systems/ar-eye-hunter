import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

const recipeRoot = new URL(
    '../../../../shared-test/black-box-runner/tests/api-v1/',
    import.meta.url
);

it('requires state-write route recipes to assert durable AppInbox completion', () => {
    for (
        const recipePath of [
            'api-v1-state-write-convergence.json',
            'api-v1-state-medium-scale-churn.json',
            'api-v1-auth-session.json',
            'api-v1-admin-operations.json',
            'api-v1-crdt-app-inbox.json'
        ]
    ) {
        expect(readRecipeStepNames(recipePath), recipePath)
            .toContain('assertAtomicAppInboxCompletion');
    }
});

function readRecipeStepNames(recipePath: string): readonly string[] {
    const recipe = decodeJsonWireValue(
        JSON.parse(readFileSync(new URL(recipePath, recipeRoot), 'utf8')),
        recipePath
    );
    if (!isJsonWireObject(recipe)) {
        throw new Error(`${recipePath} must contain a JSON object`);
    }
    const steps = recipe.steps;
    if (!isJsonWireArray(steps)) {
        throw new Error(`${recipePath} must contain a steps array`);
    }

    return steps.map((step, index) => {
        if (!isJsonWireObject(step)) {
            throw new Error(`${recipePath} step ${index} must be a JSON object`);
        }
        if (typeof step.name !== 'string') {
            throw new Error(`${recipePath} step ${index} must have a name`);
        }
        return step.name;
    });
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonWireArray(
    value: JsonWireValue | undefined
): value is readonly JsonWireValue[] {
    return Array.isArray(value);
}
