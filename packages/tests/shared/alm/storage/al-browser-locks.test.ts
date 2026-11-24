import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { readALBrowserLocks } from '@shared/alm/storage/al-browser-locks.ts';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('ALBrowserLocks', () => {
    it('reads the browser lock manager where the Locks API exists', () => {
        const locks = { request: vi.fn() };
        vi.stubGlobal('navigator', { locks });

        expect(readALBrowserLocks()).toBe(locks);
    });

    it('reads no lock manager where the Locks API is missing', () => {
        vi.stubGlobal('navigator', {});

        expect(readALBrowserLocks()).toBeUndefined();
    });
});
