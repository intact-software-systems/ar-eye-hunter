import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('covers unauthenticated CRDT mutations through the public admin route', () => {
    const recipePath = fileURLToPath(
        new URL(
            '../../shared-test/black-box-runner/tests/api-v1/api-v1-admin-operations.json',
            import.meta.url
        )
    );
    const recipe = JSON.parse(readFileSync(recipePath, 'utf8')) as {
        steps: Array<{
            name: string;
            request?: { method?: string; path?: string; headers?: Record<string, string>; };
            expect?: { status?: number; body?: Record<string, unknown>; };
        }>;
    };
    const denial = recipe.steps.find((step) => step.name === 'rejectMissingCrdtMutationAuth');

    expect(denial?.request).toMatchObject({
        method: 'POST',
        path: '/api/admin/operations/crdt/lifecycle/requests/' +
            'bb-reject-missing-crdt-mutation-auth-001-0001'
    });
    expect(denial?.request?.headers?.Authorization).toBeUndefined();
    expect(denial?.expect).toMatchObject({
        status: 401,
        body: {
            type: 'api-mutation-failure',
            version: 'canonical.v2',
            code: 'authentication-required',
            status: 401
        }
    });
});
