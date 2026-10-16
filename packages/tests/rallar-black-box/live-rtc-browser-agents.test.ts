import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import {
    closeLiveRtcBrowserAgentContexts,
    openLiveRtcBrowserAgent,
    refreshLiveRtcBrowserRoom,
    toLiveRtcBrowserAgentQuery,
    type OpenLiveRtcBrowserAgentInput
} from '../../../tests/playwright/rallar-black-box/live-rtc-browser-agents.ts';

const agentInput: OpenLiveRtcBrowserAgentInput = {
    config: { spaBaseUrl: 'http://localhost', apiBaseUrl: 'http://localhost', controlWsUrl: 'ws://localhost', register: false },
    prefix: 'A',
    auth: { kind: 'login', username: 'test-user', password: 'test-password' },
    runId: 'startup-run',
    agentId: 'agent-a',
    actor: 'actor-a',
    connection: 'connection-a',
    groupId: 'startup-room'
};

describe('live RTC browser agent startup', () => {
    it.each(['enabled', 'disabled'] as const)('emits explicit %s selection before navigating the fresh browser', (mode) => {
        const query = toLiveRtcBrowserAgentQuery({ ...agentInput, config: { ...agentInput.config, routineBrowserDiagnostics: mode } });
        expect(Object.fromEntries(query)).toMatchObject({ routineBrowserDiagnostics: mode, provider: 'browser-rallar', transport: 'realtime' });
        expect(query.has('rtcCaptureMode')).toBe(false);
        expect(query.has('almDiagnostics')).toBe(false);
    });

    it('fails room refresh when the browser runtime is absent', async () => {
        vi.stubGlobal('window', {});
        onTestFinished(() => {
            vi.unstubAllGlobals();
        });
        await expect(refreshLiveRtcBrowserRoom({ refresh: 'always', timeoutMs: 10_000 })).rejects.toThrow('browser Rallar runtime');
    });

    it.each([false, true])('releases its context and preserves startup failure when cleanup fails=%s', async (cleanupFails) => {
        let allocatedContexts = 0;
        const startupFailure = new Error('page-start-failed');
        const browser = {
            newContext: async () => {
                allocatedContexts++;
                return {
                    newPage: async () => {
                        throw startupFailure;
                    },
                    close: async () => {
                        allocatedContexts--;
                        if (cleanupFails) {
                            throw new Error('cleanup-failed');
                        }
                    }
                };
            }
        };

        await expect(openLiveRtcBrowserAgent(browser, agentInput)).rejects.toBe(startupFailure);
        expect(allocatedContexts).toBe(0);
    });
    it('settles every owned context even when one close fails, so evidence finalization can continue', async () => {
        const closed: string[] = [];
        const errors = await closeLiveRtcBrowserAgentContexts([
            {
                context: {
                    close: async () => {
                        closed.push('A');
                        throw new Error('close-failed');
                    }
                }
            },
            {
                context: {
                    close: async () => {
                        closed.push('B');
                    }
                }
            }
        ]);
        expect(closed.sort()).toEqual(['A', 'B']);
        expect(errors.map((error) => error.message)).toEqual(['close-failed']);
    });
});

it('carries initialized history through the canonical browser launch decoder', async () => {
    const { resolveRallarBlackBoxBootstrapConfig } = await import('../../shared-test/rallar-bb-test/browser-control-agent-config.ts');
    const query = toLiveRtcBrowserAgentQuery({ ...agentInput, config: { ...agentInput.config, eventHistory: { mode: 'recent', maxEvents: 64 } } });
    const bootstrap = resolveRallarBlackBoxBootstrapConfig(`?${query}`, { VITE_RALLAR_EVENT_HISTORY: 'full' }, '');
    expect(bootstrap.issues).toEqual([]);
    expect(bootstrap.eventHistory).toEqual({ mode: 'recent', maxEvents: 64 });
});
