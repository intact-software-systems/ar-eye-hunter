// This client owns one inspector connection; a lost process is never replaced.
import { setTimeout as sleep } from 'node:timers/promises';

const clockExpression =
    '({epochMs:Date.now(),monotonicMs:performance.now(),timeOriginMs:performance.timeOrigin,pid:Deno.pid})';

class ApiInspector {
    constructor(socket, pid) {
        this.socket = socket;
        this.pid = pid;
        this.nextId = 0;
        this.pending = new Map();
        socket.addEventListener('message', (event) => this.receive(event.data));
        socket.addEventListener('close', () => this.fail(new Error('Inspector connection lost')));
        socket.addEventListener('error', () => this.fail(new Error('Inspector transport failed')));
    }

    receive(text) {
        try {
            if (new TextEncoder().encode(text).byteLength >= 128 * 1024 * 1024) {
                this.fail(new Error('Profile protocol limit exceeded (128 MiB)'));
                return;
            }
            const message = JSON.parse(text);
            const pending = this.pending.get(message.id);
            if (!pending) {
                return;
            }
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.error) {
                pending.reject(new Error(`Inspector rejected ${pending.method}: ${message.error.code}`));
            }
            else {
                pending.resolve(message.result);
            }
        }
        catch {
            this.fail(new Error('Malformed inspector response'));
        }
    }

    fail(error) {
        this.failure = error;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }

    request(method, params = {}) {
        if (this.failure) {
            return Promise.reject(this.failure);
        }
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Inspector timeout: ${method}`));
            }, 10000);
            this.pending.set(id, { method, resolve, reject, timer });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    async readClock() {
        const before = readHostClock();
        const evaluation = await this.request('Runtime.evaluate', { expression: clockExpression, returnByValue: true });
        const after = readHostClock();
        const api = evaluation?.result?.value;
        if (api?.pid !== this.pid || ![api.epochMs, api.monotonicMs, api.timeOriginMs].every(Number.isFinite)) {
            throw new Error('Inspector API PID/clock mismatch');
        }
        return { before, api, after };
    }

    async bracket(method) {
        const before = await this.readClock();
        const result = await this.request(method);
        const after = await this.readClock();
        return { before, after, result };
    }
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

async function captureApiProfile(directory, target) {
    let inspector;
    const clocks = {};
    try {
        inspector = await connectApiInspector(target);
        await inspector.request('Profiler.enable');
        const start = await inspector.bracket('Profiler.start');
        clocks.start = { before: start.before, after: start.after };
        await writeJson(`${directory}/started.json`, { pid: target.pid, clocks, launch: target.launch });
        while (!await fileExists(`${directory}/stop`)) {
            if (inspector.failure) {
                throw inspector.failure;
            }
            if (Date.now() >= target.deadlineEpochMs) {
                throw new Error('Capture deadline expired');
            }
            await sleep(100);
        }
        clocks.stop = { before: await inspector.readClock() };
        const stopped = await inspector.request('Profiler.stop');
        await Deno.writeTextFile(`${directory}/api.cpuprofile`, JSON.stringify(stopped.profile));
        clocks.stop.after = await inspector.readClock();
        const issues = validateApiCpuProfile(stopped.profile);
        if (issues.length) {
            throw new Error(issues.join('; '));
        }
        const mapping = computeApiProfileClockBounds(stopped.profile, clocks);
        const gcOriginEpochBounds = [target.launch.epochMs, clocks.start.before.after.epochMs];
        await inspector.request('Profiler.disable');
        await writeJson(`${directory}/profile-result.json`, {
            status: 'valid',
            pid: target.pid,
            clocks,
            mapping,
            sampleTiming: computeApiProfileSampleTiming(stopped.profile),
            gcOriginEpochBounds,
            gcOriginUncertaintyMs: gcOriginEpochBounds[1] - gcOriginEpochBounds[0],
            gcAttribution: 'inconclusive-until-runtime-trace-semantics-and-log-coverage-verified',
            profileSavedBeforeClose: true
        });
    }
    catch (error) {
        await writeJson(`${directory}/profile-result.json`, {
            status: 'failed',
            pid: target.pid,
            clocks,
            error: error.message
        });
        throw error;
    }
    finally {
        inspector?.socket.close();
    }
}

async function connectApiInspector(target) {
    const endpoint = new URL(target.endpoint);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') {
        throw new Error('Inspector must bind loopback');
    }
    const deadline = Date.now() + 10000;
    let address;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${target.endpoint}/json/list`, { signal: AbortSignal.timeout(500) });
            const targets = await response.json();
            if (targets.length !== 1) {
                throw new Error('Expected exactly one inspector target');
            }
            address = new URL(targets[0].webSocketDebuggerUrl);
            break;
        }
        catch {
            await sleep(50);
        }
    }
    if (!address || address.hostname !== '127.0.0.1' || address.port !== endpoint.port || address.protocol !== 'ws:') {
        throw new Error('No owned loopback inspector endpoint');
    }
    const socket = new WebSocket(address.href);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.close();
            reject(new Error('Inspector connection timeout'));
        }, 5000);
        socket.addEventListener('open', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
        socket.addEventListener('error', () => {
            clearTimeout(timer);
            reject(new Error('Inspector connection failed'));
        }, { once: true });
    });
    return new ApiInspector(socket, target.pid);
}

