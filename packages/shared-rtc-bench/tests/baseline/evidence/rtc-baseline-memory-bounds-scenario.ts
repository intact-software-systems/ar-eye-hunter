import type {
    RtcBaselineCaptureManifestDto,
    RtcBaselineEnvironmentDto,
    RtcBaselineJson,
    RtcBaselineResult,
    RtcBaselineRuntimeObservationDto,
    RtcBaselineSampleDto
} from '../../../baseline/contracts/rtc-baseline-contracts.ts';
import type { RtcBaselineStoredFile } from '../../../baseline/evidence/rtc-baseline-artifact-files.ts';
import type { RtcBaselineFileStore } from '../../../baseline/evidence/rtc-baseline-evidence-store.ts';
import {
    createDenoRtcBaselineAdapters,
    type RtcBaselineDenoPort
} from '../../../baseline/runtime/rtc-baseline-deno-adapters.ts';
import type { RtcBaselineDenoEvidence } from '../../../baseline/runtime/rtc-baseline-deno-evidence.ts';
import { createRtcBaselineDenoFinalization } from '../../../baseline/runtime/rtc-baseline-deno-finalization.ts';

interface MemoryPeak {
    readonly heapUsed: number;
    readonly rss: number;
}

interface MemoryMeasurement {
    readonly durationMs: number;
    readonly peak: MemoryPeak;
}

interface MemoryBoundsScenarioResult {
    readonly sampleCount: number;
    readonly sourcePayloadBytes: number;
    readonly finalization: MemoryMeasurement;
    readonly validation: MemoryMeasurement;
}

interface ScenarioConfig {
    readonly sampleCount: number;
    readonly samplePayloadBytes: number;
}

interface MemorySampler {
    getPeak(): MemoryPeak;
    reset(): void;
    sample(): void;
}

const baselineId = '20260818-22bb4919c92f-e1-local';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function readPositiveIntegerArgument(name: string): number {
    const prefix = `--${name}=`;
    const raw = Deno.args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`Expected --${name}=<positive-safe-integer>.`);
    }
    return value;
}

function createMemorySampler(): MemorySampler {
    let peak: MemoryPeak = { heapUsed: 0, rss: 0 };
    function sample() {
        const current = Deno.memoryUsage();
        peak = {
            heapUsed: Math.max(peak.heapUsed, current.heapUsed),
            rss: Math.max(peak.rss, current.rss)
        };
    }
    return {
        getPeak: () => peak,
        reset() {
            peak = { heapUsed: 0, rss: 0 };
            sample();
        },
        sample
    };
}

function collectGarbage() {
    const garbageCollect = Reflect.get(globalThis, 'gc');
    if (typeof garbageCollect === 'function') {
        garbageCollect();
    }
}

function createRuntimeObservation(): RtcBaselineRuntimeObservationDto {
    return {
        git: {
            headCommit: 'a'.repeat(40),
            headTree: 'b'.repeat(40),
            ref: 'codex/rtc-memory-bounds',
            clean: true
        },
        runtime: { node: '26', npm: '11', deno: '2.9.5', playwright: '1', chromium: '139' },
        host: {
            os: 'darwin',
            kernel: '25.0.0',
            architecture: 'arm64',
            logicalCpuCount: 12,
            cpuModel: 'generated-corpus',
            totalMemoryBytes: 96 * 1024 * 1024 * 1024,
            executionContext: 'local'
        },
        timing: {
            startedAtUtc: '2026-08-18T10:00:00.000Z',
            endedAtUtc: '2026-08-18T10:00:01.000Z',
            monotonicDurationMs: 1_000,
            monotonicSource: 'performance.now'
        },
        deviations: [],
        sourceHashes: [],
        configurationInputs: [],
        resolvedConfiguration: [],
        controllerInputs: [],
        workerCommand: {
            redactedArgv: { executable: 'deno', arguments: [] },
            projection: { fixedWorkerFlags: [], configurationFlags: [] }
        },
        allowlistedEnvironment: {}
    };
}

function sampleId(innerOrdinal: number) {
    return `rtc-b01-scale-payload-retained-001-${String(innerOrdinal).padStart(3, '0')}`;
}

