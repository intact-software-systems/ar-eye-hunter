import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultALOutboundRuntimeResources } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { readALBrowserLocks, toALOutboundCommitLockName } from '@shared/alm/storage/al-browser-locks.ts';

import { decodeOutboundTestPayload } from '../outbound-test-payload.ts';

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

    it('names the commit lock by its sender', () => {
        expect(toALOutboundCommitLockName('self')).toBe('rallar:al-outbound-commit:self');
    });

    it('hands the default outbound resources the browser lock manager', () => {
        const locks = { request: vi.fn() };
        vi.stubGlobal('navigator', { locks });

        const resources = createDefaultALOutboundRuntimeResources({ decodePrepared: decodeOutboundTestPayload });

        expect(resources.browserLocks).toBe(locks);
    });
});
