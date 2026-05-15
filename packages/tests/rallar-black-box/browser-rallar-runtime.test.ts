import { describe, expect, it, vi } from 'vitest';
import { createRallarBlackBoxBrowserTestRuntime } from '../../../packages/shared-test/rallar-bb-test/browser-adapter.ts';
import { selectRallarBlackBoxDiagnostics } from '../../../packages/shared-test/rallar-bb-test/selectors.ts';
import {
    createSpaBrowserRallarRuntime,
    installSpaBrowserRallarEventBridge,
} from '../../../apps/rallar-black-box/src/browser-rallar-runtime.ts';

async function withFakeWindow<T>(
    value: Record<string, unknown>,
    run: () => T | Promise<T>,
): Promise<T> {
    const target = globalThis as typeof globalThis & { window?: unknown };
    const previous = target.window;
    target.window = value;
    try {
        return await run();
    } finally {
        target.window = previous;
    }
}

describe('rallar-black-box SPA browser-rallar runtime', () => {
    it('proxies runtime calls to window.__blackBoxRallar', async () => {
        const calls: string[] = [];
        await withFakeWindow({
            __blackBoxRallar: {
                connect: async () => {
                    calls.push('connect');
                    return { connected: true };
                },
                send: async () => {
                    calls.push('send');
                    return { sent: true };
                },
                close: async () => {
                    calls.push('close');
                    return { closed: true };
                },
                health: async () => {
                    calls.push('health');
                    return { connected: true };
                },
            },
        }, async () => {
            const runtime = createSpaBrowserRallarRuntime();

            await runtime.connect({ connection: 'aliceRtc', rallar: {} });
            await runtime.send({ data: { text: 'hello' } });
            await runtime.health();
            await runtime.close();
        });

        expect(calls).toEqual(['connect', 'send', 'health', 'close']);
    });

    it('bridges browser Rallar events into the shared runtime', async () => {
        await withFakeWindow({
            __blackBoxRallar: {
                connect: async () => {
                    const target = globalThis.window as {
                        __blackBoxRallarEmit?: (event: unknown) => void;
                    };
                    target.__blackBoxRallarEmit?.({
                        kind: 'diagnostic',
                        topic: 'rallar.browser.connect.phase_completed',
                        connection: 'aliceRtc',
                        actor: 'alice',
                        transport: 'realtime',
                        data: {
                            phase: 'rallar-connect',
                        },
                    });
                    return { connected: true };
                },
                send: vi.fn(),
                close: vi.fn(),
                health: vi.fn(),
            },
        }, async () => {
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: createSpaBrowserRallarRuntime(),
            });
            installSpaBrowserRallarEventBridge(runtime);

            await runtime.execute({
                kind: 'configure',
                commandId: 'configure-browser-rallar',
                config: {
                    apiBaseUrl: 'https://api.example.test',
                    actor: 'alice',
                    roomId: 'room-1',
                    transport: 'realtime',
                    rallar: {
                        username: 'alice',
                        password: 'secret',
                    },
                    control: {
                        providerMode: 'browser-rallar',
                    },
                },
            });
            const result = await runtime.execute({
                kind: 'rtc.connect',
                commandId: 'connect-browser-rallar',
                connection: 'aliceRtc',
            });

            expect(result.ok).toBe(true);
            expect(selectRallarBlackBoxDiagnostics(runtime.state()).some(event =>
                event.topic === 'rallar.browser.connect.phase_completed' &&
                event.connection === 'aliceRtc'
            )).toBe(true);
        });
    });

    it('maps shared connect and send commands to the browser Rallar runtime', async () => {
        const connect = vi.fn(async () => ({
            connected: true,
            connection: 'realRtc',
            transport: 'realtime',
            roomId: 'room-1',
        }));
        const send = vi.fn(async () => ({
            status: 'sent',
            transport: 'realtime',
            roomId: 'room-1',
        }));

        await withFakeWindow({
            __blackBoxRallar: {
                connect,
                send,
                close: vi.fn(),
                health: vi.fn(),
            },
        }, async () => {
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: createSpaBrowserRallarRuntime(),
            });

            await runtime.execute({
                kind: 'configure',
                commandId: 'configure-real-command-path',
                config: {
                    apiBaseUrl: 'https://api.example.test',
                    actor: 'alice',
                    roomId: 'room-1',
                    transport: 'realtime',
                    rallar: {
                        username: 'alice',
                        password: 'secret',
                        transport: 'realtime',
                    },
                    control: {
                        providerMode: 'browser-rallar',
                    },
                },
            });
            const connectResult = await runtime.execute({
                kind: 'rtc.connect',
                commandId: 'connect-real-command-path',
                connection: 'realRtc',
            });
            const sendResult = await runtime.execute({
                kind: 'rtc.send',
                commandId: 'send-real-command-path',
                connection: 'realRtc',
                transport: 'realtime',
                send: {
                    roomId: 'room-1',
                    peerIds: ['bob-session'],
                    data: {
                        text: 'hello',
                    },
                },
            });

            expect(connectResult.ok).toBe(true);
            expect(sendResult.ok).toBe(true);
            expect(connect).toHaveBeenCalledWith({
                connection: 'realRtc',
                actor: 'alice',
                roomId: 'room-1',
                rallar: {
                    apiBaseUrl: 'https://api.example.test',
                    username: 'alice',
                    password: 'secret',
                    transport: 'realtime',
                },
            });
            expect(send).toHaveBeenCalledWith({
                roomId: 'room-1',
                peerIds: ['bob-session'],
                data: {
                    text: 'hello',
                },
            });
            expect(selectRallarBlackBoxDiagnostics(runtime.state()).some(event =>
                event.topic === 'rallar.bb.rtc.send_completed' &&
                event.commandId === 'send-real-command-path'
            )).toBe(true);
        });
    });
});