function createManifest(sampleCount: number): RtcBaselineCaptureManifestDto {
    const sampleIds = Array.from({ length: sampleCount }, (_, index) => sampleId(index + 1));
    const request = {
        schema: 'rallar.rtc-baseline.capture-request.v1' as const,
        baselineId,
        workloadIds: ['RTC-B01' as const],
        environmentId: 'E1-local' as const,
        retainedSampleMultiplier: 1 as const,
        repeatLink: null,
        conditionalEnvironmentDecisions: []
    };
    return {
        schema: 'rallar.rtc-baseline.manifest.v1',
        request,
        workloadIds: request.workloadIds,
        cases: [{ workloadId: 'RTC-B01', caseId: 'scale', inputKey: 'payload' }],
        outerAttempts: [
            {
                workloadId: 'RTC-B01',
                caseId: 'scale',
                inputKey: 'payload',
                environmentId: 'E1-local',
                intendedPhase: 'retained',
                outerOrdinal: 1,
                sampleIds
            }
        ],
        expectedCohorts: [],
        repeatLink: null
    };
}

function createEnvironment(
    observation: RtcBaselineRuntimeObservationDto
): RtcBaselineEnvironmentDto {
    return {
        schema: 'rallar.rtc-baseline.environment.v1',
        baselineId,
        workloadIds: ['RTC-B01'],
        environmentId: 'E1-local',
        repeatLink: null,
        conditionalEnvironmentDecisions: [],
        observation
    };
}

function createSample(
    innerOrdinal: number,
    samplePayloadBytes: number,
    observation: RtcBaselineRuntimeObservationDto
): RtcBaselineSampleDto {
    const payloadPrefix = `${innerOrdinal}:`;
    const rawEvidence = payloadPrefix + 'x'.repeat(samplePayloadBytes - payloadPrefix.length);
    return {
        schema: 'rallar.rtc-baseline.sample.v1',
        identity: {
            sampleId: sampleId(innerOrdinal),
            workloadId: 'RTC-B01',
            caseId: 'scale',
            inputKey: 'payload',
            intendedPhase: 'retained',
            outerOrdinal: 1,
            innerOrdinal
        },
        outcome: 'passed',
        evidenceClass: 'synthetic-path',
        metrics: [{ metric: 'durationMs', unit: 'ms', value: innerOrdinal }],
        rawEvidence,
        rawReferences: [],
        issues: [],
        runtimeObservation: observation
    };
}

function sampleOrdinal(relativePath: string): number | null {
    const match = /^results\/samples\/sample-(\d+)\.json$/.exec(relativePath);
    return match ? Number(match[1]) : null;
}

function successful<T>(value: T): RtcBaselineResult<T> {
    return { ok: true, value };
}

function failed(path: string): RtcBaselineResult<never> {
    return {
        ok: false,
        issues: [{ path: `$.${path}`, code: 'missing-generated-artifact', message: 'Missing.' }]
    };
}

function createGeneratedEvidence(
    config: ScenarioConfig,
    sampler: MemorySampler,
    sha256: (bytes: Uint8Array) => Promise<string>
): RtcBaselineDenoEvidence {
    const observation = createRuntimeObservation();
    const environment = createEnvironment(observation);
    const manifest = createManifest(config.sampleCount);
    const resultFiles: RtcBaselineStoredFile[] = Array.from(
        { length: config.sampleCount },
        (_, index) => ({ relativePath: `results/samples/sample-${index + 1}.json`, kind: 'file' })
    );
    const publishedBytes = new Map<string, Uint8Array>();

    function generatedBytes(relativePath: string): Uint8Array | null {
        if (relativePath === 'environment.json') {
            return encoder.encode(JSON.stringify(environment));
        }
        if (relativePath === 'manifest.json') {
            return encoder.encode(JSON.stringify(manifest));
        }
        const ordinal = sampleOrdinal(relativePath);
        return ordinal === null
            ? (publishedBytes.get(relativePath) ?? null)
            : encoder.encode(
                JSON.stringify(createSample(ordinal, config.samplePayloadBytes, observation))
            );
    }

    async function readBytes(_baselineId: string, relativePath: string) {
        sampler.sample();
        const bytes = generatedBytes(relativePath);
        sampler.sample();
        return bytes === null ? failed(relativePath) : successful(bytes);
    }

    async function readJson(_baselineId: string, relativePath: string) {
        const bytes = await readBytes(baselineId, relativePath);
        if (!bytes.ok) {
            return bytes;
        }
        const json: RtcBaselineJson = JSON.parse(decoder.decode(bytes.value));
        sampler.sample();
        return successful(json);
    }

    async function writeJsonCreateNew(
        _baselineId: string,
        relativePath: string,
        value: RtcBaselineJson | object
    ) {
        publishedBytes.set(relativePath, encoder.encode(`${JSON.stringify(value)}\n`));
        return successful(undefined);
    }

    const store: RtcBaselineFileStore = {
        initializeBaseline: async () => successful(undefined),
        writeJsonCreateNew,
        readBytes,
        readJson,
        async listArtifacts(_baselineId, relativePath) {
            if (relativePath === 'results') {
                return successful(resultFiles);
            }
            if (relativePath === 'artifacts') {
                return successful([]);
            }
            return failed(relativePath);
        },
        async withFinalizationLock(_baselineId, operation) {
            return operation({
                writeJsonCreateNew,
                async publishSummary(_publishedBaselineId, summaryBytes, checksumBytes) {
                    publishedBytes.set('summary.json', summaryBytes);
                    publishedBytes.set('SHA256SUMS', checksumBytes);
                    return successful(undefined);
                }
            });
        }
    };

    return {
        store,
        readManifest: async () => successful(manifest),
        readEnvironment: async () => successful(environment),
        reconcileAcceptedOperation: async () => []
    };
}

