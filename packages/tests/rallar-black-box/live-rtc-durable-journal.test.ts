import { unzipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';

import { toRunDirectoryName } from '../../../apps/rallar-black-box-control-server/src/control-artifact-recorder.ts';
import { readGovernedLiveRtcControlServer } from '../../../tests/playwright/rallar-black-box/read-governed-live-rtc-control-server.ts';
import { readLiveRtcDurableJournal } from '../../../tests/playwright/rallar-black-box/read-live-rtc-durable-journal.ts';
import { writeLiveRtcPerformanceEvidence } from '../../../tests/playwright/rallar-black-box/write-live-rtc-performance-evidence.ts';
import { createRtcBaselineEvidenceAcceptance } from '../../shared-rtc-bench/baseline/acceptance/rtc-baseline-evidence-acceptance.ts';
import { resolveRtcBaselineAcceptedArtifactPath } from '../../shared-rtc-bench/baseline/acceptance/rtc-baseline-failure-accounting.ts';
import type { RtcBaselineExternalAttemptDto, RtcBaselineJson } from '../../shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';
import { classifyRtcBaselineArtifactPath } from '../../shared-rtc-bench/baseline/evidence/rtc-baseline-evidence-layout.ts';
import type { RtcBaselineExclusiveFileLock, RtcBaselineFilePort } from '../../shared-rtc-bench/baseline/evidence/rtc-baseline-file-port.ts';
import { createRtcBaselineFinalizedArtifactVerifier } from '../../shared-rtc-bench/baseline/evidence/rtc-baseline-finalized-verification.ts';
import {
    createRtcPerformanceObservationArchive,
    verifyRtcPerformanceObservationArchive
} from '../../shared-rtc-bench/baseline/observation/rtc-performance-observation-archive.ts';
import { createRtcBaselineDenoEvidence } from '../../shared-rtc-bench/baseline/runtime/rtc-baseline-deno-evidence.ts';
import { createRtcBaselineDenoFinalization } from '../../shared-rtc-bench/baseline/runtime/rtc-baseline-deno-finalization.ts';

const baselineId = '20260829T081500Z-aaaaaaaaaaaa-e3-memory-gh123456789-a1';
const runId = 'rallar-live-three-browser-retention-live3-retention-100-abc';
const sampleId = 'rtc-b06-retention-100-e3-memory-retention-100-retained-001-001';

async function diskFixture() {
    const repoRoot = await realpath(await mkdtemp(join(tmpdir(), 'rtc-journal-')));
    onTestFinished(() => rm(repoRoot, { recursive: true, force: true }));
    const storageDirectory = join(repoRoot, 'tmp/perf/rtc-b06-recorder', baselineId, 'retention-100/retained-1');
    const rawRelativePath = `artifacts/journals/${sampleId}.jsonl`;
    const rawPath = join(repoRoot, 'tmp/perf/rtc-baseline', baselineId, rawRelativePath);
    await mkdir(dirname(rawPath), { recursive: true });
    await mkdir(join(storageDirectory, 'runs', runId), { recursive: true });
    const boundaries = createJournalBoundaries();
    const rows = boundaries.flatMap((boundary) => [
        {
            kind: 'step-result',
            status: 'SUCCESS',
            action: 'health',
            name: boundary.admissionCommandId,
            commandId: boundary.admissionCommandId,
            agentId: boundary.agentId,
            actual: { stats: { eventHistory: boundary.initialHistory } }
        },
        ...[2, 3, 4, 5].map((ordinal) => ({
            kind: 'rtc-diagnostic',
            status: ordinal === 4 ? 'stats' : 'event',
            agentId: boundary.agentId,
            value: {
                eventId: `${boundary.agentId}-${ordinal}`,
                kind: ordinal === 4 ? 'stats' : ordinal === 5 ? 'result' : 'event',
                topic: 'rallar.browser',
                atEpochMs: ordinal,
                history: { runtimeId: `runtime-${boundary.agentId}`, generation: 1, ordinal }
            }
        })),
        {
            kind: 'step-result',
            status: 'SUCCESS',
            action: 'health',
            name: boundary.healthCommandId,
            commandId: boundary.healthCommandId,
            agentId: boundary.agentId,
            actual: { stats: { eventHistory: boundary.currentHistory } }
        }
    ]);
    const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const path = join(storageDirectory, 'runs', runId, 'events.jsonl');
    await writeFile(path, bytes);
    return { repoRoot, storageDirectory, rawRelativePath, rawPath, runId, boundaries, bytes, path };
}

function createJournalBoundaries() {
    const counts = { event: 1, diagnostic: 0, message: 0, stats: 0, report: 0, result: 0, state: 0 };
    const receipt = { routineBrowserDiagnostics: 'disabled' as const, omittedRoutineBrowserDiagnostics: 1, forwardedBrowserDiagnostics: 1 };
    return ['a', 'b', 'c'].map((agentId) => {
        const initialHistory = {
            runtimeId: `runtime-${agentId}`,
            generation: 1,
            policy: { mode: 'recent' as const, maxEvents: 64 },
            totalEvents: 1,
            retainedEvents: 1,
            evictedEvents: 0,
            evictedThroughEpochMs: undefined,
            countsByKind: counts,
            reconnects: 0,
            capture: { status: 'continuous' as const, identity: { runId, agentId }, start: { runtimeId: `runtime-${agentId}`, generation: 1, ordinal: 2 } }
        };
        return {
            runId,
            agentId,
            admissionCommandId: `admit-${agentId}`,
            healthCommandId: `rtc-diagnostics-${agentId}-retention-100-suffix`,
            initialHistory,
            currentHistory: { ...initialHistory, totalEvents: 3, retainedEvents: 3, countsByKind: { ...counts, event: 3 } },
            initial: receipt,
            current: receipt
        };
    });
}

it('preserves exact original disk prefix bytes and hash through events markers, excluding cleanup tail from the claim', async () => {
    const disk = await diskFixture();
    await writeFile(disk.path, Buffer.concat([disk.bytes, Buffer.from('{cleanup-next-generation-unfinished')]));
    const result = await readLiveRtcDurableJournal(disk);
    expect(result.left).toBeUndefined();
    expect(result.right?.source).toMatchObject({
        kind: 'owned-recorder-file',
        relativePath: `artifacts/journals/${sampleId}.jsonl`,
        runId,
        bytes: disk.bytes.length,
        sha256: createHash('sha256').update(disk.bytes).digest('hex')
    });
    expect(await readFile(disk.rawPath)).toEqual(disk.bytes);
    expect(result.right?.proof.agents.map((agent) => agent.capturedRows)).toEqual([2, 2, 2]);
});

it('preserves the owned run bytes as failed evidence when Health identifies a different run', async () => {
    const disk = await diskFixture();
    disk.boundaries[0]!.runId = 'foreign-run';
    const result = await readLiveRtcDurableJournal(disk);
    expect(result.left).toEqual({
        reason: 'journal-run-identity-mismatch',
        source: { relativePath: disk.rawRelativePath, bytes: disk.bytes.length, sha256: await sha256(disk.bytes) }
    });
    expect(await readFile(disk.rawPath)).toEqual(disk.bytes);
});

it.each(['memory-only', 'results-only', 'symlink', 'unsupported-run', 'missing-marker', 'output-escape'] as const)(
    'refuses %s as durability evidence',
    async (failure) => {
        const disk = await diskFixture();
        if (failure === 'memory-only') {
            await rm(disk.path);
        }
        if (failure === 'results-only') {
            await writeFile(join(dirname(disk.path), 'results.jsonl'), disk.bytes);
            await rm(disk.path);
        }
        if (failure === 'symlink') {
            await rm(disk.path);
            await writeFile(join(disk.repoRoot, 'outside.jsonl'), disk.bytes);
            await symlink(join(disk.repoRoot, 'outside.jsonl'), disk.path);
        }
        if (failure === 'unsupported-run') {
            disk.runId = '../run';
        }
        if (failure === 'missing-marker') {
            await writeFile(disk.path, disk.bytes.subarray(0, disk.bytes.lastIndexOf('\n', disk.bytes.length - 2) + 1));
        }
        if (failure === 'output-escape') {
            disk.rawPath = join(disk.repoRoot, 'outside-output.jsonl');
        }
        expect((await readLiveRtcDurableJournal(disk)).left).toBeDefined();
        if (failure === 'missing-marker') {
            expect(await readFile(disk.rawPath)).toEqual(await readFile(disk.path));
        }
    }
);

interface VerifyFailedJournalArchiveInput {
    readonly disk: Awaited<ReturnType<typeof diskFixture>>;
    readonly attempt: RtcBaselineExternalAttemptDto;
    readonly staged: RtcBaselineExternalAttemptDto;
    readonly failureEvidence: RtcBaselineJson;
}

async function verifyFailedJournalArchive(verification: VerifyFailedJournalArchiveInput) {
    const { disk, attempt, staged, failureEvidence } = verification;
    const rootPath = join(disk.repoRoot, 'tmp/perf/rtc-baseline');
    const baselinePath = join(rootPath, baselineId);
    const observation = attempt.samples[0]!.runtimeObservation!;
    const request = {
        schema: 'rallar.rtc-baseline.capture-request.v1' as const,
        baselineId,
        workloadIds: ['RTC-B06'] as const,
        environmentId: 'E3-memory' as const,
        retainedSampleMultiplier: 1 as const,
        repeatLink: null,
        conditionalEnvironmentDecisions: []
    };
    const manifest = {
        schema: 'rallar.rtc-baseline.manifest.v1' as const,
        request,
        workloadIds: request.workloadIds,
        cases: [{ workloadId: 'RTC-B06', caseId: attempt.locator.caseId, inputKey: attempt.locator.inputKey }],
        outerAttempts: [1, 2].map((outerOrdinal) => ({
            workloadId: attempt.locator.workloadId,
            caseId: attempt.locator.caseId,
            inputKey: attempt.locator.inputKey,
            environmentId: attempt.locator.environmentId,
            intendedPhase: attempt.locator.intendedPhase,
            outerOrdinal,
            sampleIds: [outerOrdinal === 1 ? sampleId : sampleId.replace('retained-001-001', 'retained-002-001')]
        })),
        expectedCohorts: [{
            cohortId: 'retention-cohort',
            workloadId: 'RTC-B06',
            memberSampleIds: [sampleId, sampleId.replace('retained-001-001', 'retained-002-001')]
        }],
        repeatLink: null
    };
    const evidence = createRtcBaselineDenoEvidence({
        rootPath,
        filePort: new FilesystemEvidencePort(),
        writerLockRuntime: {
            createOwnerToken: () => crypto.randomUUID(),
            readOwnerIdentity: () => ({ hostname: 'test', processId: process.pid }),
            now: () => new Date(),
            readProcessLiveness: async () => 'alive'
        },
        observeRuntime: async () => ({ ok: true, value: observation })
    });
    for (const directory of ['samples', 'external-attempts', 'external-cohorts', 'failures', 'finalization-failures']) {
        await mkdir(join(baselinePath, 'results', directory), { recursive: true });
    }
    await writeFile(join(baselinePath, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(
        join(baselinePath, 'environment.json'),
        JSON.stringify({
            schema: 'rallar.rtc-baseline.environment.v1',
            baselineId,
            workloadIds: request.workloadIds,
            environmentId: request.environmentId,
            repeatLink: null,
            conditionalEnvironmentDecisions: [],
            observation
        })
    );
    const acceptance = createRtcBaselineEvidenceAcceptance({
        initializeStore: async () => {
            throw new Error('Already initialized.');
        },
        readManifest: evidence.readManifest,
        readInitializedConfiguration: async () => ({ ok: true, value: observation.resolvedConfiguration }),
        writeAcceptedArtifact: async (id, artifact) => {
            const path = resolveRtcBaselineAcceptedArtifactPath(artifact);
            return path.ok ? evidence.store.writeJsonCreateNew(id, path.value, artifact) : path;
        },
        readStagedJson: evidence.store.readJson,
        runFreshWorker: async () => {
            throw new Error('External producer only.');
        },
        reconcileAcceptedOperation: evidence.reconcileAcceptedOperation
    });
    const recorded = await acceptance.recordExternalAttempt({
        baselineId,
        locator: {
            workloadId: attempt.locator.workloadId,
            caseId: attempt.locator.caseId,
            inputKey: attempt.locator.inputKey,
            intendedPhase: attempt.locator.intendedPhase,
            outerOrdinal: attempt.locator.outerOrdinal
        },
        producerExitStatus: attempt.producerExitStatus,
        rawResultRelativePath: attempt.locator.rawResultRelativePath
    });
    expect(recorded.ok).toBe(false);
    const finalized = await createRtcBaselineDenoFinalization(evidence, sha256).finalizedEvidence.finalize({ baselineId });
    expect(finalized.ok ? [] : finalized.issues).toEqual([]);
    if (!finalized.ok) {
        throw new Error('Failed evidence must finalize structurally.');
    }
    expect(finalized.value.metricSummaries).toEqual([]);
    expect(finalized.value.sampleOutcomes).toMatchObject([
        { identity: attempt.samples[0]!.identity, outcome: 'failed' },
        { identity: { sampleId: sampleId.replace('retained-001-001', 'retained-002-001') }, outcome: 'not-run', issues: [{ code: 'causal-not-run' }] }
    ]);
    expect(finalized.value.cohortOutcomes).toMatchObject([{ outcome: 'failed', issues: [{ code: 'cohort-members-unavailable' }] }]);
    expect(finalized.value.rawReferences).toEqual(staged.samples[0]!.rawReferences);
    const originalBytes = await readFile(disk.path);
    expect(finalized.value.rawReferences).toEqual([{
        relativePath: disk.rawRelativePath,
        bytes: originalBytes.length,
        sha256: await sha256(originalBytes)
    }]);
    const results = await evidence.store.listArtifacts(baselineId, 'results');
    const artifacts = await evidence.store.listArtifacts(baselineId, 'artifacts');
    if (!results.ok || !artifacts.ok) {
        throw new Error('Filesystem artifact listing failed.');
    }
    const failureEvidenceValues: RtcBaselineJson[] = [];
    for (const entry of results.value.filter((entry) => classifyRtcBaselineArtifactPath(entry.relativePath) === 'failure-outcome')) {
        const retained = await evidence.store.readJson(baselineId, entry.relativePath);
        if (
            retained.ok && retained.value && typeof retained.value === 'object' && !Array.isArray(retained.value) &&
            retained.value.failureId === `failure-sample-${sampleId}` && retained.value.artifactKind === 'failure'
        ) {
            failureEvidenceValues.push(retained.value.rawEvidence!);
        }
    }
    expect(failureEvidenceValues).toEqual([failureEvidence]);
    const paths = [
        'environment.json',
        'manifest.json',
        'summary.json',
        ...results.value.map((entry) => entry.relativePath),
        ...artifacts.value.map((entry) => entry.relativePath).filter((path) => classifyRtcBaselineArtifactPath(path) === 'raw')
    ];
    const verifier = createRtcBaselineFinalizedArtifactVerifier({
        readJson: evidence.store.readJson,
        readBytes: evidence.store.readBytes,
        listArtifactPaths: async () => ({ ok: true, value: paths }),
        sha256
    });
    expect(await verifier.readStructurallyVerifiedArtifacts(baselineId)).toMatchObject({ ok: true });
    expect(await verifier.readVerifiedArtifacts(baselineId)).toMatchObject({ ok: false, issues: [{ code: 'non-passing-finalized-outcome' }] });
    const primaryArtifacts = new Map<string, Uint8Array>();
    for (const path of [...paths, 'SHA256SUMS']) {
        primaryArtifacts.set(path, await readFile(join(baselinePath, path)));
    }
    const archive = await createRtcPerformanceObservationArchive({
        observation: {
            schema: 'rallar.rtc-b06-performance-observation.v1',
            observationId: baselineId,
            startedAt: observation.timing.startedAtUtc,
            completedAt: observation.timing.endedAtUtc,
            source: { commit: observation.git.headCommit, tree: observation.git.headTree, ref: observation.git.ref },
            workflow: { runId: 123456789, runAttempt: 1, url: 'https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/123456789' },
            primary: { outcome: 'failed', acceptedMetrics: false },
            repeat: { decision: 'not-required', outcome: 'not-run' }
        },
        primaryArtifacts
    });
    const verifiedArchive = await verifyRtcPerformanceObservationArchive({ bytes: archive.bytes, indexEntry: archive.indexEntry });
    expect(verifiedArchive.ok ? [] : verifiedArchive.issues).toEqual([]);
    expect(Buffer.from(unzipSync(archive.bytes)[`primary/${baselineId}/${disk.rawRelativePath}`]!)).toEqual(originalBytes);
    await writeFile(disk.rawPath, Buffer.concat([originalBytes, Buffer.from('tamper')]));
    expect(await verifier.readStructurallyVerifiedArtifacts(baselineId)).toMatchObject({
        ok: false,
        issues: expect.arrayContaining([{
            path: `$.${disk.rawRelativePath}`,
            code: 'checksum-mismatch',
            message: 'Stored bytes do not match the SHA-256 checksum.'
        }])
    });
}

async function sha256(bytes: Uint8Array): Promise<string> {
    return createHash('sha256').update(bytes).digest('hex');
}

class FilesystemEvidencePort implements RtcBaselineFilePort {
    private readonly acquired = new Set<string>();

    async inspectPath(path: string): ReturnType<RtcBaselineFilePort['inspectPath']> {
        try {
            const info = await lstat(path);
            return { kind: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other' };
        }
        catch (cause) {
            if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
                return null;
            }
            throw cause;
        }
    }

    async createDirectory(path: string, options: { recursive: boolean; }): Promise<void> {
        await mkdir(path, options);
    }

    writeFileCreateNew(path: string, bytes: Uint8Array): Promise<void> {
        return writeFile(path, bytes, { flag: 'wx' });
    }

    readFile(path: string): Promise<Uint8Array> {
        return readFile(path);
    }

    removeFile(path: string): Promise<void> {
        return rm(path);
    }

    removeDirectory(path: string): Promise<void> {
        return rm(path, { recursive: true });
    }

    async listDirectory(path: string): ReturnType<RtcBaselineFilePort['listDirectory']> {
        return (await readdir(path, { withFileTypes: true })).map((entry) => ({
            name: entry.name,
            kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
        }));
    }

    async tryAcquireExclusiveFileLock(path: string): Promise<RtcBaselineExclusiveFileLock | null> {
        if (this.acquired.has(path)) {
            return null;
        }
        this.acquired.add(path);
        try {
            let created = true;
            let file;
            try {
                file = await open(path, 'wx+');
            }
            catch (cause) {
                if (!(cause instanceof Error && 'code' in cause && cause.code === 'EEXIST')) {
                    throw cause;
                }
                created = false;
                file = await open(path, 'r+');
            }
            return {
                created,
                readBytes: () => readFile(path),
                writeBytes: (bytes) => writeFile(path, bytes),
                release: async () => {
                    await file.close();
                    this.acquired.delete(path);
                }
            };
        }
        catch (cause) {
            this.acquired.delete(path);
            throw cause;
        }
    }
}

it('uses only the actual generated literal run IDs admitted unchanged by the canonical encoder', () => {
    const generated = `rallar-live-three-browser-retention-live3-retention-${Date.now()}-${crypto.randomUUID()}`;
    expect(generated).toMatch(/^[a-z0-9-]+$/);
    expect(toRunDirectoryName(generated)).toBe(generated);
    expect(toRunDirectoryName('run/A')).not.toBe('run/A');
});

it('requires the current recorder path and refuses control process reuse before measurement', async () => {
    const disk = await diskFixture();
    const attempt = { repoRoot: disk.repoRoot, baselineId, locator: { caseId: 'retention-100', intendedPhase: 'retained', outerOrdinal: 1 } };
    const server = await readGovernedLiveRtcControlServer({ attempt: attempt, baseUrl: 'http://127.0.0.1:5180', storageDirectory: disk.storageDirectory });
    expect(server.reuseExistingServer).toBe(false);
    expect(server.env.RALLAR_BLACK_BOX_STORAGE_DIR).toBe(disk.storageDirectory);
    await expect(readGovernedLiveRtcControlServer({ attempt: attempt, baseUrl: 'http://127.0.0.1:5180', storageDirectory: undefined })).rejects.toThrow(
        'exact current-attempt'
    );
});

it.each(['complete', 'failed-producer', 'producer-exit', 'receipt-failure', 'incomplete-journal', 'preterminal', 'malformed-health'] as const)(
    'preserves %s journal bytes and failed admission accounting',
    async (variant) => {
        const disk = await diskFixture();
        const caseKey = { workloadId: 'RTC-B06', caseId: 'retention-100', inputKey: 'e3-memory-retention-100' } as const;
        const identity = { ...caseKey, sampleId, intendedPhase: 'retained', outerOrdinal: 1, innerOrdinal: 1 } as const;
        const policy = [
            { caseKey, field: 'eventHistoryMode', value: 'recent', source: 'default' as const },
            { caseKey, field: 'eventHistoryMaxEvents', value: 64, source: 'default' as const },
            { caseKey, field: 'rtcCaptureMode', value: 'off', source: 'default' as const },
            { caseKey, field: 'almDiagnostics', value: false, source: 'default' as const },
            { caseKey, field: 'routineBrowserDiagnostics', value: 'disabled', source: 'default' as const }
        ];
        const agents = disk.boundaries.map((boundary) => ({
            agentId: boundary.agentId,
            details: {
                browserDiagnostics: boundary.current,
                eventHistory: boundary.currentHistory,
                browserDiagnosticsAdmission: {
                    agentId: boundary.agentId,
                    runId,
                    commandId: boundary.admissionCommandId,
                    receipt: boundary.initial,
                    eventHistory: boundary.initialHistory
                },
                browserDiagnosticsHealth: { agentId: boundary.agentId, runId, commandId: boundary.healthCommandId }
            }
        }));
        const sample = {
            schema: 'rallar.rtc-baseline.sample.v1' as const,
            identity,
            outcome: variant === 'failed-producer' ? 'failed' as const : 'passed' as const,
            evidenceClass: 'local-full-stack' as const,
            metrics: [{ metric: 'durationMs', unit: 'ms', value: 42 }],
            rawReferences: [],
            issues: [],
            rawEvidence: JSON.parse(JSON.stringify({ retention: { checkpoints: [{ cycle: 100, agents }] } })),
            runtimeObservation: {
                git: { headCommit: 'a'.repeat(40), headTree: 'b'.repeat(40), ref: 'main', clean: true },
                runtime: { node: 'test', npm: 'test', deno: 'test', playwright: 'test', chromium: 'test' },
                host: {
                    os: 'test',
                    kernel: 'test',
                    architecture: 'test',
                    logicalCpuCount: 1,
                    cpuModel: 'test',
                    totalMemoryBytes: 1,
                    executionContext: 'local' as const
                },
                timing: {
                    startedAtUtc: '2026-08-29T08:15:00.417Z',
                    endedAtUtc: '2026-08-29T08:16:00.417Z',
                    monotonicDurationMs: 60000,
                    monotonicSource: 'performance.now'
                },
                deviations: [],
                sourceHashes: [],
                configurationInputs: [],
                resolvedConfiguration: policy,
                controllerInputs: [],
                workerCommand: { redactedArgv: { executable: 'test', arguments: [] }, projection: { fixedWorkerFlags: [], configurationFlags: [] } },
                allowlistedEnvironment: {}
            }
        };
        const locator = {
            ...caseKey,
            environmentId: 'E3-memory' as const,
            intendedPhase: 'retained' as const,
            outerOrdinal: 1,
            rawResultRelativePath: 'artifacts/staging/attempt.json'
        };
        const attempt = {
            schema: 'rallar.rtc-baseline.external-attempt.v1' as const,
            locator,
            producerExitStatus: variant === 'failed-producer' || variant === 'producer-exit' ? 1 : 0,
            producerFacts: {
                databaseUrl: 'absent' as const,
                allScenariosRaw: null,
                retentionSoakRaw: '1',
                retentionCyclesRaw: '100',
                iceModeRaw: null,
                allScenariosPresent: false,
                retentionSoakPresent: true,
                retentionCyclesPresent: true,
                iceModePresent: false
            },
            samples: [sample],
            sampleOutcomes: [{ identity, outcome: sample.outcome, issues: [] }],
            issues: []
        };
        if (variant === 'incomplete-journal') {
            await writeFile(disk.path, disk.bytes.subarray(0, disk.bytes.length - 20));
        }
        if (variant === 'preterminal') {
            sample.rawEvidence.retention.checkpoints[0].cycle = 99;
            await writeFile(disk.path, Buffer.from('{"kind":"partial-attempt"}\n{"append-tail":'));
        }
        if (variant === 'malformed-health') {
            sample.rawEvidence.retention.checkpoints[0].agents[0].details.eventHistory = null;
        }
        const path = await writeLiveRtcPerformanceEvidence({
            repoRoot: disk.repoRoot,
            baselineId,
            relativePath: locator.rawResultRelativePath,
            runId,
            evidence: attempt
        });
        const staged = JSON.parse(await readFile(path, 'utf8'));
        expect(staged.samples[0].rawReferences[0]).toMatchObject({
            relativePath: `artifacts/journals/${sampleId}.jsonl`,
            bytes: (await readFile(disk.path)).length
        });
        const unverified = ['incomplete-journal', 'preterminal', 'malformed-health'].includes(variant);
        expect(staged.samples[0].rawEvidence.journal.status).toBe(unverified ? 'failed' : 'durable-prefix');
        expect(staged.samples[0].outcome).toBe(variant === 'complete' || variant === 'producer-exit' || variant === 'receipt-failure' ? 'passed' : 'failed');
        expect(await readFile(disk.rawPath)).toEqual(await readFile(disk.path));
        if (variant !== 'complete') {
            await verifyFailedJournalArchive({
                disk,
                attempt,
                staged,
                failureEvidence: variant === 'receipt-failure' ? staged.samples[0] : staged.samples[0].rawEvidence
            });
        }
    }
);
