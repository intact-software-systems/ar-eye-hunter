import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

test('an unusable websocket ticket is answered 401 before any lane work, without credentials in the logs', async () => {
    const childScript = fileURLToPath(new URL('./websocket-ticket-rejection-binding-child.ts', import.meta.url));
    const child = Bun.spawn({
        cmd: ['bun', 'run', childScript],
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        stdout: 'pipe',
        stderr: 'pipe'
    });
    const output = await new Response(child.stderr).text();
    const exitCode = await child.exited;
    assert.equal(exitCode, 0, output);
    for (const provenance of ['expired', 'absent', 'foreign']) {
        const section = output.split(`BEGIN ${provenance}\n`)[1]?.split(`END ${provenance}\n`)[0];
        assert.ok(section, output);
        assert.match(section, /RequestAuthFailure/u);
        assert.match(section, /sessionId: "stored-session"/u);
        assert.doesNotMatch(section, /raw-ticket|raw-access-token|ticketDigest|accessTokenDigest|store_key/u);
    }
});
