import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

test('automatic fourteen-receiver receipts complete through native API WebSockets after held ACK release', async () => {
    const childScript = fileURLToPath(
        new URL(
            '../../../../packages/tests/shared-server/rallar-system/websocket/native-receiver-receipts-child.ts',
            import.meta.url
        )
    );
    const child = Bun.spawn({
        cmd: ['bun', 'test', '--timeout=240000', childScript],
        cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
        stdout: 'inherit',
        stderr: 'pipe'
    });
    const output = await new Response(child.stderr).text();
    const exitCode = await child.exited;
    assert.equal(exitCode, 0, output);
});
