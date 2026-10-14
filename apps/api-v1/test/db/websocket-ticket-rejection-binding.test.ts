import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

Deno.test('ticket rejection logs render authoritative read and upgrade request binding without credentials', async () => {
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
    for (const provenance of ['expired', 'absent', 'live']) {
        const section = rendered.split(`BEGIN ${provenance}\n`)[1]?.split(`END ${provenance}\n`)[0];
        assert.ok(section, rendered);
        assert.match(section, /ResourceInboxHandlerEntryError/u);
        assert.match(section, /ResourceInboxCommandRejectedError/u);
        assert.match(section, /AuthMutationRejectedError/u);
        assert.match(section, new RegExp(`consumeRequestId: "consume-${provenance}"`, 'u'));
        assert.match(section, new RegExp(`ticketRead: "${provenance}"`, 'u'));
        assert.match(section, /capturedAtEpochMs: 200/u);
        assert.match(section, /RequestAuthFailure/u);
        assert.match(section, new RegExp(`requestId: "consume-${provenance}"`, 'u'));
        assert.match(section, /sessionId: "expected-session"/u);
        assert.doesNotMatch(section, /raw-ticket|raw-access-token|ticketDigest|accessTokenDigest|store_key|encoded-secret/u);
    }
    assert.match(rendered, /storageExpiresAtEpochMs: 100/u);
    assert.match(rendered, /storageExpiresAtEpochMs: null/u);
});
