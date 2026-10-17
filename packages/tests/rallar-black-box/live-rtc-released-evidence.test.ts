import { unzipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { toAgentReloadResult } from '@shared-test/rallar-bb-test/alm/browser-control-agent-resume.ts';
import type { RallarBlackBoxTestResult } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { computeResultCaptureReceipts } from '@shared-test/rallar-bb-test/result-release/result-release-protocol.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { controlEventArtifactJsonl, toControlResultArtifactLines } from '../../../apps/rallar-black-box-control-server/src/control-artifacts.ts';
import { writeLiveRtcPerformanceEvidence } from '../../../tests/playwright/rallar-black-box/write-live-rtc-performance-evidence.ts';
import { validateRtcB06ReleaseEvidence } from '../../shared-rtc-bench/baseline/acceptance/validate-rtc-b06-release-evidence.ts';
import type {
    RtcBaselineExternalAttemptDto,
    RtcBaselineRuntimeObservationDto,
    RtcBaselineSampleDto
} from '../../shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';
import { resolveRtcB06DiagnosticSelection } from '../../shared-rtc-bench/baseline/observation/read-rtc-b06-diagnostic-selection.ts';
import {
    createRtcPerformanceObservationArchive,
    verifyRtcPerformanceObservationArchive
} from '../../shared-rtc-bench/baseline/observation/rtc-performance-observation-archive.ts';
import { createRtcBaselineRuntimeObservationInput } from '../../shared-rtc-bench/baseline/runtime/create-rtc-baseline-runtime-observation-input.ts';

const baselineId = '20260829T081500Z-aaaaaaaaaaaa-e3-memory-gh123456789-a1';
const runId = 'retention-recovery';
const agentId = 'agent';
const caseKey = { workloadId: 'RTC-B06', caseId: 'retention-100', inputKey: 'e3-memory-retention-100' } as const;
const sampleId = 'rtc-b06-retention-100-e3-memory-retention-100-retained-001-001';
afterEach(() => vi.unstubAllEnvs());

async function releasedFixture(failed: boolean) {
    const repoRoot = await realpath(await mkdtemp(join(tmpdir(), 'rtc-release-recovery-')));
    onTestFinished(() => rm(repoRoot, { recursive: true, force: true }));
    const storage = join(repoRoot, 'tmp/perf/rtc-b06-recorder', baselineId, 'retention-100/retained-1/runs', runId);
    await mkdir(storage, { recursive: true });
    const runtime = createDefaultRallarBlackBoxTestRuntime();
    const fullResult = await runtime.execute({ kind: 'loop', commandId: 'root', count: 2, commands: [{ kind: 'health', commandId: 'child' }] }, {
        runId,
        agentId
    });
    const receipts = await computeResultCaptureReceipts(JSON.parse(JSON.stringify(fullResult)), { runId, agentId });
    const requestId = 'retention-release-1-root';
    const outcome = await runtime.releaseResults({ runId, agentId, requestId, receipts });
    expect(outcome.status).toBe('released');
    expect(runtime.state().resultCache).toEqual({});
    const files = {
        'results.jsonl': toRecordedResult(fullResult),
        'result-receipts.jsonl': receipts.map((receipt) => JSON.stringify(receipt)).join('\n') + '\n',
        'events.jsonl': controlEventArtifactJsonl({
            kind: 'diagnostic',
            protocolVersion: 1,
            runId,
            agentId,
            atEpochMs: 1,
            payload: { topic: 'rallar.bb.results.release', ...outcome }
        })
    };
    for (const [name, bytes] of Object.entries(files)) {
        await writeFile(join(storage, name), bytes);
    }
    const evidence = createReleaseAttempt(failed);
    return { repoRoot, storage, files, evidence };
}

function createReleaseAttempt(failed: boolean): RtcBaselineExternalAttemptDto {
    const observation = createReleaseObservation();
    const identity = { ...caseKey, sampleId, intendedPhase: 'retained' as const, outerOrdinal: 1, innerOrdinal: 1 };
    const evidence: RtcBaselineExternalAttemptDto = {
        schema: 'rallar.rtc-baseline.external-attempt.v1',
        locator: {
            ...caseKey,
            intendedPhase: 'retained',
            outerOrdinal: 1,
            environmentId: 'E3-memory',
            rawResultRelativePath: 'artifacts/staging/recovery.json'
        },
        producerExitStatus: failed ? 1 : 0,
        producerFacts: {
            databaseUrl: 'absent',
            allScenariosRaw: null,
            retentionSoakRaw: '1',
            retentionCyclesRaw: '100',
            iceModeRaw: null,
            allScenariosPresent: false,
            retentionSoakPresent: true,
            retentionCyclesPresent: true,
            iceModePresent: false
        },
        samples: [{
            schema: 'rallar.rtc-baseline.sample.v1',
            identity,
            outcome: failed ? 'failed' : 'passed',
            evidenceClass: 'local-full-stack',
            metrics: failed ? [] : [{ metric: 'fixture-duration', unit: 'milliseconds', value: 1 }],
            rawEvidence: {},
            rawReferences: [],
            issues: [],
            runtimeObservation: observation
        }],
        sampleOutcomes: [{ identity, outcome: failed ? 'failed' : 'passed', issues: [] }],
        issues: []
    };
    return evidence;
}

function createReleaseObservation(): RtcBaselineRuntimeObservationDto {
    const initialized = createRtcBaselineRuntimeObservationInput({
        schema: 'rallar.rtc-baseline.capture-request.v1',
        baselineId,
        workloadIds: ['RTC-B06'],
        environmentId: 'E3-memory',
        retainedSampleMultiplier: 1,
        repeatLink: null,
        conditionalEnvironmentDecisions: []
    }, {
        RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: '1',
        RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
        RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100',
        RALLAR_RTC_RELEASE_RESULTS_AFTER_CAPTURE: 'true'
    });
    if (!initialized.ok) {
        throw new Error(JSON.stringify(initialized.issues));
    }
    const { sourcePaths: _sourcePaths, ...configuration } = initialized.value.observation;
    return {
        git: { headCommit: 'a'.repeat(40), headTree: 'b'.repeat(40), ref: 'main', clean: true },
        runtime: { node: '24', npm: '11', deno: '2', playwright: '1', chromium: '1' },
        host: {
            os: 'test',
            kernel: 'test',
            architecture: 'test',
            logicalCpuCount: 1,
            cpuModel: 'test',
            totalMemoryBytes: 1,
            executionContext: 'local' as const
        },
        timing: { startedAtUtc: '2026-08-29T08:00:00.000Z', endedAtUtc: '2026-08-29T08:10:00.000Z', monotonicDurationMs: 600000, monotonicSource: 'test' },
        sourceHashes: [],
        ...configuration,
        resolvedConfiguration: initialized.value.observation.resolvedConfiguration.filter((entry) => entry.field !== 'appServingMode').map((entry) =>
            entry.field === 'eventHistoryMode'
                ? { ...entry, value: 'full' }
                : entry.field === 'eventHistoryMaxEvents'
                ? { ...entry, value: 0 }
                : entry
        )
    };
}

it.each([false, true])('recovers complete root/child results, receipts and acknowledgement after release; failed acquisition=%s', async (failed) => {
    const fixture = await releasedFixture(failed);
    vi.stubEnv('RALLAR_RTC_RELEASE_RESULTS_AFTER_CAPTURE', 'true');
    const path = await writeLiveRtcPerformanceEvidence({ ...fixture, baselineId, runId, relativePath: fixture.evidence.locator.rawResultRelativePath });
    const sample = JSON.parse(await readFile(path, 'utf8')).samples[0];
    expect(sample.rawEvidence.resultRelease).toMatchObject({ raw: 'true', enabled: true, status: 'verified', runId, releasedRoots: 1 });
    expect(sample.outcome).toBe(failed ? 'failed' : 'passed');
    expect(sample.rawReferences).toHaveLength(3);
    const selected = resolveRtcB06DiagnosticSelection(sample.runtimeObservation.resolvedConfiguration, sample.identity);
    if (!selected.ok) {
        throw new Error('Expected complete initialized selection.');
    }
    expect(validateRtcB06ReleaseEvidence(sample, selected.value)).toEqual([]);
    for (const failure of ['missing', 'raw-mismatch', 'unverified', 'missing-source', 'duplicate-reference']) {
        const invalid = structuredClone(sample);
        if (failure === 'missing') {
            delete invalid.rawEvidence.resultRelease;
        }
        if (failure === 'raw-mismatch') {
            invalid.rawEvidence.resultRelease.raw = 'false';
        }
        if (failure === 'unverified') {
            invalid.rawEvidence.resultRelease.status = 'failed';
        }
        if (failure === 'missing-source') {
            invalid.rawEvidence.resultRelease.sources.pop();
        }
        if (failure === 'duplicate-reference') {
            invalid.rawReferences.push(invalid.rawReferences[0]);
        }
        expect(validateRtcB06ReleaseEvidence(invalid, selected.value)).toMatchObject([{ code: 'result-release-unverified' }]);
    }
    const archive = await archiveReleasedSample(fixture.repoRoot, sample);
    for (const reference of sample.rawReferences) {
        const name = reference.relativePath.split('/').at(-1).slice(sampleId.length + 1);
        const original = Object.entries(fixture.files).find(([fileName]) => fileName === name)?.[1];
        if (original === undefined) {
            throw new Error('Unexpected recovery file.');
        }
        const bytes = await readFile(join(fixture.repoRoot, 'tmp/perf/rtc-baseline', baselineId, reference.relativePath));
        expect(bytes.toString()).toBe(original);
        expect(Buffer.from(archive[`primary/${baselineId}/${reference.relativePath}`])).toEqual(bytes);
        expect(reference).toMatchObject({ bytes: Buffer.byteLength(original), sha256: createHash('sha256').update(original).digest('hex') });
    }
});

it.each([
    'missing-ack',
    'wrong-agent',
    'corrupt-result',
    'corrupt-receipt',
    'truncated',
    'ambient-mismatch',
    'extra-receipt',
    'extra-result',
    'extra-ack',
    'foreign-run',
    'foreign-result-run',
    'ack-missing-kind',
    'ack-missing-status',
    'malformed-reload'
])(
    'refuses %s release proof while preserving original owned bytes',
    async (failure) => {
        const fixture = await releasedFixture(false);
        vi.stubEnv('RALLAR_RTC_RELEASE_RESULTS_AFTER_CAPTURE', failure === 'ambient-mismatch' ? 'false' : 'true');
        if (failure === 'missing-ack' || failure === 'wrong-agent') {
            await writeFile(
                join(fixture.storage, 'events.jsonl'),
                failure === 'missing-ack' ? '{}' : fixture.files['events.jsonl'].replace('"agent"', '"foreign"')
            );
        }
        if (failure === 'corrupt-result') {
            await writeFile(join(fixture.storage, 'results.jsonl'), fixture.files['results.jsonl'].replace('"ok":true', '"ok":false'));
        }
        if (failure === 'corrupt-receipt') {
            await writeFile(
                join(fixture.storage, 'result-receipts.jsonl'),
                fixture.files['result-receipts.jsonl'].replace(/"digest":"[^"]+"/, '"digest":"wrong"')
            );
        }
        if (failure === 'extra-receipt') {
            const row = JSON.parse(fixture.files['result-receipts.jsonl'].split('\n')[0]);
            row.capture.ordinal += 100;
            await writeFile(join(fixture.storage, 'result-receipts.jsonl'), fixture.files['result-receipts.jsonl'] + JSON.stringify(row) + '\n');
        }
        if (failure === 'extra-result') {
            await writeFile(
                join(fixture.storage, 'results.jsonl'),
                fixture.files['results.jsonl'] + JSON.stringify({ agentId, commandId: 'foreign', action: 'health' }) + '\n'
            );
        }
        if (failure === 'extra-ack' || failure === 'foreign-run') {
            const row = JSON.parse(fixture.files['events.jsonl']);
            if (failure === 'extra-ack') {
                row.value.requestId = 'retention-release-99-foreign';
            }
            else {
                row.runId = 'foreign';
            }
            await writeFile(
                join(fixture.storage, 'events.jsonl'),
                failure === 'extra-ack' ? fixture.files['events.jsonl'] + JSON.stringify(row) + '\n' : JSON.stringify(row) + '\n'
            );
        }
        if (failure === 'foreign-result-run') {
            const row = JSON.parse(fixture.files['results.jsonl']);
            row.runId = 'foreign-run';
            await writeFile(join(fixture.storage, 'results.jsonl'), JSON.stringify(row) + '\n');
        }
        if (failure === 'ack-missing-kind' || failure === 'ack-missing-status') {
            const row = JSON.parse(fixture.files['events.jsonl']);
            delete row[failure === 'ack-missing-kind' ? 'kind' : 'status'];
            await writeFile(join(fixture.storage, 'events.jsonl'), JSON.stringify(row) + '\n');
        }
        if (failure === 'malformed-reload') {
            await writeFile(join(fixture.storage, 'results.jsonl'), fixture.files['results.jsonl'] + JSON.stringify({ action: 'agent.reload' }) + '\n');
        }
        if (failure === 'truncated') {
            await writeFile(join(fixture.storage, 'results.jsonl'), fixture.files['results.jsonl'].slice(0, -20));
        }
        const path = await writeLiveRtcPerformanceEvidence({ ...fixture, baselineId, runId, relativePath: fixture.evidence.locator.rawResultRelativePath });
        const sample = JSON.parse(await readFile(path, 'utf8')).samples[0];
        expect(sample.outcome).toBe('failed');
        expect(sample.rawEvidence.resultRelease.status).toBe('failed');
        expect(sample.rawReferences).toHaveLength(3);
        for (const reference of sample.rawReferences) {
            const name = reference.relativePath.split('/').at(-1).slice(sampleId.length + 1);
            expect(await readFile(join(fixture.repoRoot, 'tmp/perf/rtc-baseline', baselineId, reference.relativePath)))
                .toEqual(await readFile(join(fixture.storage, name)));
        }
    }
);

async function archiveReleasedSample(repoRoot: string, sample: RtcBaselineSampleDto): Promise<Record<string, Uint8Array>> {
    const observation = sample.runtimeObservation!;
    const files = createReleaseArchiveFixture(sample);
    const encoder = new TextEncoder();
    for (const reference of sample.rawReferences) {
        files.set(reference.relativePath, await readFile(join(repoRoot, 'tmp/perf/rtc-baseline', baselineId, reference.relativePath)));
    }
    files.set(
        'SHA256SUMS',
        encoder.encode(
            [...files].sort(([a], [b]) => a.localeCompare(b))
                .map(([path, bytes]) => createHash('sha256').update(bytes).digest('hex') + '  ' + path).join('\n') + '\n'
        )
    );
    const archive = await createRtcPerformanceObservationArchive({
        primaryArtifacts: files,
        observation: {
            schema: 'rallar.rtc-b06-performance-observation.v1',
            observationId: baselineId,
            startedAt: '2026-08-29T08:15:00.417Z',
            completedAt: '2026-08-29T08:20:00.417Z',
            source: { commit: observation.git.headCommit, tree: observation.git.headTree, ref: 'main' },
            workflow: { runId: 123456789, runAttempt: 1, url: 'https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/123456789' },
            primary: { outcome: sample.outcome === 'passed' ? 'passed' : 'failed', acceptedMetrics: sample.outcome === 'passed' },
            repeat: { decision: 'not-required', outcome: 'not-run' }
        }
    });
    const verified = await verifyRtcPerformanceObservationArchive({ bytes: archive.bytes, indexEntry: archive.indexEntry });
    expect(verified.ok ? [] : verified.issues).toEqual([]);
    return unzipSync(archive.bytes);
}

function createReleaseArchiveFixture(sample: RtcBaselineSampleDto): Map<string, Uint8Array> {
    const observation = sample.runtimeObservation!;
    const request = {
        schema: 'rallar.rtc-baseline.capture-request.v1',
        baselineId,
        workloadIds: ['RTC-B06'],
        environmentId: 'E3-memory',
        retainedSampleMultiplier: 1,
        repeatLink: null,
        conditionalEnvironmentDecisions: []
    };
    const files = new Map<string, Uint8Array>();
    const encoder = new TextEncoder();
    const json = (path: string, value: object) => files.set(path, encoder.encode(JSON.stringify(value)));
    json('environment.json', {
        schema: 'rallar.rtc-baseline.environment.v1',
        baselineId,
        workloadIds: ['RTC-B06'],
        environmentId: 'E3-memory',
        repeatLink: null,
        conditionalEnvironmentDecisions: [],
        observation
    });
    json('manifest.json', {
        schema: 'rallar.rtc-baseline.manifest.v1',
        request,
        workloadIds: ['RTC-B06'],
        cases: [caseKey],
        outerAttempts: [{ ...caseKey, environmentId: 'E3-memory', intendedPhase: 'retained', outerOrdinal: 1, sampleIds: [sampleId] }],
        expectedCohorts: [],
        repeatLink: null
    });
    json('results/samples/sample.json', sample);
    json('summary.json', {
        schema: 'rallar.rtc-baseline.summary.v1',
        baselineId,
        workloadIds: ['RTC-B06'],
        environmentId: 'E3-memory',
        repeatLink: null,
        conditionalEnvironmentDecisions: [],
        sampleOutcomes: [{ identity: sample.identity, outcome: sample.outcome, issues: sample.issues }],
        cohortOutcomes: [],
        metricSummaries: sample.outcome === 'passed'
            ? [{ ...caseKey, metric: 'fixture-duration', unit: 'milliseconds', count: 1, minimum: 1, median: 1, maximum: 1, mad: 0, coefficientOfVariation: 0 }]
            : [],
        rawReferences: sample.rawReferences
    });
    return files;
}

function toRecordedResult(fullResult: RallarBlackBoxTestResult): string {
    const recorded = JSON.parse(
        toControlResultArtifactLines({
            kind: 'result',
            protocolVersion: 1,
            runId,
            agentId,
            commandId: fullResult.commandId,
            ok: fullResult.ok,
            result: fullResult
        }).resultLine
    );
    return JSON.stringify({ ...recorded, action: fullResult.kind, fullResult }) + '\n';
}

it.each(['valid-reload', 'identical-receipts'])('preserves the canonical %s recovery behavior', async (variant) => {
    const fixture = await releasedFixture(false);
    vi.stubEnv('RALLAR_RTC_RELEASE_RESULTS_AFTER_CAPTURE', 'true');
    if (variant === 'valid-reload') {
        const result = toAgentReloadResult({ commandId: 'reload', readyTimeoutMs: 1000, written: 'written', atEpochMs: 1 });
        await writeFile(join(fixture.storage, 'results.jsonl'), fixture.files['results.jsonl'] + toRecordedResult(result));
    }
    else {
        await writeFile(join(fixture.storage, 'result-receipts.jsonl'), fixture.files['result-receipts.jsonl'].repeat(2));
    }
    const path = await writeLiveRtcPerformanceEvidence({ ...fixture, baselineId, runId, relativePath: fixture.evidence.locator.rawResultRelativePath });
    const sample = JSON.parse(await readFile(path, 'utf8')).samples[0];
    expect(sample.outcome).toBe('passed');
    expect(sample.rawEvidence.resultRelease).toMatchObject({ status: 'verified', releasedRoots: 1 });
});
