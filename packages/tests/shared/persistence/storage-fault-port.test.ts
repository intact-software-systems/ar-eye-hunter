import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createScriptedStorageFaultPort,
    type ScriptedStorageFault
} from '@shared/persistence/storage-fault-port.ts';

const QUOTA_ON_ADMISSION_WRITES: ScriptedStorageFault = {
    faultId: 'quota-admission',
    carrier: 'storage',
    match: { owner: 'al-admission', kind: undefined },
    action: 'quota',
    remaining: 'until-cleared'
};

describe('ScriptedStorageFaultPort', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('lets every operation through at once while nothing is injected', () => {
        const port = createScriptedStorageFaultPort();

        expect(port.observe({ owner: 'al-admission', kind: 'write' })).toBeUndefined();
        expect(port.getObservations()).toEqual([]);
    });

    it('fails a matching write with QuotaExceededError', async () => {
        const port = createScriptedStorageFaultPort();
        port.inject(QUOTA_ON_ADMISSION_WRITES);

        await expect(port.observe({ owner: 'al-admission', kind: 'write' })).rejects.toMatchObject({
            name: 'QuotaExceededError'
        });
        expect(port.getObservations()).toEqual([{
            faultId: 'quota-admission',
            operation: { owner: 'al-admission', kind: 'write' },
            decision: 'quota'
        }]);
    });

    // A recipe matches the storage failure a store reports to the fault that caused it, so the message names the fault.
    it('names the fault id in the message of each rejection it scripts', async () => {
        const port = createScriptedStorageFaultPort();
        port.inject(QUOTA_ON_ADMISSION_WRITES);
        port.inject({
            faultId: 'fail-read',
            carrier: 'storage',
            match: { owner: 'al-work', kind: 'work-page' },
            action: 'fail',
            remaining: 'until-cleared'
        });

        await expect(port.observe({ owner: 'al-admission', kind: 'write' })).rejects.toMatchObject({
            name: 'QuotaExceededError',
            message: 'Scripted storage quota fault quota-admission'
        });
        await expect(port.observe({ owner: 'al-work', kind: 'work-page' })).rejects.toMatchObject({
            name: 'UnknownError',
            message: 'Scripted storage fault fail-read'
        });
    });

    // A full disk refuses writes, so a quota fault leaves reads and the other owner alone.
    it.each(
        [
            { owner: 'al-admission', kind: 'read' },
            { owner: 'al-admission', kind: 'list' },
            { owner: 'al-work', kind: 'work-write' }
        ] as const
    )('lets $owner $kind through under a quota fault on al-admission', (operation) => {
        const port = createScriptedStorageFaultPort();
        port.inject(QUOTA_ON_ADMISSION_WRITES);

        expect(port.observe(operation)).toBeUndefined();
        expect(port.getObservations()).toEqual([]);
    });

    it.each(['work-write', 'work-reserve', 'work-release', 'work-cleanup'] as const)(
        'counts %s as a write of the work owner',
        async (kind) => {
            const port = createScriptedStorageFaultPort();
            port.inject({
                ...QUOTA_ON_ADMISSION_WRITES,
                match: { owner: 'al-work', kind: undefined }
            });

            await expect(port.observe({ owner: 'al-work', kind })).rejects.toMatchObject({
                name: 'QuotaExceededError'
            });
        }
    );

    it('fails any matching kind with UnknownError', async () => {
        const port = createScriptedStorageFaultPort();
        port.inject({
            faultId: 'fail-read',
            carrier: 'storage',
            match: { owner: 'al-admission', kind: 'read' },
            action: 'fail',
            remaining: 1
        });

        expect(port.observe({ owner: 'al-admission', kind: 'list' })).toBeUndefined();
        const failed = port.observe({ owner: 'al-admission', kind: 'read' });
        await expect(failed).rejects.toBeInstanceOf(DOMException);
        await expect(failed).rejects.toMatchObject({ name: 'UnknownError' });
    });

    it('holds a matching operation for its delay', async () => {
        vi.useFakeTimers();
        const port = createScriptedStorageFaultPort();
        port.inject({
            faultId: 'slow-page',
            carrier: 'storage',
            match: { owner: 'al-work', kind: 'work-page' },
            action: { delayMs: 50 },
            remaining: 'until-cleared'
        });
        let released = false;

        void port.observe({ owner: 'al-work', kind: 'work-page' })?.then(() => {
            released = true;
        });
        await vi.advanceTimersByTimeAsync(49);
        expect(released).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        expect(released).toBe(true);
        expect(port.getObservations()).toEqual([{
            faultId: 'slow-page',
            operation: { owner: 'al-work', kind: 'work-page' },
            decision: 'delay'
        }]);
    });

    it('spends a counted fault and keeps an until-cleared one', async () => {
        const port = createScriptedStorageFaultPort();
        port.inject({ ...QUOTA_ON_ADMISSION_WRITES, faultId: 'once', remaining: 1 });

        await expect(port.observe({ owner: 'al-admission', kind: 'write' })).rejects.toThrow();
        expect(port.observe({ owner: 'al-admission', kind: 'write' })).toBeUndefined();

        port.inject(QUOTA_ON_ADMISSION_WRITES);
        await expect(port.observe({ owner: 'al-admission', kind: 'write' })).rejects.toThrow();
        await expect(port.observe({ owner: 'al-admission', kind: 'write' })).rejects.toThrow();
    });

    // Re-injecting the same fault id with nothing remaining is how a recipe releases a held fault.
    it('releases a fault re-injected with nothing remaining', () => {
        const port = createScriptedStorageFaultPort();
        port.inject(QUOTA_ON_ADMISSION_WRITES);
        port.inject({ ...QUOTA_ON_ADMISSION_WRITES, remaining: 0 });

        expect(port.observe({ owner: 'al-admission', kind: 'write' })).toBeUndefined();
    });

    it('forgets its faults and observations on clear', async () => {
        const port = createScriptedStorageFaultPort();
        port.inject(QUOTA_ON_ADMISSION_WRITES);
        await expect(port.observe({ owner: 'al-admission', kind: 'write' })).rejects.toThrow();

        port.clear();

        expect(port.observe({ owner: 'al-admission', kind: 'write' })).toBeUndefined();
        expect(port.getObservations()).toEqual([]);
    });
});
