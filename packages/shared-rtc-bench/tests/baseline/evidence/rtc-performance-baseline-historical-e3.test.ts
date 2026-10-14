import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';

import { createRtcBaselineFinalizedArtifactVerifier } from '../../../baseline/evidence/rtc-baseline-finalized-verification.ts';

const baselineId = '20260829T081500417Z-0123456789ab-e3-memory-local';
const historicalObservation = {
    git: { headCommit: 'a'.repeat(40), headTree: 'b'.repeat(40), ref: 'codex/historical-e3', clean: true },
    runtime: { node: '24', npm: '11', deno: '2', playwright: '1', chromium: '139' },
    host: { os: 'darwin', kernel: '24', architecture: 'arm64', logicalCpuCount: 10, cpuModel: 'fixture', totalMemoryBytes: 1, executionContext: 'local' },
    timing: {
        startedAtUtc: '2026-08-29T08:00:00.000Z',
        endedAtUtc: '2026-08-29T08:10:00.000Z',
        monotonicDurationMs: 600000,
        monotonicSource: 'performance.now'
    },
    deviations: [],
    sourceHashes: [],
    configurationInputs: [],
    resolvedConfiguration: [],
    controllerInputs: [],
    allowlistedEnvironment: {},
    workerCommand: {
        redactedArgv: { executable: 'npm', arguments: ['run', 'test:rallar:full-stack:memory:live-rtc-3'] },
        projection: { fixedWorkerFlags: [], configurationFlags: [] }
    }
};
const identity = {
    sampleId: 'rtc-b06-default-e3-memory-default-retained-001-001',
    workloadId: 'RTC-B06',
    caseId: 'default',
    inputKey: 'e3-memory-default',
    intendedPhase: 'retained',
    outerOrdinal: 1,
    innerOrdinal: 1
};
const issue = { path: '$.producer', code: 'producer-failed', message: 'Historical producer failed.' };
const historicalEnvironment = {
    schema: 'rallar.rtc-baseline.environment.v1',
    baselineId,
    workloadIds: ['RTC-B06'],
    environmentId: 'E3-memory',
    repeatLink: null,
    conditionalEnvironmentDecisions: [],
    observation: historicalObservation
};
const historicalManifest = {
    schema: 'rallar.rtc-baseline.manifest.v1',
    request: {
        schema: 'rallar.rtc-baseline.capture-request.v1',
        baselineId,
        workloadIds: ['RTC-B06'],
        environmentId: 'E3-memory',
        retainedSampleMultiplier: 1,
        repeatLink: null,
        conditionalEnvironmentDecisions: []
    },
    workloadIds: ['RTC-B06'],
    cases: [{ workloadId: 'RTC-B06', caseId: 'default', inputKey: 'e3-memory-default' }],
    outerAttempts: [{
        workloadId: 'RTC-B06',
        caseId: 'default',
        inputKey: 'e3-memory-default',
        environmentId: 'E3-memory',
        intendedPhase: 'retained',
        outerOrdinal: 1,
        sampleIds: [identity.sampleId]
    }],
    expectedCohorts: [],
    repeatLink: null
};
const historicalSample = {
    schema: 'rallar.rtc-baseline.sample.v1',
    identity,
    outcome: 'failed',
    evidenceClass: 'local-full-stack',
    metrics: [],
    rawEvidence: null,
    rawReferences: [],
    issues: [issue],
    runtimeObservation: historicalObservation
};
const historicalSummary = {
    schema: 'rallar.rtc-baseline.summary.v1',
    baselineId,
    workloadIds: ['RTC-B06'],
    environmentId: 'E3-memory',
    repeatLink: null,
    conditionalEnvironmentDecisions: [],
    sampleOutcomes: [{ identity, outcome: 'failed', issues: [issue] }],
    cohortOutcomes: [],
    metricSummaries: [],
    rawReferences: []
};

it('reads a literal historical absent-mode E3 artifact without inventing mode or accepting its failed outcome', async () => {
    const files = new Map([
        ['environment.json', JSON.stringify(historicalEnvironment)],
        ['manifest.json', JSON.stringify(historicalManifest)],
        ['results/samples/sample.json', JSON.stringify(historicalSample)],
        ['summary.json', JSON.stringify(historicalSummary)]
    ]);
    const checksum =
        [...files].sort(([left], [right]) => left.localeCompare(right)).map(([path, bytes]) => `${createHash('sha256').update(bytes).digest('hex')}  ${path}`)
            .join('\n') + '\n';
    files.set('SHA256SUMS', checksum);
    const verifier = createRtcBaselineFinalizedArtifactVerifier({
        readJson: async () => ({ ok: true, value: {} }),
        readBytes: async (_id, path) => ({ ok: true, value: new TextEncoder().encode(files.get(path)!) }),
        listArtifactPaths: async () => ({ ok: true, value: [...files.keys()].filter((path) => path !== 'SHA256SUMS') }),
        sha256: async (bytes) => createHash('sha256').update(bytes).digest('hex')
    });
    const structural = await verifier.readStructurallyVerifiedArtifacts(baselineId);
    expect(structural.ok ? structural.value.environment.observation : structural).toEqual(historicalObservation);
    expect(await verifier.readVerifiedArtifacts(baselineId)).toMatchObject({ ok: false, issues: [{ code: 'non-passing-finalized-outcome' }] });
    expect(files.get('environment.json')).toBe(JSON.stringify(historicalEnvironment));
});