function readHostClock() {
    return { epochMs: Date.now(), monotonicMs: performance.now() };
}
async function fileExists(file) {
    try {
        await Deno.stat(file);
        return true;
    }
    catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return false;
        }
        throw error;
    }
}
async function writeJson(file, value) {
    await Deno.writeTextFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
    await Deno.rename(`${file}.tmp`, file);
}

async function probeApiInspector(directory) {
    await Deno.mkdir(directory, { recursive: true });
    const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    const port = listener.addr.port;
    listener.close();
    const launch = readHostClock();
    let child;
    let streams;
    let stopTimer;
    let outcome = null;
    let failure;
    try {
        const started = await startProbeProcess(directory, port);
        child = started.child;
        streams = started.streams;
        stopTimer = setTimeout(() => Deno.writeTextFile(`${directory}/stop`, '').catch(() => {}), 500);
        await captureApiProfile(directory, {
            pid: child.pid,
            endpoint: `http://127.0.0.1:${port}`,
            launch,
            deadlineEpochMs: Date.now() + 10000
        });
    }
    catch (error) {
        failure = error;
    }
    finally {
        clearTimeout(stopTimer);
        if (child) {
            const stopped = await stopProbeProcess(child, streams);
            outcome = stopped.outcome;
            failure ??= stopped.failure;
        }
        try {
            await writeJson(`${directory}/probe.json`, {
                pid: child?.pid ?? null,
                runtime: Deno.version,
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

async function startProbeProcess(directory, port) {
    let stdout;
    let stderr;
    try {
        // Output setup must succeed before creating the process this probe owns.
        stdout = await Deno.open(`${directory}/stdout.log`, { create: true, write: true });
        stderr = await Deno.open(`${directory}/stderr.log`, { create: true, write: true });
        const child = new Deno.Command(Deno.execPath(), {
            args: [
                'eval',
                '--no-config',
                `--inspect=127.0.0.1:${port}`,
                '--v8-flags=--trace-gc-nvp',
                'setInterval(() => {}, 20)'
            ],
            stdout: 'piped',
            stderr: 'piped'
        }).spawn();
        const streams = Promise.allSettled([
            child.stdout.pipeTo(stdout.writable),
            child.stderr.pipeTo(stderr.writable)
        ]);
        return { child, streams };
    }
    catch (error) {
        stdout?.close();
        stderr?.close();
        throw error;
    }
}

async function stopProbeProcess(child, streams) {
    let failure;
    const kill = (signal) => {
        try {
            child.kill(signal);
        }
        catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) {
                failure ??= error;
            }
        }
    };
    kill('SIGTERM');
    const forceStop = setTimeout(() => kill('SIGKILL'), 1000);
    try {
        const outcome = await child.status;
        for (const result of await streams) {
            if (result.status === 'rejected') {
                failure ??= result.reason;
            }
        }
        return { outcome, failure };
    }
    finally {
        clearTimeout(forceStop);
    }
}

if (import.meta.main) {
    const [operation, directory] = Deno.args;
    if (operation === 'probe') {
        await probeApiInspector(directory);
    }
    else if (operation === 'capture') {
        await captureApiProfile(directory, JSON.parse(await Deno.readTextFile(`${directory}/target.json`)));
    }
    else {
        throw new Error('Expected probe or capture');
    }
}
