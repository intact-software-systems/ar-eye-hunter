import { describe, expect, it } from 'vitest';
import type { RtcBaselineResolvedConfigurationValueDto, RtcBaselineResult } from '../../../baseline/contracts/rtc-baseline-contracts.ts';
import type { DenoRtcBaselineAdapters } from '../../../baseline/runtime/rtc-baseline-deno-adapters.ts';
import { createRtcBaselineDenoRuntime, RTC_BASELINE_DENO_ROOT_PATH } from '../../../baseline/runtime/rtc-baseline-deno-runtime.ts';
const baselineId = '20260807-0123456789ab-e2-browser';
const browserWorker = 'packages/shared-rtc-bench/workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs';
type FixtureOuter = {
    workloadId: 'RTC-B01' | 'RTC-B05';
    environmentId: 'E1-local' | 'E2-browser';
};
function captureManifest(baselineId_: string, outerAttempt: FixtureOuter) {
    return {
        schema: 'rallar.rtc-baseline.manifest.v1',
        request: {
            schema: 'rallar.rtc-baseline.capture-request.v1',
            baselineId: baselineId_,
            workloadIds: [outerAttempt.workloadId],
            environmentId: outerAttempt.environmentId,
            retainedSampleMultiplier: 1,
            repeatLink: null,
            conditionalEnvironmentDecisions: []
        },
        workloadIds: [outerAttempt.workloadId],
        cases: [],
        expectedCohorts: [],
        repeatLink: null,
        outerAttempts: [outerAttempt]
    };
}
const browserOuter = {
    workloadId: 'RTC-B05',
    caseId: 'browser-data-channel-lifecycle',
    inputKey: 'iterations-25',
    environmentId: 'E2-browser',
    intendedPhase: 'retained',
    outerOrdinal: 1,
    sampleIds: ['rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-001-001']
} as const;
const manifest = captureManifest(baselineId, browserOuter);
const b01Id = '20260807-0123456789ab-e1-local';
const b01Outer = {
    workloadId: 'RTC-B01',
    caseId: 'peer-connection-diagnostics-burst',
    inputKey: 'pairs-500',
    environmentId: 'E1-local',
    intendedPhase: 'retained',
    outerOrdinal: 1,
    sampleIds: [1, 2, 3, 4, 5].map(
        (innerOrdinal) => `rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-${innerOrdinal.toString().padStart(3, '0')}`
    )
} as const;
const b01Manifest = captureManifest(b01Id, b01Outer);
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const hostFacts = {
    os: 'darwin',
    kernel: '24.6.0',
    architecture: 'arm64',
    logicalCpuCount: 10,
    cpuModel: 'Apple M4',
    totalMemoryBytes: 1
};
const runtimeFacts = { node: '', npm: '', deno: '2.4.0', playwright: '', chromium: '' };
const timingFacts = {
    startedAtUtc: '2026-08-07T10:00:00.000Z',
    endedAtUtc: '2026-08-07T10:00:00.000Z',
    monotonicDurationMs: 0,
    monotonicSource: 'performance.now'
};
const successfulRun = { ok: true as const, value: { exitStatus: 0, stdout: '', stderr: '' } };
const runSuccessfully = async () => successfulRun;
const emptyHashes: DenoRtcBaselineAdapters['sourceConfigHashing'] = {
    read: async () => ({ ok: true, value: [] })
};
const invalidFailureKindIssue = '$.artifactKind\tunsupported-value\tExpected failure or not-run.';
const invalidFailureOutcomeIssue = '$.outcome\tunsupported-value\tExpected failed for a failure artifact.';
const sparseFailureIssue = '$.failureId\texpected-string\tExpected a string.';
function issueText(result: RtcBaselineResult<unknown>) {
    if (result.ok) {
        return '';
    }
    return result.issues.map((issue) => `${issue.path}\t${issue.code}\t${issue.message}`).join('\n');
}
function configured(
    caseId: string,
    inputKey: string,
    field: string,
    value: number,
    workloadId: 'RTC-B01' | 'RTC-B05' = 'RTC-B01'
): RtcBaselineResolvedConfigurationValueDto {
    return { caseKey: { workloadId, caseId, inputKey }, field, value, source: 'default' };
}
function runtimeAdapters(
    fileOverrides: Partial<DenoRtcBaselineAdapters['filePort']>,
    sourceConfigHashing: DenoRtcBaselineAdapters['sourceConfigHashing'] = emptyHashes
): DenoRtcBaselineAdapters {
    let writerLockBytes: Uint8Array = new Uint8Array();
    let writerLockCreated = true;
    let writerLockHeld = false;
    const filePort: DenoRtcBaselineAdapters['filePort'] = {
        inspectPath: async () => null,
        createDirectory: async () => undefined,
        writeFileCreateNew: async () => undefined,
        readFile: async () => new Uint8Array(),
        removeFile: async () => undefined,
        removeDirectory: async () => undefined,
        listDirectory: async () => [],
        async tryAcquireExclusiveFileLock() {
            if (writerLockHeld) {
                return null;
            }
            writerLockHeld = true;
            const created = writerLockCreated;
            writerLockCreated = false;
            return {
                created,
                readBytes: async () => writerLockBytes,
                writeBytes: async (bytes) => {
                    writerLockBytes = bytes;
                },
                release: async () => {
                    writerLockHeld = false;
                }
            };
        },
        ...fileOverrides
    };
    return {
        filePort,
        writerLockRuntime: {
            createOwnerToken: () => '00000000-0000-4000-8000-000000000001',
            readOwnerIdentity: () => ({ hostname: 'runner-a', processId: 123 }),
            now: () => new Date('2026-08-07T10:00:00.000Z'),
            readProcessLiveness: async () => 'dead'
        },
        git: {
            readHeadCommit: async () => ({ ok: true, value: 'a'.repeat(40) }),
            readHeadTree: async () => ({ ok: true, value: 'b'.repeat(40) }),
            readRef: async () => ({ ok: true, value: 'codex/branch' }),
            readStatus: async () => ({ ok: true, value: '' })
        },
        process: { run: runSuccessfully },
        freshWorker: { run: runSuccessfully },
        environment: { readAllowlisted: () => ({}) },
        runtimeHost: {
            read: async () => ({ deno: '2.4.0', ...hostFacts, executionContext: 'local' as const })
        },
        clock: { nowUtc: () => '2026-08-07T10:00:00.000Z', monotonicNowMs: () => 10 },
        sourceConfigHashing,
        sha256: async () => 'c'.repeat(64)
    };
}
function reconciledObservation(
    executable: string,
    arguments_: readonly string[],
    resolvedConfiguration: readonly RtcBaselineResolvedConfigurationValueDto[] = []
) {
    return {
        git: { headCommit: 'a'.repeat(40), headTree: 'b'.repeat(40), ref: 'codex/branch', clean: true },
        runtime: runtimeFacts,
        host: { ...hostFacts, executionContext: 'local' },
        timing: timingFacts,
        deviations: [],
        sourceHashes: [],
        configurationInputs: [],
        resolvedConfiguration,
        controllerInputs: [],
        workerCommand: {
            redactedArgv: { executable, arguments: arguments_ },
            projection: { fixedWorkerFlags: [], configurationFlags: [] }
        },
        allowlistedEnvironment: {}
    };
}
function persistedEnvironment(manifest_: typeof manifest, observation: unknown) {
    const { retainedSampleMultiplier: _retainedSampleMultiplier, ...request } = manifest_.request;
    return { ...request, schema: 'rallar.rtc-baseline.environment.v1', observation };
}
const entry = (name: string, kind: 'file' | 'directory') => ({ name, kind });
describe('RTC baseline Deno runtime composition', () => {
    it('declares the confined accepted-evidence root', () => {
        expect(RTC_BASELINE_DENO_ROOT_PATH).toBe('tmp/perf/rtc-baseline');
    });

    it('runs each synthetic outer with its exact catalog executable and flags', async () => {
        const workerCalls: unknown[] = [];
        const { sampleIds, environmentId: _environmentId, ...outerIdentity } = b01Outer;
        const outcomes = sampleIds.map((sampleId, index) => ({
            schema: 'rallar.rtc-baseline.sample.v1',
            identity: {
                ...outerIdentity,
                sampleId,
                innerOrdinal: index + 1
            },
            outcome: 'passed',
            evidenceClass: 'synthetic-path',
            metrics: [],
            rawEvidence: null,
            rawReferences: [],
            issues: [],
            runtimeObservation: null
        }));
        const observation = reconciledObservation(
            'deno',
            [
                'run',
                '--config=packages/shared-rtc-bench/deno.json',
                '--allow-read',
                '--allow-write',
                'packages/shared-rtc-bench/workloads/signaling/rtc-peer-connection-diagnostics-burst.ts'
            ],
            [
                configured(b01Outer.caseId, 'pairs-500', 'peers', 500),
                configured(b01Outer.caseId, 'pairs-500', 'iceCandidatesPerPeer', 5),
                configured(b01Outer.caseId, 'pairs-500', 'offerCollisionsPerPeer', 3),
                configured(b01Outer.caseId, 'pairs-500', 'innerRuns', 5),
                configured('ice-candidate-queue', 'candidates-25000', 'candidates', 25_000),
                configured('ice-candidate-queue', 'candidates-25000', 'innerRuns', 5),
                configured('peer-listener-cleanup', 'peers-10000', 'peers', 10_000),
                configured('peer-listener-cleanup', 'peers-10000', 'innerRuns', 5)
            ]
        );
        const adapters = runtimeAdapters({
            inspectPath: async () => ({ kind: 'directory' }),
            readFile: async (path: string) =>
                jsonBytes(
                    path.endsWith('/environment.json')
                        ? persistedEnvironment(b01Manifest, observation)
                        : b01Manifest
                )
        });
        adapters.freshWorker.run = async (input: unknown) => {
            workerCalls.push(input);
            return { ok: true, value: { exitStatus: 0, stdout: JSON.stringify(outcomes), stderr: '' } };
        };
        const runtime = createRtcBaselineDenoRuntime(adapters);
        const captured = await runtime.captureWorkload({ baselineId: b01Id, workloadId: 'RTC-B01' });
        expect(captured).toEqual({ ok: true, value: { acceptedSampleCount: 5 } });
        expect(workerCalls).toHaveLength(1);
        expect(workerCalls[0]).toEqual({
            executable: 'deno',
            arguments: [
                'run',
                '--config=packages/shared-rtc-bench/deno.json',
                '--allow-read',
                '--allow-write',
                'packages/shared-rtc-bench/workloads/signaling/rtc-peer-connection-diagnostics-burst.ts',
                '--capture=worker',
                `--baseline-id=${b01Id}`,
                '--workload=RTC-B01',
                '--case-id=peer-connection-diagnostics-burst',
                '--input-key=pairs-500',
                '--intended-phase=retained',
                '--outer-ordinal=1',
                '--sample-ids=rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-001,rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-002,rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-003,rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-004,rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-005',
                '--rtc-ice-candidates-per-peer=5',
                '--rtc-inner-runs=5',
                '--rtc-offer-collisions-per-peer=3',
                '--rtc-peers=500'
            ]
        });
    });
    it('wires observation through initialization and persists environment plus manifest', async () => {
        const writes: Array<{ path: string; text: string; }> = [];
        let sourceDigest = 'c';
        const adapters = runtimeAdapters(
            {
                writeFileCreateNew: async (path, bytes) => {
                    writes.push({ path, text: new TextDecoder().decode(bytes) });
                },
                readFile: async (path) => {
                    const stored = writes.findLast((write) => write.path === path);
                    if (!stored) {
                        throw new Error('not read');
                    }
                    return new TextEncoder().encode(stored.text);
                }
            },
            {
                read: async () => ({
                    ok: true,
                    value: [
                        { path: browserWorker, kind: 'source', sha256: sourceDigest.repeat(64) },
                        {
                            path: 'apps/rallar-black-box/playwright.config.ts',
                            kind: 'config',
                            sha256: 'd'.repeat(64)
                        }
                    ]
                })
            }
        );
        adapters.environment.readAllowlisted = () => ({
            DATABASE_URL: 'postgres://user:secret@db/name'
        });
        const runtime = createRtcBaselineDenoRuntime(adapters);
        const result = await runtime.initializeBaseline(manifest.request);
        expect(result).toEqual({ ok: true, value: undefined });
        expect(writes.map((write) => write.path).join('\n')).toBe(
            `tmp/perf/rtc-baseline/${baselineId}/environment.json\ntmp/perf/rtc-baseline/${baselineId}/manifest.json`
        );
        const environment = JSON.parse(writes[0]!.text);
        expect(environment.observation.resolvedConfiguration[0]).toEqual({
            caseKey: {
                workloadId: 'RTC-B05',
                caseId: 'browser-data-channel-lifecycle',
                inputKey: 'iterations-25'
            },
            field: 'iterations',
            value: 25,
            source: 'default'
        });
        expect(environment.observation.allowlistedEnvironment).toEqual({ DATABASE_URL: 'present' });
        expect(writes[0]!.text).not.toContain('postgres://user:secret');
        sourceDigest = 'e';
        const { environmentId: _environmentId, sampleIds: _sampleIds, ...locator } = browserOuter;
        const mismatch = '$.sourceHashes\treconciliation-mismatch\tRuntime observation field sourceHashes changed.';
        expect(
            issueText(
                await runtime.recordBrowser({
                    baselineId,
                    locator,
                    producerExitStatus: 0,
                    rawResultRelativePath: 'artifacts/staging/result.json'
                })
            )
        ).toBe(mismatch);
        expect(issueText(await runtime.finalize({ baselineId }))).toBe(mismatch);
    });
    it('collects persisted sample and raw records during finalization', async () => {
        const { sampleIds, environmentId: _environmentId, ...sampleIdentity } = browserOuter;
        const observation = reconciledObservation(
            'node',
            [browserWorker],
            [configured('browser-data-channel-lifecycle', 'iterations-25', 'iterations', 25, 'RTC-B05')]
        );
        const identity = { sampleId: sampleIds[0]!, ...sampleIdentity, innerOrdinal: 1 };
        const rawReference = { relativePath: 'artifacts/raw.json', sha256: 'c'.repeat(64), bytes: 17 };
        const failureArtifact = {
            artifactKind: 'failure',
            failureId: `failure-sample-${sampleIds[0]!}`,
            identity,
            outcome: 'failed',
            causalFailureId: null,
            issues: [{ path: '$', code: 'producer-failed', message: 'failed' }],
            rawEvidence: null
        };
        const failureName = `${failureArtifact.failureId}-${identity.sampleId}.json`;
        const failurePath = `results/failures/${failureName}`;
        const files = new Map<string, unknown>([
            ['environment.json', persistedEnvironment(manifest, observation)],
            ['manifest.json', manifest],
            ['artifacts/raw.json', { durationMs: 10 }],
            ['artifacts/staging/producer.json', { unaccepted: true }],
            [
                'results/samples/sample.json',
                {
                    schema: 'rallar.rtc-baseline.sample.v1',
                    identity,
                    outcome: 'passed',
                    evidenceClass: 'native-browser',
                    metrics: [{ metric: 'durationMs', unit: 'ms', value: 10 }],
                    rawEvidence: null,
                    rawReferences: [rawReference],
                    issues: [],
                    runtimeObservation: observation
                }
            ],
            [failurePath, failureArtifact]
        ]);
        const reads: string[] = [];
        const stored = new Map<string, Uint8Array>();
        let exposeUnknownResult = true;
        let useFailureOutcome = false;
        const runtime = createRtcBaselineDenoRuntime(
            runtimeAdapters({
                inspectPath: async () => ({ kind: 'directory' }),
                readFile: async (path: string) => {
                    reads.push(path);
                    const bytes = stored.get(path);
                    if (bytes) {
                        return bytes;
                    }
                    return jsonBytes(files.get(path.split(`${baselineId}/`)[1]!));
                },
                writeFileCreateNew: async (path, bytes) => void stored.set(path, bytes),
                listDirectory: async (path) => {
                    if (path.endsWith('/artifacts') && useFailureOutcome) {
                        return [];
                    }
                    if (path.endsWith('/artifacts')) {
                        return [
                            { name: 'raw.json', kind: 'file' },
                            { name: 'staging', kind: 'directory' }
                        ];
                    }
                    if (path.endsWith('/artifacts/staging')) {
                        return [{ name: 'producer.json', kind: 'file' }];
                    }
                    if (path.endsWith('/results')) {
                        return exposeUnknownResult
                            ? [entry('samples', 'directory'), entry('unknown.json', 'file')]
                            : [entry(useFailureOutcome ? 'failures' : 'samples', 'directory')];
                    }
                    return [{ name: useFailureOutcome ? failureName : 'sample.json', kind: 'file' }];
                }
            })
        );
        const unsupported = '$.results/unknown.json\tunsupported-artifact-path\tResult artifact path is not recognized by the RTC baseline protocol.';
        expect(issueText(await runtime.finalize({ baselineId }))).toBe(unsupported);
        expect([...stored.keys()].join('\n')).toContain('/results/finalization-failures/');
        exposeUnknownResult = false;
        expect(issueText(await runtime.finalize({ baselineId }))).toBe('');
        expect(reads).toContain(`tmp/perf/rtc-baseline/${baselineId}/artifacts/raw.json`);
        expect(issueText(await runtime.readBaselineValidation({ baselineId }))).toBe('');
        exposeUnknownResult = true;
        expect(issueText(await runtime.readBaselineValidation({ baselineId }))).toBe(unsupported);
        exposeUnknownResult = false;
        const repeatRequest = {
            ...manifest.request,
            baselineId: `${baselineId}-repeat-01`,
            retainedSampleMultiplier: 2,
            repeatOf: baselineId
        };
        expect(issueText(await runtime.initializeBaseline(repeatRequest))).toBe(
            '$.workloadIds\trepeat-workload-order\tRepeat workloads must preserve primary subset order.'
        );
        stored.clear();
        useFailureOutcome = true;
        const invalidFailures = [
            [{ artifactKind: 'failure' }, sparseFailureIssue],
            [{ ...failureArtifact, artifactKind: 'sample' }, invalidFailureKindIssue],
            [{ ...failureArtifact, outcome: 'passed' }, invalidFailureOutcomeIssue]
        ] as const;
        for (const [artifact, expected] of invalidFailures) {
            files.set(failurePath, artifact);
            expect(issueText(await runtime.finalize({ baselineId }))).toContain(expected);
        }
        files.set(failurePath, failureArtifact);
        expect((await runtime.finalize({ baselineId })).ok).toBe(true);
        expect(issueText(await runtime.readBaselineValidation({ baselineId }))).toBe(
            '$.summary\tnon-passing-finalized-outcome\tEvery finalized outcome must pass.'
        );
    });
});
