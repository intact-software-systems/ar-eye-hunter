import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import { runOwnedTestProcess } from './owned-test-process.ts';

it('returns a valid same-binary inspector profile before terminating and reaping the probe', async (context) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'rallar-api-profile-'));
    context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    await runOwnedTestProcess(context, {
        executable: 'deno',
        args: ['run', '--no-config', '--allow-all', 'scripts/hosted-rallar/controller/rallar-api-inspector.mjs', 'probe', directory],
        options: { timeout: 15000 }
    });
    const profile = JSON.parse(await readFile(path.join(directory, 'api.cpuprofile'), 'utf8'));
    const result = JSON.parse(await readFile(path.join(directory, 'profile-result.json'), 'utf8'));
    const probe = JSON.parse(await readFile(path.join(directory, 'probe.json'), 'utf8'));
    expect(result.status).toBe('valid');
    expect(profile.samples.length).toBeGreaterThan(0);
    expect(profile.timeDeltas).toHaveLength(profile.samples.length);
    expect(profile.samples.every((id: number) => profile.nodes.some((node: { id: number; }) => node.id === id))).toBe(true);
    expect(result.clocks.start.before.api.pid).toBe(probe.pid);
    expect(result.clocks.stop.after.api.pid).toBe(probe.pid);
    expect(result.profileSavedBeforeClose).toBe(true);
    expect(probe.reaped).toBe(true);
    expect(probe.gcEvents).toBe('not-established');
    expect(() => process.kill(probe.pid, 0)).toThrow();
}, 20000);

it('rejects malformed profile nodes, deltas and samples without inventing a clock mapping', async () => {
    const { validateApiCpuProfile, computeApiProfileClockBounds } = await import('../../../scripts/hosted-rallar/controller/rallar-api-inspector.mjs');
    const profile = { nodes: [{ id: 1, callFrame: {} }], samples: [1], timeDeltas: [100], startTime: 1000, endTime: 2000 };
    expect(validateApiCpuProfile(profile)).toEqual([]);
    expect(validateApiCpuProfile({ ...profile, samples: [2] })).not.toEqual([]);
    expect(validateApiCpuProfile({ ...profile, timeDeltas: [-1] })).not.toEqual([]);
    expect(validateApiCpuProfile({ ...profile, nodes: [{ id: 1, callFrame: {}, children: [4] }] })).not.toEqual([]);
    expect(validateApiCpuProfile({ ...profile, timeDeltas: [5000] })).not.toEqual([]);
    expect(validateApiCpuProfile({ ...profile, samples: Array(6_000_000).fill(1), timeDeltas: Array(6_000_000).fill(0) })).toContain(
        'Profile sample limit exceeded'
    );
    const clock = (epochMs: number, monotonicMs: number) => ({ api: { epochMs, monotonicMs } });
    const clocks = { start: { before: clock(1000, 0), after: clock(1001, 1) }, stop: { before: clock(2000, 2), after: clock(2001, 3) } };
    expect(computeApiProfileClockBounds(profile, clocks)).toMatchObject({ attribution: 'inconclusive-clock-disagreement', offsetEpochMs: null });
});
