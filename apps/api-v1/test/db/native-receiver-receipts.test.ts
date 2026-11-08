import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// Skipped: the pglite-backed receipt aggregation is flaky under Bun's JSC + pglite-WASM timing
// (~50% in CI: the origin receives the admitted receipt but not all fourteen receivers' inbound
// completion within the 30s subject TTL, even though every frame is delivered). The production
// Postgres path is verified green in the Postgres integration lane. Tracked by a GitHub issue for
// pglite-under-Bun receipt timing.
test.skip('automatic fourteen-receiver receipts complete through native API WebSockets after held ACK release', async () => {
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
