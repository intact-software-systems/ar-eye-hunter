import { afterEach, describe, expect, it, vi } from 'vitest';

describe('AR Eye full-stack diagnostic trace retention', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it.each([
        { capture: '1', mode: 'on' },
        { capture: '', mode: 'retain-on-failure' }
    ])('uses $mode with timing capture=$capture without adding filmstrip cost or extending deadlines', async ({ capture, mode }) => {
        vi.stubEnv('RALLAR_ARENA_FULL_STACK', '1');
        vi.stubEnv('RALLAR_BROWSER_TIMING', capture);
        vi.resetModules();
        const { default: configuration } = await import('../../../apps/ar-eye-hunter-v1/playwright.config.ts');
        expect(configuration.use?.trace).toEqual({ mode, screenshots: false, snapshots: true });
        expect(configuration.timeout).toBe(120_000);
        expect(configuration.expect?.timeout).toBe(15_000);
    });
});
