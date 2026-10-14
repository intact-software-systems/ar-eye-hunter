import type { ServerOptions } from 'vite';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

async function readHeadlessDevServerHmr(fullStack: string | undefined): Promise<ServerOptions['hmr']> {
    vi.resetModules();
    vi.stubEnv('RALLAR_BLACK_BOX_FULL_STACK', fullStack);
    const config = await import('../../../apps/rallar-black-box-headless/vite.config.ts');
    return config.default.server?.hmr;
}

describe('rallar-black-box-headless vite config', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('turns hot reload off for the long-lived agent pages of the full-stack lifecycle', async () => {
        expect(await readHeadlessDevServerHmr('1')).toBe(false);
        expect(await readHeadlessDevServerHmr('true')).toBe(false);
    });

    it('keeps the default hot reload outside the full-stack lifecycle', async () => {
        expect(await readHeadlessDevServerHmr(undefined)).toBeUndefined();
        expect(await readHeadlessDevServerHmr('0')).toBeUndefined();
    });
});
