import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

Deno.test('an unusable websocket ticket is answered 401 before any lane work, without credentials in the logs', async () => {
    const output = await new Deno.Command(Deno.execPath(), {
        args: [
            'run',
            '--config',
            fileURLToPath(new URL('../../deno.json', import.meta.url)),
            '--allow-env',
            '--allow-read',
            '--allow-write',
            '--no-prompt',
            fileURLToPath(new URL('./websocket-ticket-rejection-binding-child.ts', import.meta.url))
        ],
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        stdout: 'piped',
        stderr: 'piped'
    }).output();
    const rendered = new TextDecoder().decode(output.stderr);
    assert.equal(output.success, true, rendered);
    for (const provenance of ['expired', 'absent', 'foreign']) {
        const section = rendered.split(`BEGIN ${provenance}\n`)[1]?.split(`END ${provenance}\n`)[0];
        assert.ok(section, rendered);
        assert.match(section, /RequestAuthFailure/u);
        assert.match(section, /sessionId: "stored-session"/u);
        assert.doesNotMatch(section, /raw-ticket|raw-access-token|ticketDigest|accessTokenDigest|store_key/u);
    }
});
