import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

test('fifteen native same-user sessions complete room setup through production automatic queues', async () => {
    const childScript = fileURLToPath(new URL('./concurrent-session-native-admission-child.ts', import.meta.url));
    const child = Bun.spawn({
        cmd: ['bun', 'test', '--timeout=240000', childScript],
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        stdout: 'inherit',
        stderr: 'pipe'
    });
    const output = await new Response(child.stderr).text();
    const exitCode = await child.exited;
    assert.equal(exitCode, 0, output);
});
