// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { createDefaultRallarBlackBoxBrowserTestRuntime } from '../../shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';

describe('http.request result redaction', () => {
    it('redacts sensitive response headers and body fields in the recorded result and mirrored event', async () => {
        const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({
            readSession: () => undefined,
            fetch: async () =>
                new Response(
                    JSON.stringify({
                        profile: { username: 'alice' },
                        accessToken: 'live-access-token'
                    }),
                    {
                        status: 200,
                        headers: {
                            'content-type': 'application/json',
                            'x-session-cookie': 'session=live-cookie-value',
                            'x-rallar-ticket': 'live-ticket-value'
                        }
                    }
                )
        });

        const result = await runtime.execute({
            kind: 'http.request',
            commandId: 'http-sensitive-response',
            request: {
                url: 'https://api.example.test/api/session',
                method: 'GET'
            },
            response: {
                body: 'json'
            }
        });

        expect(result.ok).toBe(true);
        const redacted = {
            status: 200,
            headers: { 'x-session-cookie': '<redacted>', 'x-rallar-ticket': '<redacted>', 'content-type': 'application/json' },
            body: { accessToken: '<redacted>', profile: { username: 'alice' } }
        };
        expect(result.value).toMatchObject(redacted);
        expect(runtime.state().resultCache['http-sensitive-response']?.value).toMatchObject(redacted);

        const mirroredEvent = runtime.state().events
            .find((event) => event.topic === 'rallar.bb.http.response');
        expect(mirroredEvent?.payload).toMatchObject({
            status: 200,
            headers: {
                'x-session-cookie': '<redacted>',
                'x-rallar-ticket': '<redacted>'
            },
            body: {
                accessToken: '<redacted>'
            }
        });
    });

    it('redacts the http result recorded for a rejected status code', async () => {
        const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({
            readSession: () => undefined,
            fetch: async () =>
                new Response(
                    JSON.stringify({ error: 'denied', refreshToken: 'live-refresh-token' }),
                    {
                        status: 403,
                        headers: {
                            'content-type': 'application/json',
                            authorization: 'Bearer leaked-server-echo'
                        }
                    }
                )
        });

        const result = await runtime.execute({
            kind: 'http.request',
            commandId: 'http-rejected-status',
            request: {
                url: 'https://api.example.test/api/denied',
                method: 'GET'
            },
            response: {
                body: 'json',
                acceptedStatusCodes: [200]
            }
        });

        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_HTTP_STATUS_NOT_ACCEPTED');
        const redacted = { headers: { authorization: '<redacted>' }, body: { refreshToken: '<redacted>' } };
        expect(result.value).toMatchObject(redacted);
        expect(result.error?.details).toMatchObject(redacted);
    });
});
