import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

Deno.test('PGlite SQL preserves UTC timestamp parity in an explicitly non-UTC subprocess', async () => {
    const apiV1Root = fileURLToPath(new URL('../../', import.meta.url));
    const apiV1Config = fileURLToPath(new URL('../../deno.json', import.meta.url));
    const childScript = fileURLToPath(
        new URL('./pglite-sql-adapter-timezone-child.ts', import.meta.url)
    );
    const output = await new Deno.Command(Deno.execPath(), {
        args: [
            'run',
            '--config',
            apiV1Config,
            '--allow-env',
            '--allow-read',
            '--allow-write',
            childScript
        ],
        cwd: apiV1Root,
        env: { ...Deno.env.toObject(), TZ: 'America/New_York' },
        stdout: 'piped',
        stderr: 'piped'
    }).output();
    assert.equal(output.success, true, new TextDecoder().decode(output.stderr));
});
