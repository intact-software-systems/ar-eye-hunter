import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
    mkdir,
    readFile,
    stat,
    writeFile
} from 'node:fs/promises';
import {
    basename,
    join,
    resolve
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BASE_COMMIT = '1f3dc1d962d8000506023bb6606bfc27e2ee5424';
const SOURCE_PATHS = [
    'apps/api-v1/test/db/native-session-test-fixture.ts',
    '.github/workflows/v1c-native-setup-diagnostic.yml',
    'scripts/native-setup-observation/write-safe-native-observation-artifacts.mjs',
    'scripts/native-setup-observation/safe-native-observation-artifacts.test.mjs'
];
const CASES = [
    ['native15-parent', 'fifteen native same-user sessions complete room setup through production automatic queues'],
    [
        'native15-child',
        'fifteen native same-user sessions complete concurrent room setup through default automatic queues'
    ],
    [
        'receiver-receipts-parent',
        'automatic fourteen-receiver receipts complete through native API WebSockets after held ACK release'
    ],
    [
        'receiver-receipts-child',
        'fourteen automatic receiver ACKs cross native API sockets and complete the exact origin receipt after release'
    ]
];
const REQUEST_ID = /^native-room-(?:create|join-request|presence)-(?:[0-9]|1[0-4])$/;
const TIMING_KEYS = [
    'type',
    'component',
    'operation',
    'status',
    'durationMs',
    'atEpochMs',
    'serviceId',
    'requestId',
    'details',
    'error'
];
const HTTP_KEYS = ['type', 'stage', 'requestId', 'processId', 'atEpochMs', 'monotonicMs', 'elapsedMs', 'status'];
const DETAIL_KEYS = [
    'type',
    'topicId',
    'contextId',
    'resourceId',
    'senderId',
    'attempt',
    'attempts',
    'selectedLane',
    'queueAgeMs',
    'dueAgeMs',
    'queueObservation',
    'nextAttempt',
    'delayMsecs',
    'elapsedMsecs',
    'waitMaxElapsedMsecs',
    'errorName',
    'errorMessage',
    'errorCode',
    'classification'
];
const QUEUE_OBSERVATIONS = [
    'missing',
    'NEW',
    'RESERVED',
    'RETRY',
    'COMPLETED',
    'FAILED',
    'NON_RETRYABLE',
    'other-status',
    'read-failure'
];

export async function writeSafeNativeObservationArtifacts(input) {
    const issues = validateArtifactInput(input, process.cwd());
    if (issues.length) {
        throw new ArtifactInputError(issues);
    }
    const projection = new NativePhaseProjection(input.limits);
    for (const stream of ['stdout', 'stderr']) {
        await readBoundedLines({ path: join(input.rawDirectory, `${stream}.log`), stream, projection });
    }
    const exitCode = await readExitCode(input.rawDirectory, projection.coverage);
    await mkdir(input.safeDirectory, { recursive: true });
    const summary = {
        formatVersion: 1,
        diagnosticOnly: true,
        phaseTiming: true,
        custody: input.custody,
        originalExitCode: exitCode,
        testCounts: projection.testCounts,
        nativeCases: projection.nativeCases,
        coverage: projection.coverage,
        interpretation: {
            epochClock: 'Date.now',
            durationClock: 'monotonic',
            serverHandlerReturn: 'UNKNOWN',
            opaqueKeyFields: 'SHA-256 of exact canonical timing strings; resourceId is the controlled request label',
            observerCost: 'phase timing and guarded scalar console records add diagnostic overhead'
        }
    };
    await writeFile(join(input.safeDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    await writeFile(
        join(input.safeDirectory, 'observations.jsonl'),
        projection.observations.map((event) => `${JSON.stringify(event)}\n`).join('')
    );
}

class ArtifactInputError extends Error {
    constructor(issues) {
        super(issues.length === 1 ? issues[0].message : 'Invalid artifact input');
        this.name = 'ArtifactInputError';
        this.issues = issues;
    }
}

class NativePhaseProjection {
    observations = [];
    testCounts = [];
    nativeCases = [];
    coverage = {
        rejectedEvents: 0,
        malformedJsonLines: 0,
        invalidExitEvidence: false,
        missingStreams: [],
        unreadableStreams: [],
        oversizedLines: 0,
        observationOverflow: 0,
        countOverflow: 0,
        inputOverflowStreams: [],
        partialFinalLines: [],
        unscopedEvents: 0
    };
    activeCases = new Map();

    constructor(limits) {
        this.limits = limits;
    }

    acceptLine(input) {
        const line = input.line.replace(/\x1b\[[0-9;]*m/g, '').trim();
        this.observeCase(line, input.stream);
        this.observeCounts(line, input);
        if (!line.startsWith('{')) {
            return;
        }
        let raw;
        try {
            raw = JSON.parse(line);
        }
        catch {
            this.coverage.malformedJsonLines += 1;
            return;
        }
        if (
            !isRecord(raw) || !['rallar.timing', 'native.http.phase'].includes(raw.type) || !('requestId' in raw)
        ) {
            return;
        }
        if (typeof raw.requestId !== 'string') {
            this.coverage.rejectedEvents += 1;
            return;
        }
        if (!REQUEST_ID.test(raw.requestId)) {
            return;
        }
        const event = raw.type === 'rallar.timing' ? toSafeTimingEvent(raw) : toSafeHttpEvent(raw);
        if (!event) {
            this.coverage.rejectedEvents += 1;
            return;
        }
        const caseId = this.activeCases.get(input.stream) ?? null;
        if (caseId === null) {
            this.coverage.unscopedEvents += 1;
        }
        if (this.observations.length >= this.limits.maxObservations) {
            this.coverage.observationOverflow += 1;
            return;
        }
        this.observations.push({ ...event, caseId, stream: input.stream, lineOrdinal: input.lineOrdinal });
    }

    observeCase(line, stream) {
        for (const [id, name] of CASES) {
            if (!line.startsWith(`${name} ...`)) {
                continue;
            }
            const suffix = line.slice(name.length + 4).trim();
            const outcome = /^(?:ok|FAILED)(?:\s|$)/.exec(suffix)?.[0].trim();
            let entry = this.nativeCases.find((value) => value.id === id && value.stream === stream);
            if (!entry) {
                entry = { id, stream, outcome: 'missing' };
                this.nativeCases.push(entry);
            }
            if (outcome) {
                entry.outcome = outcome === 'ok' ? 'passed' : 'failed';
                this.activeCases.delete(stream);
            }
            else {
                this.activeCases.set(stream, id);
            }
        }
    }

    observeCounts(line, input) {
        const match = /^(?:ok|FAILED) \| (\d+) passed \| (\d+) failed(?:\s|$)/.exec(line);
        if (!match) {
            return;
        }
        const passed = Number(match[1]);
        const failed = Number(match[2]);
        if (!safeInteger(passed) || !safeInteger(failed)) {
            return;
        }
        if (this.testCounts.length >= this.limits.maxCountReports) {
            this.coverage.countOverflow += 1;
            return;
        }
        this.testCounts.push({ stream: input.stream, lineOrdinal: input.lineOrdinal, passed, failed });
    }
}

function toSafeTimingEvent(raw) {
    const selected = raw.component === 'app-inbox-phase' &&
            ['transaction', 'enqueue', 'wait-poll', 'wait-retry', 'wait-completion', 'read-result'].includes(
                raw.operation
            ) ||
        raw.component === 'app-inbox' && raw.operation === 'enqueueAndWaitForResult';
    if (
        !selected || !onlyKeys(raw, TIMING_KEYS) || !['ok', 'error'].includes(raw.status) ||
        !safeInteger(raw.atEpochMs) || !boundedDuration(raw.durationMs)
    ) {
        return undefined;
    }
    const details = toSafeDetails(raw.details ?? {}, raw.requestId);
    if (!details) {
        return undefined;
    }
    return {
        type: raw.type,
        component: raw.component,
        operation: raw.operation,
        status: raw.status,
        atEpochMs: raw.atEpochMs,
        durationMs: raw.durationMs,
        requestId: raw.requestId,
        details
    };
}

function toSafeDetails(raw, requestId) {
    if (!isRecord(raw) || !onlyKeys(raw, DETAIL_KEYS)) {
        return undefined;
    }
    const result = {};
    for (const key of ['type', 'topicId', 'contextId']) {
        if (!(key in raw)) {
            continue;
        }
        if (typeof raw[key] !== 'string' || raw[key].length > 1024) {
            return undefined;
        }
        result[`${key}Sha256`] = sha256(raw[key]);
    }
    if ('resourceId' in raw) {
        if (raw.resourceId !== requestId) {
            return undefined;
        }
        result.resourceId = raw.resourceId;
    }
    for (const key of ['attempt', 'attempts', 'nextAttempt']) {
        if (!(key in raw)) {
            continue;
        }
        if (!safeInteger(raw[key])) {
            return undefined;
        }
        result[key] = raw[key];
    }
    for (const key of ['queueAgeMs', 'dueAgeMs', 'delayMsecs', 'elapsedMsecs', 'waitMaxElapsedMsecs']) {
        if (!(key in raw)) {
            continue;
        }
        if (!boundedDuration(raw[key])) {
            return undefined;
        }
        result[key] = raw[key];
    }
    if ('queueObservation' in raw) {
        if (!QUEUE_OBSERVATIONS.includes(raw.queueObservation)) {
            return undefined;
        }
        result.queueObservation = raw.queueObservation;
    }
    if ('selectedLane' in raw) {
        if (!['NEW', 'RETRY', 'FAIRNESS', 'TIMEOUT', 'FINALIZATION'].includes(raw.selectedLane)) {
            return undefined;
        }
        result.selectedLane = raw.selectedLane;
    }
    return result;
}

function toSafeHttpEvent(raw) {
    if (
        !onlyKeys(raw, HTTP_KEYS) ||
        !['fetch-start', 'fetch-return', 'body-decoded', 'fetch-rejected'].includes(raw.stage) ||
        !safeInteger(raw.processId) || raw.processId === 0 || !safeInteger(raw.atEpochMs) ||
        !boundedDuration(raw.monotonicMs) || !boundedDuration(raw.elapsedMs)
    ) {
        return undefined;
    }
    const hasResponse = ['fetch-return', 'body-decoded'].includes(raw.stage);
    if (hasResponse ? !Number.isInteger(raw.status) || raw.status < 100 || raw.status > 599 : raw.status !== null) {
        return undefined;
    }
    return {
        type: raw.type,
        stage: raw.stage,
        requestId: raw.requestId,
        processId: raw.processId,
        atEpochMs: raw.atEpochMs,
        monotonicMs: raw.monotonicMs,
        elapsedMs: raw.elapsedMs,
        status: raw.status
    };
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function onlyKeys(value, allowed) {
    return Object.keys(value).every((key) => allowed.includes(key));
}
function safeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
}
function boundedDuration(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_200_000;
}
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function validateArtifactInput(input, workingDirectory) {
    if (!isRecord(input)) {
        return [{ field: 'input', message: 'Invalid artifact input' }];
    }
    const issues = [];
    if (typeof input.rawDirectory !== 'string') {
        issues.push({ field: 'rawDirectory', message: 'Invalid artifact directories' });
    }
    if (typeof input.safeDirectory !== 'string') {
        issues.push({ field: 'safeDirectory', message: 'Invalid artifact directories' });
    }
    if (
        typeof input.rawDirectory === 'string' && typeof input.safeDirectory === 'string' &&
        (resolve(workingDirectory, input.rawDirectory) === resolve(workingDirectory, input.safeDirectory) ||
            basename(input.safeDirectory) !== 'safe')
    ) {
        issues.push({ field: 'directories', message: 'Invalid artifact directories' });
    }
    if (!isRecord(input.limits)) {
        issues.push({ field: 'limits', message: 'Invalid artifact bound' });
    }
    else {
        for (const key of ['maxInputBytes', 'maxLineBytes', 'maxObservations', 'maxCountReports']) {
            if (!safeInteger(input.limits[key]) || input.limits[key] === 0) {
                issues.push({ field: `limits.${key}`, message: 'Invalid artifact bound' });
            }
        }
    }
    return [...issues, ...validateRuntimeCustody(input.custody)];
}

function validateRuntimeCustody(custody) {
    if (!isRecord(custody)) {
        return [{ field: 'custody', message: 'Invalid runtime custody' }];
    }
    const issues = [];
    if (
        !onlyKeys(custody, [
            'baseCommit',
            'headCommit',
            'nodeVersion',
            'denoVersion',
            'runnerOS',
            'runnerImage',
            'runnerImageVersion',
            'sourceHashes'
        ])
    ) {
        issues.push({ field: 'custody', message: 'Invalid runtime custody' });
    }
    if (custody.baseCommit !== BASE_COMMIT) {
        issues.push({ field: 'custody.baseCommit', message: 'Invalid runtime custody' });
    }
    if (typeof custody.headCommit !== 'string' || !/^[a-f0-9]{40}$/.test(custody.headCommit)) {
        issues.push({ field: 'custody.headCommit', message: 'Invalid runtime custody' });
    }
    if (
        custody.nodeVersion !== null &&
        (typeof custody.nodeVersion !== 'string' || !/^v\d+\.\d+\.\d+$/.test(custody.nodeVersion))
    ) {
        issues.push({ field: 'custody.nodeVersion', message: 'Invalid runtime custody' });
    }
    if (
        custody.denoVersion !== null &&
        (typeof custody.denoVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(custody.denoVersion))
    ) {
        issues.push({ field: 'custody.denoVersion', message: 'Invalid runtime custody' });
    }
    for (const key of ['runnerOS', 'runnerImage', 'runnerImageVersion']) {
        if (
            custody[key] !== null && (typeof custody[key] !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(custody[key]))
        ) {
            issues.push({ field: `custody.${key}`, message: 'Invalid runner custody' });
        }
    }
    return [...issues, ...validateSourceHashes(custody.sourceHashes)];
}

function validateSourceHashes(sourceHashes) {
    if (!Array.isArray(sourceHashes) || sourceHashes.length > SOURCE_PATHS.length) {
        return [{ field: 'custody.sourceHashes', message: 'Invalid source custody' }];
    }
    const issues = [];
    for (const [index, entry] of sourceHashes.entries()) {
        const field = `custody.sourceHashes[${index}]`;
        if (!isRecord(entry)) {
            issues.push({ field, message: 'Invalid source custody' });
            continue;
        }
        if (!onlyKeys(entry, ['path', 'sha256'])) {
            issues.push({ field, message: 'Invalid source custody' });
        }
        if (!SOURCE_PATHS.includes(entry.path)) {
            issues.push({ field: `${field}.path`, message: 'Invalid source custody' });
        }
        if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
            issues.push({ field: `${field}.sha256`, message: 'Invalid source custody' });
        }
    }
    return issues;
}

async function readBoundedLines(input) {
    const reader = new BoundedNativeLogLines(input);
    try {
        for await (const chunk of createReadStream(input.path, { highWaterMark: 16_384 })) {
            if (!reader.accept(chunk)) {
                return;
            }
        }
        reader.finish();
    }
    catch (error) {
        const coverage = input.projection.coverage;
        (error?.code === 'ENOENT' ? coverage.missingStreams : coverage.unreadableStreams).push(input.stream);
    }
}

class BoundedNativeLogLines {
    total = 0;
    pending = Buffer.alloc(0);
    oversized = false;
    lineOrdinal = 0;

    constructor(input) {
        this.stream = input.stream;
        this.projection = input.projection;
    }

    accept(chunk) {
        const remaining = this.projection.limits.maxInputBytes - this.total;
        const bounded = chunk.subarray(0, remaining);
        this.total += bounded.length;
        let offset = 0;
        while (offset < bounded.length) {
            const newline = bounded.indexOf(10, offset);
            const end = newline === -1 ? bounded.length : newline;
            this.acceptPart(bounded.subarray(offset, end));
            if (newline !== -1) {
                this.endLine();
            }
            offset = end + 1;
        }
        if (chunk.length > remaining) {
            this.projection.coverage.inputOverflowStreams.push(this.stream);
            return false;
        }
        return true;
    }

    acceptPart(part) {
        if (!this.oversized && this.pending.length + part.length > this.projection.limits.maxLineBytes) {
            this.oversized = true;
            this.pending = Buffer.alloc(0);
            this.projection.coverage.oversizedLines += 1;
        }
        if (!this.oversized) {
            this.pending = Buffer.concat([this.pending, part]);
        }
    }

    endLine() {
        this.lineOrdinal += 1;
        if (!this.oversized) {
            this.projection.acceptLine({
                line: this.pending.toString('utf8'),
                stream: this.stream,
                lineOrdinal: this.lineOrdinal
            });
        }
        this.pending = Buffer.alloc(0);
        this.oversized = false;
    }

    finish() {
        if (this.pending.length || this.oversized) {
            this.projection.coverage.partialFinalLines.push(this.stream);
            this.endLine();
        }
    }
}

async function readSmallFile(path) {
    try {
        if ((await stat(path)).size <= 4096) {
            return await readFile(path, 'utf8');
        }
    }
    catch { /* Missing custody remains explicit. */ }
    return null;
}

async function readExitCode(rawDirectory, coverage) {
    const raw = await readSmallFile(join(rawDirectory, 'exit-code'));
    if (raw !== null && /^(?:0|[1-9][0-9]{0,2})\s*$/.test(raw) && Number(raw) <= 255) {
        return Number(raw);
    }
    coverage.invalidExitEvidence = true;
    return null;
}

async function runArtifactCli() {
    const [rawDirectory, safeDirectory] = process.argv.slice(2);
    if (!rawDirectory || !safeDirectory || process.argv.length !== 4) {
        throw new Error('Invalid artifact arguments');
    }
    const nodeVersion = (await readSmallFile(join(rawDirectory, 'node-version')))?.trim() ?? null;
    const denoVersion = /^deno (\d+\.\d+\.\d+)/.exec((await readSmallFile(join(rawDirectory, 'deno-version'))) ?? '')
        ?.[1] ?? null;
    const sourceHashes = [];
    for (const path of SOURCE_PATHS) {
        sourceHashes.push({ path, sha256: sha256(await readFile(join(SOURCE_ROOT, path))) });
    }
    await writeSafeNativeObservationArtifacts({
        rawDirectory,
        safeDirectory,
        custody: {
            baseCommit: BASE_COMMIT,
            headCommit: process.env.GITHUB_SHA,
            nodeVersion,
            denoVersion,
            runnerOS: process.env.RUNNER_OS ?? null,
            runnerImage: process.env.ImageOS ?? null,
            runnerImageVersion: process.env.ImageVersion ?? null,
            sourceHashes
        },
        limits: { maxInputBytes: 50_000_000, maxLineBytes: 32_768, maxObservations: 10_000, maxCountReports: 100 }
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    runArtifactCli().catch((error) => {
        if (error instanceof ArtifactInputError) {
            console.error(JSON.stringify({ type: 'native.observation.input-rejected', issues: error.issues }));
        }
        else {
            console.error('Safe native observation artifact projection failed');
        }
        process.exitCode = 1;
    });
}
