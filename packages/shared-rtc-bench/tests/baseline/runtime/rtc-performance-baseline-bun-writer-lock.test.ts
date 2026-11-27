import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
    type PathLike
} from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { wrapFileHandle } from '../../../baseline/command/run-rtc-baseline-cli.ts';
import { RTC_BASELINE_WRITER_LOCK_STALE_AFTER_MS } from '../../../baseline/evidence/rtc-baseline-writer-lock.ts';

const staleAfterMs = RTC_BASELINE_WRITER_LOCK_STALE_AFTER_MS;

// Every read of the lock directory's age passes through here after it has resolved, so a test
// can hold one acquirer on what it saw while another acquirer runs to completion.
const lockAgeReads = vi.hoisted(() => {
    const pass = async (_path: string): Promise<void> => {};
    return { pass, afterRead: pass };
});

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...actual,
        stat: async (statPath: PathLike) => {
            const stats = await actual.stat(statPath);
            await lockAgeReads.afterRead(String(statPath));
            return stats;
        }
    };
});

function holdLockAgeRead(lockPath: string, readOrdinal: number) {
    const reached = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let reads = 0;
    lockAgeReads.afterRead = async (readPath) => {
        if (readPath !== lockPath) {
            return;
        }
        reads += 1;
        if (reads === readOrdinal) {
            reached.resolve();
            await released.promise;
        }
    };
    return {
        reached: reached.promise,
        passLaterReads() {
            lockAgeReads.afterRead = lockAgeReads.pass;
        },
        release() {
            lockAgeReads.afterRead = lockAgeReads.pass;
            released.resolve();
        }
    };
}

function createLockDirectory(lockPath: string, ageMs: number) {
    mkdirSync(lockPath);
    const staleTime = new Date(Date.now() - ageMs);
    utimesSync(lockPath, staleTime, staleTime);
}

function createLockScenario() {
    const directory = mkdtempSync(path.join(tmpdir(), 'rtc-baseline-writer-lock-'));
    const dataPath = path.join(directory, 'evidence.json');
    writeFileSync(dataPath, '{}');
    return { directory, dataPath, lockPath: `${dataPath}.lock` };
}

async function openWrappedFile(dataPath: string) {
    return wrapFileHandle(dataPath, await open(dataPath, 'r+'));
}

describe('RTC baseline Bun writer lock', () => {
    it('reclaims a lock directory whose mtime has exceeded the stale threshold', async () => {
        const scenario = createLockScenario();
        createLockDirectory(scenario.lockPath, staleAfterMs + 60_000);
        const file = await openWrappedFile(scenario.dataPath);
        try {
            expect(await file.tryLock()).toBe(true);
            expect(readdirSync(scenario.lockPath)).toEqual([]);
        }
        finally {
            await file.unlock();
            await file.close();
            rmSync(scenario.directory, { recursive: true, force: true });
        }
    });

    it('refuses to reclaim a fresh lock directory', async () => {
        const scenario = createLockScenario();
        createLockDirectory(scenario.lockPath, 0);
        const file = await openWrappedFile(scenario.dataPath);
        try {
            expect(await file.tryLock()).toBe(false);
            expect(readdirSync(scenario.lockPath)).toEqual([]);
        }
        finally {
            await file.close();
            rmSync(scenario.directory, { recursive: true, force: true });
        }
    });

    it('grants a stale lock to exactly one of two concurrent acquirers', async () => {
        const scenario = createLockScenario();
        createLockDirectory(scenario.lockPath, staleAfterMs + 60_000);
        const first = await openWrappedFile(scenario.dataPath);
        const second = await openWrappedFile(scenario.dataPath);
        try {
            const [firstHeld, secondHeld] = await Promise.all([first.tryLock(), second.tryLock()]);
            expect([firstHeld, secondHeld].filter(Boolean)).toHaveLength(1);
            // The winner leaves no reclaim artifact.
            expect(readdirSync(scenario.lockPath)).toEqual([]);
        }
        finally {
            await first.unlock();
            await second.unlock();
            await first.close();
            await second.close();
            rmSync(scenario.directory, { recursive: true, force: true });
        }
    });

    // The stale check and the removal are separate filesystem calls. Holding one acquirer on
    // the stale age it read, while the other reclaims and takes the lock, is the interleaving
    // in which a reclaimer could remove a lock that is no longer the one it examined.
    it.each([1, 2])(
        'grants a stale lock to exactly one acquirer when the other acts late on stale-age read %i',
        async (readOrdinal) => {
            const scenario = createLockScenario();
            createLockDirectory(scenario.lockPath, staleAfterMs + 60_000);
            const late = await openWrappedFile(scenario.dataPath);
            const prompt = await openWrappedFile(scenario.dataPath);
            const hold = holdLockAgeRead(scenario.lockPath, readOrdinal);
            const lateHeld = late.tryLock();
            try {
                await Promise.race([hold.reached, lateHeld]);
                hold.passLaterReads();
                const promptHeld = await prompt.tryLock();
                hold.release();
                expect([await lateHeld, promptHeld].filter(Boolean)).toHaveLength(1);
                // The winner's lock is still in place and no reclaim artifact is left beside it.
                expect(readdirSync(scenario.directory).sort()).toEqual(['evidence.json', 'evidence.json.lock']);
                expect(readdirSync(scenario.lockPath)).toEqual([]);
            }
            finally {
                hold.release();
                await lateHeld;
                await late.unlock();
                await prompt.unlock();
                await late.close();
                await prompt.close();
                rmSync(scenario.directory, { recursive: true, force: true });
            }
        }
    );

    it('retries instead of throwing when a held lock vanishes during the stale check', async () => {
        const scenario = createLockScenario();
        // A dangling symlink reproduces a lock directory that still exists for mkdir
        // (EEXIST) but is already gone when the stale check stats it (ENOENT).
        symlinkSync('/nonexistent-rtc-baseline-lock-owner', scenario.lockPath);
        const file = await openWrappedFile(scenario.dataPath);
        try {
            expect(await file.tryLock()).toBe(false);
        }
        finally {
            await file.close();
            rmSync(scenario.directory, { recursive: true, force: true });
        }
    });
});
