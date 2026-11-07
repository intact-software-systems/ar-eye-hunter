import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { wrapFileHandle } from '../../../baseline/command/run-rtc-baseline-cli.ts';

const staleAfterMs = 10 * 60_000;

// A sentinel owner PID that is never this test process.
const foreignOwnerPid = 99_999;

function createLockDirectory(lockPath: string, ageMs: number) {
    mkdirSync(lockPath);
    writeFileSync(path.join(lockPath, 'owner'), `${foreignOwnerPid}\n`);
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
            expect(readFileSync(path.join(scenario.lockPath, 'owner'), 'utf8')).toBe(`${process.pid}\n`);
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
            expect(readFileSync(path.join(scenario.lockPath, 'owner'), 'utf8')).toBe(`${foreignOwnerPid}\n`);
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
            // The winner leaves exactly one owner marker and no reclaim artifact.
            expect(readdirSync(scenario.lockPath)).toEqual(['owner']);
        }
        finally {
            await first.unlock();
            await second.unlock();
            await first.close();
            await second.close();
            rmSync(scenario.directory, { recursive: true, force: true });
        }
    });
});
