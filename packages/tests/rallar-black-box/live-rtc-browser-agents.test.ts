import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import {
    closeLiveRtcBrowserAgentContexts,
    LiveRtcBrowserAgentStartupFailure,
    openLiveRtcBrowserAgent,
    refreshLiveRtcBrowserRoom,
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
    it('fails room refresh when the browser runtime is absent', async () => {
        vi.stubGlobal('window', {});
        onTestFinished(() => {
            vi.unstubAllGlobals();
        });
        await expect(refreshLiveRtcBrowserRoom({ timeoutMs: 10_000 })).rejects.toThrow('browser Rallar runtime');
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

        const opening = openLiveRtcBrowserAgent(browser, agentInput);
        if (cleanupFails) {
            await expect(opening).rejects.toMatchObject({
                message: 'page-start-failed',
                cause: startupFailure,
                cleanupErrors: [new Error('cleanup-failed')]
            });
        }
        else {
            await expect(opening).rejects.toBe(startupFailure);
        }
        expect(allocatedContexts).toBe(0);
    });

    it('carries a failed context close through the real single-agent opener and trio boundary', async () => {
        vi.stubEnv('VITE_RALLAR_AGENT_A_USERNAME', 'fixture-user');
        vi.stubEnv('VITE_RALLAR_AGENT_A_PASSWORD', 'fixture-password');
        onTestFinished(() => {
            vi.unstubAllEnvs();
        });
        const { openAgentTrio } = await import('../../../tests/playwright/rallar-black-box/live-rtc-agent-environment.ts');
        const openingFailure = new Error('new-page-failed');
        const cleanupFailure = new Error('context-close-failed');
        const browser = {
            newContext: async () => ({
                newPage: async (): Promise<never> => {
                    throw openingFailure;
                },
                close: async (): Promise<void> => {
                    throw cleanupFailure;
                }
            })
        };

        const opening = openAgentTrio(browser, {
            runId: 'failed-startup',
            groupId: 'failure-room',
            suffix: 'failure',
            label: 'failure'
        });
        await expect(opening).rejects.toBeInstanceOf(LiveRtcBrowserAgentStartupFailure);
        await expect(opening).rejects.toMatchObject({
            message: 'new-page-failed',
            cause: openingFailure,
            cleanupErrors: [cleanupFailure]
        });
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
