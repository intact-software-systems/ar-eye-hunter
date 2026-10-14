import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';

import { toRunDirectoryName } from '../../../apps/rallar-black-box-control-server/src/control-artifact-recorder.ts';
import { readGovernedLiveRtcControlServer } from '../../../tests/playwright/rallar-black-box/read-governed-live-rtc-control-server.ts';
import { readLiveRtcDurableJournal } from '../../../tests/playwright/rallar-black-box/read-live-rtc-durable-journal.ts';
import { writeLiveRtcPerformanceEvidence } from '../../../tests/playwright/rallar-black-box/write-live-rtc-performance-evidence.ts';

const baselineId = '20260829T081500417Z-0123456789ab-e3-memory-local';
const runId = 'rallar-live-three-browser-retention-live3-retention-100-abc';

async function diskFixture() {
    const repoRoot = await realpath(await mkdtemp(join(tmpdir(), 'rtc-journal-')));
    onTestFinished(() => rm(repoRoot, { recursive: true, force: true }));
    const storageDirectory = join(repoRoot, 'tmp/perf/rtc-b06-recorder', baselineId, 'retention-100/retained-1');
    const rawRelativePath = 'artifacts/journals/sample.jsonl';
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
    return { repoRoot, storageDirectory, rawRelativePath, rawPath, boundaries, bytes, path };
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
        relativePath: 'artifacts/journals/sample.jsonl',
        runId,
        bytes: disk.bytes.length,
        sha256: createHash('sha256').update(disk.bytes).digest('hex')
    });
    expect(await readFile(disk.rawPath)).toEqual(disk.bytes);
    expect(result.right?.proof.agents.map((agent) => agent.capturedRows)).toEqual([2, 2, 2]);
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
            disk.boundaries.forEach((boundary) => {
                boundary.runId = '../run';
            });
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

it.each(['complete', 'failed-producer', 'incomplete-journal'] as const)(
    'binds %s staged samples to retained original bytes before cohort reads',
    async (variant) => {
        const disk = await diskFixture();
        const caseKey = { workloadId: 'RTC-B06', caseId: 'retention-100', inputKey: 'e3-memory-retention-100' } as const;
        const identity = { ...caseKey, sampleId: 'sample', intendedPhase: 'retained', outerOrdinal: 1, innerOrdinal: 1 } as const;
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
            metrics: [],
            rawReferences: [],
            issues: [],
            rawEvidence: JSON.parse(JSON.stringify({ retention: { checkpoints: [{ cycle: 100, agents }] } })),
            runtimeObservation: {
                git: { headCommit: 'a'.repeat(40), headTree: 'b'.repeat(40), ref: 'codex/test', clean: true },
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
            producerExitStatus: variant === 'failed-producer' ? 1 : 0,
            producerFacts: {
                provider: 'browser-rallar' as const,
                browserCount: 3 as const,
                databaseProvider: 'memory' as const,
                databaseUrl: 'absent' as const,
                iceMode: 'repository-default' as const,
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
        const path = await writeLiveRtcPerformanceEvidence({
            repoRoot: disk.repoRoot,
            baselineId,
            relativePath: locator.rawResultRelativePath,
            evidence: attempt
        });
        const staged = JSON.parse(await readFile(path, 'utf8'));
        expect(staged.samples[0].rawReferences[0]).toMatchObject({
            relativePath: 'artifacts/journals/sample.jsonl',
            bytes: (await readFile(disk.path)).length
        });
        expect(staged.samples[0].rawEvidence.journal.status).toBe(variant === 'incomplete-journal' ? 'failed' : 'durable-prefix');
        expect(staged.samples[0].outcome).toBe(variant === 'complete' ? 'passed' : 'failed');
        expect(await readFile(disk.rawPath)).toEqual(await readFile(disk.path));
    }
);
