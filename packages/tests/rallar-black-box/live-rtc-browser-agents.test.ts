import { describe, expect, it } from 'vitest';

import {
    closeLiveRtcBrowserAgentContexts,
    openLiveRtcBrowserAgent,
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
        await closeLiveRtcBrowserAgentContexts([
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
    });
});
