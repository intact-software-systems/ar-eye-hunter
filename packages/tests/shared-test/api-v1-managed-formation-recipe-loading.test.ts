import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface ExplainedRecipe {
    readonly connections: { readonly missing: readonly string[]; };
    readonly operations: readonly ExplainedOperation[];
}

interface ExplainedOperation {
    readonly transport: string;
    readonly path: string;
}

const runnerRoot = fileURLToPath(new URL('../../shared-test/black-box-runner/', import.meta.url));

describe('managed formation recipe loading', () => {
    it.each(['medium', 'large'])('resolves every %s HTTP operation against a declared server connection', (tier) => {
        const result = spawnSync('deno', [
            'run',
            '-A',
            `${runnerRoot}/scenario-black-box.ts`,
            '-w',
            runnerRoot,
            '-c',
            `tests/api-v1/api-v1-group-formation-managed-burst-${tier}.json`,
            '--explain'
        ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, RALLAR_API_BASE_URL: 'https://formation.test' } });
        const recipe = JSON.parse(result.stdout) as ExplainedRecipe;
        expect(recipe.connections.missing).toEqual([]);
        expect(result.status).toBe(0);
        const http = recipe.operations.filter((operation) => operation.transport === 'HTTP');
        expect(http.length).toBeGreaterThan(0);
        for (const operation of http) {
            expect(new URL(operation.path).origin).toBe('https://formation.test');
        }
    });
});