function createUnusedDenoPort(): RtcBaselineDenoPort {
    const unused = async (): Promise<never> => {
        throw new Error('The generated evidence scenario does not use the Deno file/process port.');
    };
    return {
        envGet: () => undefined,
        build: Deno.build,
        version: Deno.version,
        pid: Deno.pid,
        hostname: () => Deno.hostname(),
        randomUuid: () => crypto.randomUUID(),
        kill: () => undefined,
        lstat: unused,
        open: unused,
        mkdir: unused,
        readFile: unused,
        writeFile: unused,
        remove: unused,
        async *readDir(): AsyncIterable<never> {
            throw new Error('The generated evidence scenario does not enumerate the Deno file port.');
        },
        command: unused,
        now: () => new Date('2026-08-18T10:00:00.000Z'),
        performanceNow: () => performance.now(),
        systemMemoryInfo: () => ({ total: 96 * 1024 * 1024 * 1024 }),
        availableParallelism: () => 12
    };
}

async function runScenario(config: ScenarioConfig): Promise<MemoryBoundsScenarioResult> {
    const sampler = createMemorySampler();
    const adapterSha256 = createDenoRtcBaselineAdapters(createUnusedDenoPort()).sha256;
    const sha256 = async (bytes: Uint8Array) => {
        sampler.sample();
        const digest = await adapterSha256(bytes);
        sampler.sample();
        return digest;
    };
    const evidence = createGeneratedEvidence(config, sampler, sha256);
    const { finalizedEvidence, finalizedReader } = createRtcBaselineDenoFinalization(
        evidence,
        sha256
    );

    sampler.reset();
    const finalizationStartedAt = performance.now();
    const finalized = await finalizedEvidence.finalize({ baselineId });
    const finalizationDurationMs = performance.now() - finalizationStartedAt;
    if (!finalized.ok) {
        throw new Error(JSON.stringify(finalized.issues));
    }
    const finalizationPeak = sampler.getPeak();

    collectGarbage();
    sampler.reset();
    const validationStartedAt = performance.now();
    const validated = await finalizedReader.readBaselineValidation({ baselineId });
    const validationDurationMs = performance.now() - validationStartedAt;
    if (!validated.ok) {
        throw new Error(JSON.stringify(validated.issues));
    }

    return {
        sampleCount: config.sampleCount,
        sourcePayloadBytes: config.sampleCount * config.samplePayloadBytes,
        finalization: { durationMs: finalizationDurationMs, peak: finalizationPeak },
        validation: { durationMs: validationDurationMs, peak: sampler.getPeak() }
    };
}

if (import.meta.main) {
    const result = await runScenario({
        sampleCount: readPositiveIntegerArgument('samples'),
        samplePayloadBytes: readPositiveIntegerArgument('payload-bytes')
    });
    console.log(JSON.stringify(result));
}
