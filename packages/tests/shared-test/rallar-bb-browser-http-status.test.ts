import { expect, it } from 'vitest';

import { createDefaultRallarBlackBoxBrowserTestRuntime } from '../../shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import type { RallarBlackBoxTestJsonValue } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

it.each([
    { name: 'explicitly accepted conflict', status: 409, acceptedStatusCodes: [200, 201, 409], ok: true, severity: 'info' },
    { name: 'rejected conflict', status: 409, acceptedStatusCodes: [200, 201], ok: false, severity: 'warning' },
    { name: 'explicitly rejected success status', status: 201, acceptedStatusCodes: [200], ok: false, severity: 'warning' },
    { name: 'accepted success status', status: 201, acceptedStatusCodes: [200, 201], ok: true, severity: 'info' },
    { name: 'unrestricted conflict', status: 409, acceptedStatusCodes: undefined, ok: true, severity: 'warning' },
    { name: 'unrestricted success', status: 200, acceptedStatusCodes: undefined, ok: true, severity: 'info' }
])('records the command status policy for $name without changing native HTTP evidence', async ({ status, acceptedStatusCodes, ok, severity }) => {
    const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({
        readSession: () => undefined,
        fetch: async () => new Response(JSON.stringify({ code: status === 409 ? 'group-already-exists' : 'response' }), { status })
    });

    const result = await runtime.execute({
        kind: 'http.request',
        commandId: 'ensure-group',
        request: { url: 'https://api.example.test/groups', method: 'POST' },
        response: { body: 'json', acceptedStatusCodes }
    });

    expect(result.ok).toBe(ok);
    if (!ok) {
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_HTTP_STATUS_NOT_ACCEPTED');
    }
    expect(runtime.state().events.find((event) => event.topic === 'rallar.bb.http.response')).toMatchObject({
        commandId: 'ensure-group',
        severity,
        payload: { status, ok: status >= 200 && status < 300 }
    });
});

it('sends a body that names an earlier result as that value and fails a body naming a result none returned', async () => {
    const sentBodies: (RallarBlackBoxTestJsonValue | undefined)[] = [];
    const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({
        readSession: () => undefined,
        fetch: async (_url, init) => {
            sentBodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)));
            return new Response(JSON.stringify({ connectionGenerationId: 'generation-1' }), { status: 200 });
        }
    });
    const read = await runtime.execute({
        kind: 'http.request',
        commandId: 'read-generation',
        request: { url: 'https://api.example.test/generation', method: 'POST' },
        response: { body: 'json' }
    });

    const release = await runtime.execute({
        kind: 'http.request',
        commandId: 'release-generation',
        request: {
            url: 'https://api.example.test/release',
            method: 'POST',
            body: { connectionGenerationId: '{resultCache.read-generation.value.body.connectionGenerationId}' }
        },
        response: { body: 'json' }
    });
    const unresolved = await runtime.execute({
        kind: 'http.request',
        commandId: 'release-unknown',
        request: {
            url: 'https://api.example.test/release',
            method: 'POST',
            body: { connectionGenerationId: '{resultCache.never-read.value.body.connectionGenerationId}' }
        }
    });

    expect([read.ok, release.ok]).toEqual([true, true]);
    expect(sentBodies[1]).toEqual({ connectionGenerationId: 'generation-1' });
    expect(unresolved.ok).toBe(false);
    expect(unresolved.error?.message).toBe(
        'http.request names resultCache.never-read.value.body.connectionGenerationId, which no earlier command of ' +
            'this recipe returned.'
    );
    expect(sentBodies).toHaveLength(2);
});
