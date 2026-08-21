import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('requires route recipes to assert durable AppInbox completion', () => {
    for (
        const recipePath of [
            'api-v1-state-write-convergence.json',
            'api-v1-state-medium-scale-churn.json',
            'api-v1-auth-session.json',
            'api-v1-admin-operations.json',
            'api-v1-crdt-app-inbox.json'
        ]
    ) {
        const recipe = JSON.parse(readFileSync(
            new URL(
                `../../shared-test/black-box-runner/tests/api-v1/${recipePath}`,
                import.meta.url
            ),
            'utf8'
        ));
        expect(recipe.steps.map((step: { name?: string; }) => step.name), recipePath)
            .toContain('assertAtomicAppInboxCompletion');
    }
});
