import {
    mkdir,
    mkdtemp,
    readFile,
    rm
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it } from 'vitest';

import { toError } from '../../shared/resilience/to-error.ts';

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
    expect(result.sampleTiming.issues).toEqual([]);
    expect(result.sampleTiming.timestampReversals).toBeGreaterThanOrEqual(0);
    expect(result.sampleTiming.unrepresentedTailSeconds).toBeGreaterThanOrEqual(0);
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

it('preserves a consistent wide clock mapping while leaving stall attribution inconclusive', async () => {
    const { computeApiProfileClockBounds } = await import('../../../scripts/hosted-rallar/controller/rallar-api-inspector.mjs');
    const clock = (epochMs: number, monotonicMs: number) => ({ api: { epochMs, monotonicMs } });
    const clocks = {
        start: { before: clock(1000, 0), after: clock(3000, 2000) },
        stop: { before: clock(6000, 5000), after: clock(8000, 7000) }
    };
    expect(computeApiProfileClockBounds({ startTime: 1_000_000, endTime: 6_000_000 }, clocks)).toMatchObject({
        offsetEpochMs: [-1, 2001],
        uncertaintyMs: 2002,
        calibration: 'interval-calibrated',
        attribution: 'inconclusive-until-stall-window-analysis'
    });
});

it.for(['stdout.log', 'stderr.log'])('fails probe output setup at %s without leaving an owned child', async (file, context) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'rallar-api-probe-output-'));
    context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    await mkdir(path.join(directory, file));
    await expect(runOwnedTestProcess(context, {
        executable: 'deno',
        args: ['run', '--no-config', '--allow-all', 'scripts/hosted-rallar/controller/rallar-api-inspector.mjs', 'probe', directory],
        options: { timeout: 15000 }
    })).rejects.toMatchObject({ stderr: expect.stringContaining(file) });
    const probe = JSON.parse(await readFile(path.join(directory, 'probe.json'), 'utf8'));
    expect(probe).toMatchObject({ pid: null, reaped: false, outcome: null });
    expect(probe.error).toContain(file);
    await expect(readFile(path.join(directory, 'api.cpuprofile'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('reaps a probe that exits during capture while preserving the original inspector failure', async (context) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'rallar-api-probe-exit-'));
    context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const execution = runOwnedTestProcess(context, {
        executable: 'deno',
        args: ['run', '--no-config', '--allow-all', 'scripts/hosted-rallar/controller/rallar-api-inspector.mjs', 'probe', directory],
        options: { timeout: 15000 }
    }).then(() => null, toError);
    let pid: number | undefined;
    const deadline = Date.now() + 5000;
    while (pid === undefined && Date.now() < deadline) {
        try {
            pid = JSON.parse(await readFile(path.join(directory, 'started.json'), 'utf8')).pid;
        }
        catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
                throw error;
            }
            await sleep(5);
        }
    }
    if (pid === undefined) {
        throw new Error('Probe did not publish its owned process identity');
    }
    process.kill(pid, 'SIGTERM');
    expect(await execution).toMatchObject({ code: 1 });
    const probe = JSON.parse(await readFile(path.join(directory, 'probe.json'), 'utf8'));
    const result = JSON.parse(await readFile(path.join(directory, 'profile-result.json'), 'utf8'));
    expect(probe).toMatchObject({ pid, reaped: true, error: result.error });
    expect(probe.error).toMatch(/Inspector.*(connection|transport)/i);
    expect(probe.error).not.toContain('already terminated');
    expect(() => process.kill(pid, 0)).toThrow();
});

it('preserves paired samples with bounded signed timestamp reversals and reports the unrepresented tail', async () => {
    const { validateApiCpuProfile, computeApiProfileSampleTiming } = await import('../../../scripts/hosted-rallar/controller/rallar-api-inspector.mjs');
    const profile = {
        nodes: [{ id: 1, callFrame: {} }, { id: 2, callFrame: {} }],
        samples: [1, 2, 1, 2, 1],
        timeDeltas: [100, -3, 10, -7, 5],
        startTime: 1000,
        endTime: 1200
    };
    const original = JSON.stringify(profile);
    expect(validateApiCpuProfile(profile)).toEqual([]);
    expect(computeApiProfileSampleTiming(profile)).toEqual({
        issues: [],
        timestampReversals: 2,
        largestTimestampReversalSeconds: 0.000007,
        unrepresentedTailSeconds: 0.000093
    });
    expect(JSON.stringify(profile)).toBe(original);
});

it.for([
    { timeDeltas: [0.5] },
    { timeDeltas: [NaN] },
    { timeDeltas: [Infinity] },
    { timeDeltas: [Number.MAX_SAFE_INTEGER + 1] },
    { timeDeltas: [2147483648], endTime: 4_000_000_000 },
    { timeDeltas: [2147483647, 2147483647, -2147483649], samples: [1, 1, 1], endTime: 5_000_000_000 },
    { timeDeltas: [100, -101], samples: [1, 1] },
    { timeDeltas: [1001, -1], samples: [1, 1] },
    { startTime: 1000.1 },
    { endTime: Number.MAX_SAFE_INTEGER + 1 },
    { startTime: Number.MAX_SAFE_INTEGER - 10, endTime: Number.MAX_SAFE_INTEGER, timeDeltas: [20] },
    { samples: [] },
    { timeDeltas: [] },
    { samples: [2] },
    { nodes: [{ id: 1, callFrame: {} }, { id: 1, callFrame: {} }] },
    { nodes: [null] },
    { nodes: [{ id: 1, callFrame: {}, children: 2 }] }
])('rejects malformed native sample identity or arithmetic: %j', async (change) => {
    const { validateApiCpuProfile } = await import('../../../scripts/hosted-rallar/controller/rallar-api-inspector.mjs');
    const profile = { nodes: [{ id: 1, callFrame: {} }], samples: [1], timeDeltas: [100], startTime: 1000, endTime: 2000 };
    expect(validateApiCpuProfile({ ...profile, ...change })).not.toEqual([]);
});
