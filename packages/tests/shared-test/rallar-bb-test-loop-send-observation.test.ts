import { describe, expect, it } from 'vitest';
import { createRallarBlackBoxTestRuntime } from '../../shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

describe('loop send evidence', () => {
    it('preserves current simulated transport without inferring obsolete diagnostic statuses', async () => {
        const runtime = createRallarBlackBoxTestRuntime({
            now: () => 100,
            commandExecutor: (command) =>
                command.kind === 'rtc.send'
                    ? {
                        status: 'ok',
                        value: {
                            transport: 'messages.rtc',
                            sent: true,
                            status: 'queued',
                            diagnostics: { message: { status: 'failed' }, results: [{ result: { status: 'dropped' } }] }
                        }
                    }
                    : undefined
        });
        const result = await runtime.execute({ kind: 'loop', count: 1, commands: [{ kind: 'rtc.send', send: { data: 'payload' } }] });
        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({
            sends: {
                observations: [{
                    kind: 'rtc.send',
                    transport: 'messages.rtc',
                    ok: true,
                    durationMs: 0,
                    status: undefined,
                    queued: false,
                    droppedPayloadCount: undefined,
                    replacedPayloadCount: undefined
                }]
            }
        });
    });

    it('projects explicit send observations and generic WS identity independently', async () => {
        const runtime = createRallarBlackBoxTestRuntime({
            now: () => 100,
            commandExecutor: (command) =>
                command.kind === 'ws.send'
                    ? {
                        status: 'ok',
                        value: {
                            sent: true,
                            sendObservation: {
                                status: 'queued',
                                transport: 'ws',
                                durationMs: 7,
                                queued: true,
                                droppedPayloadCount: 2,
                                replacedPayloadCount: 3
                            }
                        }
                    }
                    : undefined
        });
        const result = await runtime.execute({ kind: 'loop', count: 1, commands: [{ kind: 'ws.send', data: 'payload' }] });
        expect(result.value).toMatchObject({
            sends: {
                observations: [{
                    kind: 'ws.send',
                    transport: 'ws',
                    ok: true,
                    durationMs: 7,
                    status: 'queued',
                    queued: true,
                    droppedPayloadCount: 2,
                    replacedPayloadCount: 3
                }]
            }
        });
    });
});
