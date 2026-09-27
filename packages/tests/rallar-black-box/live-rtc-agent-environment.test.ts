import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

const startup = vi.hoisted(() => ({
    failure: new Error('second-agent-open-failed'),
    cleanupFailure: new Error('first-agent-close-failed'),
    closedAgents: [] as string[],
    openedAgents: 0,
    cleanupFails: false
}));

vi.mock('../../../tests/playwright/rallar-black-box/live-rtc-browser-agents.ts', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../../tests/playwright/rallar-black-box/live-rtc-browser-agents.ts')>();
    return {
        ...original,
        openLiveRtcBrowserAgent: async () => {
            startup.openedAgents++;
            if (startup.openedAgents === 2) {
                throw startup.failure;
            }
            return {
                context: {
                    close: async () => {
                        startup.closedAgents.push('A');
                        if (startup.cleanupFails) {
                            throw startup.cleanupFailure;
                        }
                    }
                }
            };
        }
    };
});

describe('live RTC trio startup failure', () => {
    it.each([false, true])('preserves the opening failure and partial cleanup evidence when cleanup fails=%s', async (cleanupFails) => {
        startup.openedAgents = 0;
        startup.closedAgents = [];
        startup.cleanupFails = cleanupFails;
        for (const prefix of ['A', 'B', 'C']) {
            vi.stubEnv(`VITE_RALLAR_AGENT_${prefix}_USERNAME`, 'fixture-user');
            vi.stubEnv(`VITE_RALLAR_AGENT_${prefix}_PASSWORD`, 'fixture-password');
        }
        onTestFinished(() => {
            vi.unstubAllEnvs();
        });
        const { openAgentTrio } = await import('../../../tests/playwright/rallar-black-box/live-rtc-agent-environment.ts');
        const browser = {
            newContext: async (): Promise<never> => {
                throw new Error('Unexpected context allocation');
            }
        };

        const opening = openAgentTrio(browser, {
            runId: 'failure-run',
            groupId: 'failure-room',
            suffix: 'failure',
            label: 'failure'
        });
        if (cleanupFails) {
            await expect(opening).rejects.toMatchObject({
                message: 'second-agent-open-failed',
                cause: startup.failure,
                cleanupErrors: [startup.cleanupFailure]
            });
        }
        else {
            await expect(opening).rejects.toBe(startup.failure);
        }
        expect(startup.closedAgents).toEqual(['A']);
    });
});
