import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

Deno.test('fifteen same-user sessions obtain native WebSocket admission through production queues', async () => {
    const output = await new Deno.Command(Deno.execPath(), {
        args: [
            'test',
            '--config',
            fileURLToPath(new URL('../../deno.json', import.meta.url)),
            '--allow-env',
            '--allow-read',
            '--allow-write',
            '--allow-net=127.0.0.1',
            '--no-prompt',
            fileURLToPath(new URL('./concurrent-session-native-admission-child.ts', import.meta.url))
        ],
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        signal: AbortSignal.timeout(180_000),
        stdout: 'inherit',
        stderr: 'piped'
    }).output();
    const stderr = new TextDecoder().decode(output.stderr);
    assert.equal(output.success, true, stderr);
});
