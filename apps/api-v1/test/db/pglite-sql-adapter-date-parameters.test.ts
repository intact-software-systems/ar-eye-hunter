import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

test('PGlite SQL preserves UTC timestamp parity in an explicitly non-UTC subprocess', async () => {
    const apiV1Root = fileURLToPath(new URL('../../', import.meta.url));
    const childScript = fileURLToPath(
        new URL('./pglite-sql-adapter-timezone-child.ts', import.meta.url)
    );
    const child = Bun.spawn({
        cmd: ['bun', 'run', childScript],
        cwd: apiV1Root,
        env: { ...process.env, TZ: 'America/New_York' },
        stdout: 'pipe',
        stderr: 'pipe'
    });
    const output = await new Response(child.stderr).text();
    const exitCode = await child.exited;
    assert.equal(exitCode, 0, output);
});
