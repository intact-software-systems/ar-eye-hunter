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
    currentCleanupFailure: new Error('second-agent-close-failed'),
    closedAgents: [] as string[],
    openedAgents: 0,
    cleanupFails: false,
    currentCleanupFails: false
}));

vi.mock('../../../tests/playwright/rallar-black-box/live-rtc-browser-agents.ts', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../../tests/playwright/rallar-black-box/live-rtc-browser-agents.ts')>();
    return {
        ...original,
        openLiveRtcBrowserAgent: async () => {
            startup.openedAgents++;
            if (startup.openedAgents === 2) {
                if (startup.currentCleanupFails) {
                    throw new original.LiveRtcBrowserAgentStartupFailure(startup.failure, [startup.currentCleanupFailure]);
                }
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
    it.each([
        { cleanupFails: false, currentCleanupFails: false, expected: [] },
        { cleanupFails: true, currentCleanupFails: false, expected: ['first-agent-close-failed'] },
        { cleanupFails: false, currentCleanupFails: true, expected: ['second-agent-close-failed'] },
        { cleanupFails: true, currentCleanupFails: true, expected: ['second-agent-close-failed', 'first-agent-close-failed'] }
    ])('preserves opening and all cleanup failures: %j', async ({ cleanupFails, currentCleanupFails, expected }) => {
        startup.openedAgents = 0;
        startup.closedAgents = [];
        startup.cleanupFails = cleanupFails;
        startup.currentCleanupFails = currentCleanupFails;
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
        if (expected.length > 0) {
            await expect(opening).rejects.toMatchObject({
                message: 'second-agent-open-failed',
                cause: startup.failure,
                cleanupErrors: expected.map((message) => new Error(message))
            });
        }
        else {
            await expect(opening).rejects.toBe(startup.failure);
        }
        expect(startup.closedAgents).toEqual(['A']);
    });
});
