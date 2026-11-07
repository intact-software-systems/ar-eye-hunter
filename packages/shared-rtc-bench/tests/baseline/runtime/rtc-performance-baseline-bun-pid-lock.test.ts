import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { wrapFileHandle } from '../../../baseline/command/run-rtc-baseline-cli.ts';

// Beyond every supported pid_max (macOS 99998, Linux <= 4194304), so never a live process.
const deadOwnerPid = 2_147_483_647;

function createLockScenario(ownerPid: number) {
    const directory = mkdtempSync(path.join(tmpdir(), 'rtc-baseline-writer-lock-'));
    const dataPath = path.join(directory, 'evidence.json');
    writeFileSync(dataPath, '{}');
    writeFileSync(`${dataPath}.lock`, String(ownerPid));
    return { directory, dataPath, lockPath: `${dataPath}.lock` };
}

async function openWrappedFile(dataPath: string) {
    return wrapFileHandle(dataPath, await open(dataPath, 'r+'));
}

describe('RTC baseline Bun PID writer lock', () => {
    it('reclaims a lock whose owner PID is dead', async () => {
        const scenario = createLockScenario(deadOwnerPid);
        const file = await openWrappedFile(scenario.dataPath);
        try {
            expect(await file.tryLock()).toBe(true);
            expect(readFileSync(scenario.lockPath, 'utf8')).toBe(String(process.pid));
        }
        finally {
            await file.unlock();
            await file.close();
            rmSync(scenario.directory, { recursive: true, force: true });
        }
    });

    it('refuses to reclaim a lock whose owner PID is alive', async () => {
        const scenario = createLockScenario(process.pid);
        const file = await openWrappedFile(scenario.dataPath);
        try {
            expect(await file.tryLock()).toBe(false);
            expect(readFileSync(scenario.lockPath, 'utf8')).toBe(String(process.pid));
        }
        finally {
            await file.close();
            rmSync(scenario.directory, { recursive: true, force: true });
        }
    });

    it('grants a stale lock to exactly one of two concurrent acquirers', async () => {
        const scenario = createLockScenario(deadOwnerPid);
        const first = await openWrappedFile(scenario.dataPath);
        const second = await openWrappedFile(scenario.dataPath);
        try {
            const [firstHeld, secondHeld] = await Promise.all([first.tryLock(), second.tryLock()]);
            expect([firstHeld, secondHeld].filter(Boolean)).toHaveLength(1);
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
