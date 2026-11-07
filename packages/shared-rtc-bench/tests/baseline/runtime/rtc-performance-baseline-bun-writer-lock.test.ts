import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { wrapFileHandle } from '../../../baseline/command/run-rtc-baseline-cli.ts';
import { RTC_BASELINE_WRITER_LOCK_STALE_AFTER_MS } from '../../../baseline/evidence/rtc-baseline-writer-lock.ts';

const staleAfterMs = RTC_BASELINE_WRITER_LOCK_STALE_AFTER_MS;

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
