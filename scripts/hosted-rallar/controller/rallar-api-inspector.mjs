// This module owns one probe process; a lost process is never replaced.
//
// CPU-profile capture is reimplemented against Bun's native `--cpu-prof` (JavaScriptCore)
// because Bun 1.4.4 has no `Bun.cpuProfiling` API and its inspector exposes no Profiler domain.
// `--cpu-prof` profiles launch → exit and flushes the `.cpuprofile` on clean exit only, so the
// probe profiles a short-lived child that does representative work and exits cleanly.
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';

function readHostClock() {
    return { epochMs: Date.now(), monotonicMs: performance.now() };
}

async function fileExists(file) {
    try {
        await stat(file);
        return true;
    }
    catch (error) {
        if (error?.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

async function writeJson(file, value) {
    await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
    await rename(`${file}.tmp`, file);
}

async function readJson(file) {
    return JSON.parse(await readFile(file, 'utf8'));
}

export function validateApiCpuProfile(profile) {
    const issues = [];
    if (
        !profile || !Array.isArray(profile.nodes) || !Array.isArray(profile.samples) ||
        !Array.isArray(profile.timeDeltas)
    ) {
        return ['Missing profile nodes, samples or time deltas'];
    }
    if (profile.samples.length >= 6_000_000) {
        return ['Profile sample limit exceeded'];
    }
    const ids = new Set(profile.nodes.map((node) => node?.id));
    if (
        ids.size !== profile.nodes.length ||
        !profile.nodes.every((node) =>
            Number.isSafeInteger(node?.id) && node.id > 0 && node.callFrame && typeof node.callFrame === 'object'
        )
    ) {
        issues.push('Invalid or duplicated profile nodes');
    }
    if (
        !profile.nodes.every((node) =>
            node && (node.children === undefined ||
                (Array.isArray(node.children) && node.children.every((id) => ids.has(id))))
        )
    ) {
        issues.push('Unknown child node');
    }
    if (
        !profile.samples.length || profile.samples.length !== profile.timeDeltas.length ||
        !profile.samples.every((id) => ids.has(id))
    ) {
        issues.push('Invalid profile samples');
    }
    issues.push(...computeApiProfileSampleTiming(profile).issues);
    return issues;
}

export function computeApiProfileSampleTiming(profile) {
    const issues = [];
    const span = profile.endTime - profile.startTime;
    if (
        !Number.isSafeInteger(profile.startTime) || profile.startTime < 0 ||
        !Number.isSafeInteger(profile.endTime) || !Number.isSafeInteger(span) || span <= 0
    ) {
        issues.push('Invalid profile span');
    }
    let timestamp = profile.startTime;
    let latestTimestamp = profile.startTime;
    let timestampReversals = 0;
    let largestReversal = 0;
    for (const delta of profile.timeDeltas) {
        if (!Number.isSafeInteger(delta) || delta < -2147483648 || delta > 2147483647) {
            issues.push('Invalid profile time deltas');
            break;
        }
        timestamp += delta;
        if (!Number.isSafeInteger(timestamp) || timestamp < profile.startTime || timestamp > profile.endTime) {
            issues.push('Sample timestamp outside profile bounds');
            break;
        }
        if (delta < 0) {
            timestampReversals += 1;
            largestReversal = Math.max(largestReversal, -delta);
        }
        latestTimestamp = Math.max(latestTimestamp, timestamp);
    }
    return {
        issues,
        timestampReversals,
        largestTimestampReversalSeconds: largestReversal / 1_000_000,
        unrepresentedTailSeconds: issues.length ? null : (profile.endTime - latestTimestamp) / 1_000_000
    };
}

export function computeApiProfileClockBounds(profile, clocks) {
    const start = [
        clocks.start.before.api.epochMs - 1 - profile.startTime / 1000,
        clocks.start.after.api.epochMs + 1 - profile.startTime / 1000
    ];
    const stop = [
        clocks.stop.before.api.epochMs - 1 - profile.endTime / 1000,
        clocks.stop.after.api.epochMs + 1 - profile.endTime / 1000
    ];
    const offset = [Math.max(start[0], stop[0]), Math.min(start[1], stop[1])];
    const epochElapsed = clocks.stop.after.api.epochMs - clocks.start.before.api.epochMs;
    const monotonicElapsed = clocks.stop.after.api.monotonicMs - clocks.start.before.api.monotonicMs;
    const stable = Math.abs(epochElapsed - monotonicElapsed) <= 2 && offset[0] <= offset[1];
    return {
        startOffsetEpochMs: start,
        stopOffsetEpochMs: stop,
        offsetEpochMs: stable ? offset : null,
        uncertaintyMs: stable ? offset[1] - offset[0] : null,
        calibration: stable ? 'interval-calibrated' : 'invalid-clock-disagreement',
        attribution: stable ? 'inconclusive-until-stall-window-analysis' : 'inconclusive-clock-disagreement'
    };
}

// Bun's native `.cpuprofile` reports `endTime` as a fractional microsecond float (and `startTime`
// can carry a fractional tail too). The validators require safe-integer timestamps, so the
// emission path rounds the span endpoints to safe integers without touching the validators.
function normalizeApiProfile(profile) {
    const startTime = Math.floor(profile.startTime);
    const lastTimestamp = profile.timeDeltas.reduce((timestamp, delta) => timestamp + delta, startTime);
    return {
        ...profile,
        startTime,
        endTime: Math.max(Math.ceil(profile.endTime), lastTimestamp)
    };
}

function waitWithDeadline(promise, deadlineEpochMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('Probe process did not finish before the capture deadline'));
        }, Math.max(0, deadlineEpochMs - Date.now()));
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

async function recordProbeProfile(directory, child, launch, deadlineEpochMs) {
    const clocks = {};
    try {
        await waitWithDeadline(child.exited, deadlineEpochMs);
        if (!await fileExists(`${directory}/api.cpuprofile`)) {
            throw new Error('Probe process exited before writing a CPU profile');
        }
        const profile = normalizeApiProfile(await readJson(`${directory}/api.cpuprofile`));
        const childClocks = await readJson(`${directory}/clocks.json`);
        const hostStop = readHostClock();
        clocks.start = {
            before: { before: launch, api: childClocks.start, after: launch },
            after: { before: launch, api: childClocks.start, after: launch }
        };
        clocks.stop = {
            before: { before: hostStop, api: childClocks.stop, after: hostStop },
            after: { before: hostStop, api: childClocks.stop, after: hostStop }
        };
        const issues = validateApiCpuProfile(profile);
        if (issues.length) {
            throw new Error(issues.join('; '));
        }
        await writeFile(`${directory}/api.cpuprofile`, JSON.stringify(profile));
        const mapping = computeApiProfileClockBounds(profile, clocks);
        const gcOriginEpochBounds = [launch.epochMs, hostStop.epochMs];
        await writeJson(`${directory}/profile-result.json`, {
            status: 'valid',
            pid: child.pid,
            clocks,
            mapping,
            sampleTiming: computeApiProfileSampleTiming(profile),
            gcOriginEpochBounds,
            gcOriginUncertaintyMs: gcOriginEpochBounds[1] - gcOriginEpochBounds[0],
            gcAttribution: 'inconclusive-until-runtime-trace-semantics-and-log-coverage-verified',
            profileSavedBeforeClose: true
        });
    }
    catch (error) {
        await writeJson(`${directory}/profile-result.json`, {
            status: 'failed',
            pid: child.pid,
            clocks,
            error: error.message
        });
        throw error;
    }
}

async function captureApiProfile(directory) {
    // Bun 1.4.4 cannot profile a live process on demand: there is no `Bun.cpuProfiling` API and
    // the JavaScriptCore inspector exposes no Profiler domain. The only CPU profiling is
    // launch → exit `--cpu-prof`, which flushes on clean exit only, so a live API process cannot
    // be captured. Fail loudly instead of silently no-oping.
    const message = 'Live CPU-profile capture is unsupported on Bun 1.4.4: no Bun.cpuProfiling API and no ' +
        'JavaScriptCore Profiler inspector domain; only launch-to-exit --cpu-prof exists and it ' +
        'cannot profile a live process on demand';
    try {
        const target = await readJson(`${directory}/target.json`);
        await writeJson(`${directory}/profile-result.json`, {
            status: 'failed',
            pid: target.pid ?? null,
            clocks: {},
            error: message
        });
    }
    catch {
        // The segment directory may not be ready; the thrown error is the authoritative signal.
    }
    throw new Error(message);
}

async function probeApiInspector(directory) {
    await mkdir(directory, { recursive: true });
    const launch = readHostClock();
    let child;
    let stdoutHandle;
    let stderrHandle;
    let outcome = null;
    let failure;
    try {
        const started = await startProbeProcess(directory);
        child = started.child;
        stdoutHandle = started.stdoutHandle;
        stderrHandle = started.stderrHandle;
        await writeJson(`${directory}/started.json`, { pid: child.pid });
        await recordProbeProfile(directory, child, launch, Date.now() + 15000);
    }
    catch (error) {
        failure = error;
    }
    finally {
        if (child) {
            const stopped = await stopProbeProcess(child, stdoutHandle, stderrHandle);
            outcome = stopped.outcome;
            failure ??= stopped.failure;
        }
        try {
            await writeJson(`${directory}/probe.json`, {
                pid: child?.pid ?? null,
                runtime: process.versions,
                launch,
                reaped: outcome !== null,
                outcome,
                error: failure?.message ?? null,
                gcEvents: 'not-established'
            });
        }
        catch (error) {
            failure ??= error;
        }
    }
    if (failure) {
        throw failure;
    }
}

async function startProbeProcess(directory) {
    let stdoutHandle;
    let stderrHandle;
    const clockFile = `${directory}/clocks.json`;
    const probeChildSource = `
import { writeFileSync } from 'node:fs';
const clock = () => ({ epochMs: Date.now(), monotonicMs: performance.now(), timeOriginMs: performance.timeOrigin, pid: process.pid });
const start = clock();
let accumulator = 0;
while (performance.now() - start.monotonicMs < 1500) {
    accumulator = (accumulator + 1) & 0x7fffffff;
}
const stop = clock();
writeFileSync(${JSON.stringify(clockFile)}, JSON.stringify({ start, stop, accumulator }));
`;
    try {
        // Output setup must succeed before creating the process this probe owns.
        stdoutHandle = await open(`${directory}/stdout.log`, 'wx');
        stderrHandle = await open(`${directory}/stderr.log`, 'wx');
        const child = Bun.spawn({
            cmd: [
                process.execPath,
                '--cpu-prof',
                '--cpu-prof-name=api.cpuprofile',
                `--cpu-prof-dir=${directory}`,
                '-e',
                probeChildSource
            ],
            stdout: stdoutHandle.fd,
            stderr: stderrHandle.fd
        });
        return { child, stdoutHandle, stderrHandle };
    }
    catch (error) {
        await stdoutHandle?.close();
        await stderrHandle?.close();
        throw error;
    }
}

async function stopProbeProcess(child, stdoutHandle, stderrHandle) {
    let failure;
    const kill = (signal) => {
        try {
            child.kill(signal);
        }
        catch (error) {
            failure ??= error;
        }
    };
    kill('SIGTERM');
    const forceStop = setTimeout(() => kill('SIGKILL'), 1000);
    try {
        const outcome = await child.exited;
        return { outcome, failure };
    }
    finally {
        clearTimeout(forceStop);
        await stdoutHandle?.close();
        await stderrHandle?.close();
    }
}

if (import.meta.main) {
    const [operation, directory] = process.argv.slice(2);
    if (operation === 'probe') {
        await probeApiInspector(directory);
    }
    else if (operation === 'capture') {
        await captureApiProfile(directory);
    }
    else {
        throw new Error('Expected probe or capture');
    }
}
