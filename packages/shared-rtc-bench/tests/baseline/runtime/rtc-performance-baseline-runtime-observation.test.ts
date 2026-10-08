import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { RtcBaselineCaptureRequestDto } from '../../../baseline/contracts/rtc-baseline-contracts.ts';
import { createRtcBaselineRuntimeObservationInput } from '../../../baseline/runtime/create-rtc-baseline-runtime-observation-input.ts';
import type { DenoRtcBaselineAdapters } from '../../../baseline/runtime/rtc-baseline-deno-adapters.ts';
import { createRtcBaselineDenoRuntime } from '../../../baseline/runtime/rtc-baseline-deno-runtime.ts';
import { createRtcBaselineDenoObservation } from '../../../baseline/runtime/rtc-baseline-runtime-observation.ts';

const baselineId = '20260816-956a057c9ab5-e1-local';

function readWorkerFlag(arguments_: readonly string[], name: string) {
    const value = arguments_.find((argument) => argument.startsWith(`--${name}=`));
    if (!value) {
        throw new Error(`Worker command is missing --${name}.`);
    }
    return value.slice(name.length + 3);
}

function createRtcBaselineTemporaryFilePortFixture(rootPath: string): DenoRtcBaselineAdapters['filePort'] {
    const toTemporaryPath = (path: string) => join(rootPath, path);
    return {
        inspectPath: async (path) => {
            try {
                const entry = await stat(toTemporaryPath(path));
                return entry.isDirectory() ? { kind: 'directory' } : { kind: 'file' };
            }
            catch {
                return null;
            }
        },
        createDirectory: async (path, options) => {
            await mkdir(toTemporaryPath(path), options);
        },
        writeFileCreateNew: async (path, bytes) => writeFile(toTemporaryPath(path), bytes, { flag: 'wx' }),
        readFile: async (path) => readFile(toTemporaryPath(path)),
        removeFile: async (path) => {
            await rm(toTemporaryPath(path));
        },
        removeDirectory: async (path) => rm(toTemporaryPath(path), { force: true, recursive: true }),
        listDirectory: async (path) =>
            (await readdir(toTemporaryPath(path), { withFileTypes: true })).map((entry) => ({
                name: entry.name,
                kind: entry.isDirectory() ? ('directory' as const) : ('file' as const)
            })),
        ...createRtcBaselineTemporaryWriterLockFixture(rootPath)
    };
}

function createRtcBaselineTemporaryWriterLockFixture(rootPath: string): Pick<DenoRtcBaselineAdapters['filePort'], 'tryAcquireExclusiveFileLock'> {
    let writerLockHeld = false;
    const toTemporaryPath = (path: string) => join(rootPath, path);
    return {
        async tryAcquireExclusiveFileLock(path) {
            if (writerLockHeld) {
                return null;
            }
            let created = true;
            let file;
            try {
                file = await open(toTemporaryPath(path), 'wx+');
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                    throw error;
                }
                created = false;
                file = await open(toTemporaryPath(path), 'r+');
            }
            writerLockHeld = true;
            return {
                created,
                async readBytes() {
                    const { size } = await file.stat();
                    const bytes = new Uint8Array(size);
                    await file.read(bytes, 0, size, 0);
                    return bytes;
                },
                async writeBytes(bytes) {
                    await file.truncate(0);
                    await file.write(bytes, 0, bytes.length, 0);
                    await file.sync();
                },
                async release() {
                    writerLockHeld = false;
                    await file.close();
                }
            };
        }
    };
}

function createNeutralRtcBaselineSyntheticWorkerFixture(): DenoRtcBaselineAdapters['freshWorker'] {
    return {
        run: async ({ arguments: workerArguments }) => {
            const workloadId = readWorkerFlag(workerArguments, 'workload');
            const caseId = readWorkerFlag(workerArguments, 'case-id');
            const inputKey = readWorkerFlag(workerArguments, 'input-key');
            const intendedPhase = readWorkerFlag(workerArguments, 'intended-phase');
            const outerOrdinal = Number(readWorkerFlag(workerArguments, 'outer-ordinal'));
            const sampleIds = readWorkerFlag(workerArguments, 'sample-ids').split(',');
            return {
                ok: true as const,
                value: {
                    exitStatus: 0,
                    stdout: JSON.stringify(
                        sampleIds.map((sampleId, index) => ({
                            schema: 'rallar.rtc-baseline.sample.v1',
                            identity: {
                                sampleId,
                                workloadId,
                                caseId,
                                inputKey,
                                intendedPhase,
                                outerOrdinal,
                                innerOrdinal: index + 1
                            },
                            outcome: 'passed',
                            evidenceClass: 'synthetic-path',
                            metrics: [{ metric: 'durationMs', unit: 'ms', value: index + 1 }],
                            rawEvidence: null,
                            rawReferences: [],
                            issues: [],
                            runtimeObservation: null
                        }))
                    ),
                    stderr: ''
                }
            };
        }
    };
}

interface RtcBaselineRuntimeTestAdapters {
    adapters: DenoRtcBaselineAdapters;
    rootPath: string;
}

async function createRtcBaselineRuntimeAdaptersFixture(): Promise<RtcBaselineRuntimeTestAdapters> {
    const rootPath = await mkdtemp(join(tmpdir(), 'rtc-runtime-observation-'));
    const adapters: DenoRtcBaselineAdapters = {
        filePort: createRtcBaselineTemporaryFilePortFixture(rootPath),
        writerLockRuntime: {
            createOwnerToken: () => '00000000-0000-4000-8000-000000000001',
            readOwnerIdentity: () => ({ hostname: 'runner-a', processId: 123 }),
            now: () => new Date('2026-08-16T10:00:00.000Z'),
            readProcessLiveness: async () => 'dead'
        },
        git: {
            readHeadCommit: async () => ({ ok: true, value: 'a'.repeat(40) }),
            readHeadTree: async () => ({ ok: true, value: 'b'.repeat(40) }),
            readRef: async () => ({ ok: true, value: 'codex/rtc-topology-service-ownership' }),
            readStatus: async () => ({ ok: true, value: '' })
        },
        process: { run: async () => ({ ok: true, value: { exitStatus: 0, stdout: '', stderr: '' } }) },
        freshWorker: createNeutralRtcBaselineSyntheticWorkerFixture(),
        environment: { readAllowlisted: () => ({}) },
        runtimeHost: {
            read: async () => ({
                os: 'darwin',
                kernel: '24.6.0',
                architecture: 'arm64',
                logicalCpuCount: 10,
                cpuModel: 'Apple M4',
                totalMemoryBytes: 1,
                deno: '2.4.0',
                executionContext: 'local' as const
            })
        },
        clock: { nowUtc: () => '2026-08-16T10:00:00.000Z', monotonicNowMs: () => 10 },
        sourceConfigHashing: { read: async () => ({ ok: true, value: [] }) },
        sha256: async () => 'c'.repeat(64)
    };
    return { adapters, rootPath };
}

describe('RTC baseline Deno runtime observation binding', () => {
    it.each(
        [
            [undefined, 'signaling', 'default'],
            ['off', 'off', 'environment'],
            ['native', 'native', 'environment']
        ] as const
    )('persists admitted B06 capture %s with truthful provenance before capture', async (environmentMode, mode, source) => {
        const { adapters, rootPath } = await createRtcBaselineRuntimeAdaptersFixture();
        const environment: Record<string, string> = {
            RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: '1',
            RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
            RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100',
            ...(environmentMode === undefined ? {} : { RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: environmentMode })
        };
        adapters.environment.readAllowlisted = (names) =>
            Object.fromEntries(
                names.filter((name) => environment[name] !== undefined).map((name) => [name, environment[name]!])
            );
        const runtime = createRtcBaselineDenoRuntime(adapters);
        const liveBaselineId = '20260816-956a057c9ab5-e3-memory';
        try {
            const initialized = await runtime.initializeBaseline({
                schema: 'rallar.rtc-baseline.capture-request.v1',
                baselineId: liveBaselineId,
                workloadIds: ['RTC-B06'],
                environmentId: 'E3-memory',
                retainedSampleMultiplier: 1,
                repeatLink: null,
                conditionalEnvironmentDecisions: []
            });
            expect(initialized).toMatchObject({ ok: true });
            const stored = JSON.parse(
                await readFile(
                    join(rootPath, 'tmp/perf/rtc-baseline', liveBaselineId, 'environment.json'),
                    'utf8'
                )
            );
            expect(stored.observation.resolvedConfiguration.filter(
                (entry: { field: string; }) => entry.field === 'rtcCaptureMode'
            )).toEqual([
                { caseKey: { workloadId: 'RTC-B06', caseId: 'default', inputKey: 'e3-memory-default' }, field: 'rtcCaptureMode', value: mode, source },
                {
                    caseKey: { workloadId: 'RTC-B06', caseId: 'all-scenarios', inputKey: 'e3-memory-all-scenarios' },
                    field: 'rtcCaptureMode',
                    value: mode,
                    source
                },
                {
                    caseKey: { workloadId: 'RTC-B06', caseId: 'retention-100', inputKey: 'e3-memory-retention-100' },
                    field: 'rtcCaptureMode',
                    value: mode,
                    source
                }
            ]);
            expect(stored.observation.allowlistedEnvironment.RALLAR_BLACK_BOX_RTC_CAPTURE_MODE).toBe(environmentMode);
        }
        finally {
            await rm(rootPath, { force: true, recursive: true });
        }
    });

    it.each(['native', 'invalid-ambient'])('gives explicit CLI Off precedence over actual environment %s', async (ambient) => {
        const { adapters, rootPath } = await createRtcBaselineRuntimeAdaptersFixture();
        adapters.environment.readAllowlisted = () => ({
            RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: ambient,
            RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: '1',
            RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
            RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100'
        });
        try {
            const runtime = createRtcBaselineDenoRuntime(adapters, { mode: 'off', source: 'cli' });
            expect(await runtime.initializeBaseline(createLiveRtcBaselineCaptureRequestFixture())).toMatchObject({ ok: true });
            const stored = JSON.parse(
                await readFile(join(rootPath, 'tmp/perf/rtc-baseline', createLiveRtcBaselineCaptureRequestFixture().baselineId, 'environment.json'), 'utf8')
            );
            expect(stored.observation.resolvedConfiguration.filter((entry: { field: string; }) => entry.field === 'rtcCaptureMode'))
                .toEqual(['default', 'all-scenarios', 'retention-100'].map((caseId) => ({
                    caseKey: { workloadId: 'RTC-B06', caseId, inputKey: `e3-memory-${caseId}` },
                    field: 'rtcCaptureMode',
                    value: 'off',
                    source: 'cli'
                })));
            expect(stored.observation.allowlistedEnvironment.RALLAR_BLACK_BOX_RTC_CAPTURE_MODE).toBe(ambient);
            expect(stored.observation.configurationInputs.some((entry: { name: string; }) => entry.name === 'RALLAR_BLACK_BOX_RTC_CAPTURE_MODE')).toBe(false);
        }
        finally {
            await rm(rootPath, { force: true, recursive: true });
        }
    });

    it('keeps per-run initialization admission after caller mutation while refusing changed observed environment at acceptance', async () => {
        const { adapters, rootPath } = await createRtcBaselineRuntimeAdaptersFixture();
        let ambient = 'off';
        adapters.environment.readAllowlisted = () => ({
            RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: ambient,
            RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: '1',
            RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
            RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100'
        });
        const admission = { mode: 'off' as 'off' | 'native', source: 'environment' as const };
        const runtime = createRtcBaselineDenoRuntime(adapters, admission);
        try {
            expect(await runtime.initializeBaseline(createLiveRtcBaselineCaptureRequestFixture())).toMatchObject({ ok: true });
            ambient = 'native';
            admission.mode = 'native';
            const nextId = '20260817-956a057c9ab5-e3-memory';
            expect(await runtime.initializeBaseline({ ...createLiveRtcBaselineCaptureRequestFixture(), baselineId: nextId })).toMatchObject({ ok: true });
            const stored = JSON.parse(await readFile(join(rootPath, 'tmp/perf/rtc-baseline', nextId, 'environment.json'), 'utf8'));
            expect(
                stored.observation.resolvedConfiguration.filter((entry: { field: string; }) => entry.field === 'rtcCaptureMode').map((
                    entry: { value: string; }
                ) => entry.value)
            )
                .toEqual(['off', 'off', 'off']);
            expect(stored.observation.allowlistedEnvironment.RALLAR_BLACK_BOX_RTC_CAPTURE_MODE).toBe('native');
            const accepted = await runtime.recordExternalAttempt({
                baselineId: createLiveRtcBaselineCaptureRequestFixture().baselineId,
                locator: { workloadId: 'RTC-B06', caseId: 'default', inputKey: 'e3-memory-default', intendedPhase: 'warmup', outerOrdinal: 1 },
                producerExitStatus: 0,
                rawResultRelativePath: 'artifacts/staging/default.json'
            });
            expect(accepted).toMatchObject({
                ok: false,
                issues: expect.arrayContaining([expect.objectContaining({
                    code: 'reconciliation-mismatch',
                    path: '$.allowlistedEnvironment'
                })])
            });
        }
        finally {
            await rm(rootPath, { force: true, recursive: true });
        }
    });

    it('rejects a selected invalid capture environment before observing host or creating evidence', async () => {
        const { adapters, rootPath } = await createRtcBaselineRuntimeAdaptersFixture();
        let effects = 0;
        adapters.environment.readAllowlisted = () => ({
            RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: 'Native',
            RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: '1',
            RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
            RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100'
        });
        adapters.runtimeHost.read = async () => {
            effects += 1;
            throw new Error('Host observation must not run');
        };
        try {
            const result = await createRtcBaselineDenoRuntime(adapters).initializeBaseline(createLiveRtcBaselineCaptureRequestFixture());
            expect(result).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: 'invalid-rtc-capture-mode' })] });
            expect(effects).toBe(0);
            expect(await readdir(rootPath)).toEqual([]);
        }
        finally {
            await rm(rootPath, { force: true, recursive: true });
        }
    });

    it('retains initialized environment admission while reporting changed actual environment', async () => {
        const { adapters, rootPath } = await createRtcBaselineRuntimeAdaptersFixture();
        try {
            adapters.environment.readAllowlisted = () => ({
                RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: '1',
                RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
                RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100'
            });
            const initialized = await createRtcBaselineDenoObservation(adapters)(createLiveRtcBaselineCaptureRequestFixture());
            if (!initialized.ok) {
                throw new Error('Observation setup failed');
            }
            const admitted = {
                ...initialized.value,
                resolvedConfiguration: ['default', 'all-scenarios', 'retention-100'].map((caseId) => ({
                    caseKey: { workloadId: 'RTC-B06' as const, caseId, inputKey: `e3-memory-${caseId}` },
                    field: 'rtcCaptureMode',
                    value: 'off',
                    source: 'environment' as const
                }))
            };
            const current = createRtcBaselineRuntimeObservationInput(createLiveRtcBaselineCaptureRequestFixture(), {
                RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: 'native',
                RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: '1',
                RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
                RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100'
            }, { initialized: admitted });
            expect(current).toMatchObject({ ok: true });
            if (!current.ok) {
                throw new Error('Observation unexpectedly refused');
            }
            expect(current.value.observation.resolvedConfiguration.filter((entry) => entry.field === 'rtcCaptureMode'))
                .toEqual(admitted.resolvedConfiguration);
            expect(current.value.observation.allowlistedEnvironment.RALLAR_BLACK_BOX_RTC_CAPTURE_MODE).toBe('native');
        }
        finally {
            await rm(rootPath, { force: true, recursive: true });
        }
    });

    it('hashes the actual B06 full-stack producer configuration and exercised capture owners', async () => {
        const { adapters, rootPath } = await createRtcBaselineRuntimeAdaptersFixture();
        const hashedPaths: string[] = [];
        adapters.sourceConfigHashing.read = async (files) => {
            hashedPaths.push(...files.map((file) => file.path));
            return { ok: true, value: [] };
        };
        try {
            adapters.environment.readAllowlisted = () => ({
                RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: '1',
                RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
                RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100'
            });
            await createRtcBaselineDenoObservation(adapters)(createLiveRtcBaselineCaptureRequestFixture());
            expect(hashedPaths).toEqual(expect.arrayContaining([
                'apps/rallar-black-box/playwright.full-stack.config.ts',
                'tests/playwright/rallar-black-box/create-group-formation-lifecycle-driver.ts',
                'tests/playwright/rallar-black-box/live-rtc-delivery-operations.ts',
                'tests/playwright/rallar-black-box/live-rtc-agent-environment.ts',
                'tests/playwright/rallar-black-box/to-live-rtc-native-acquisition.ts',
                'packages/shared/webrtc/rtc-capture-configuration.ts'
            ]));
            expect(hashedPaths).not.toContain('apps/rallar-black-box/playwright.config.ts');
        }
        finally {
            await rm(rootPath, { force: true, recursive: true });
        }
    });

    it('carries the initialized runtime observation into B03 synthetic metric finalization', async () => {
        const { adapters, rootPath } = await createRtcBaselineRuntimeAdaptersFixture();
        const runtime = createRtcBaselineDenoRuntime(adapters);
        try {
            expect(
                await runtime.initializeBaseline({
                    schema: 'rallar.rtc-baseline.capture-request.v1',
                    baselineId,
                    workloadIds: ['RTC-B03'],
                    environmentId: 'E1-local',
                    retainedSampleMultiplier: 1,
                    repeatLink: null,
                    conditionalEnvironmentDecisions: []
                })
            ).toMatchObject({ ok: true });
            const manifestPath = join(rootPath, 'tmp/perf/rtc-baseline', baselineId, 'manifest.json');
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
            const outerAttempt = manifest.outerAttempts.find(
                (entry: { caseId: string; inputKey: string; }) => entry.caseId === 'topology-star' && entry.inputKey === 'sessions-30'
            );
            manifest.cases = manifest.cases.filter(
                (entry: { caseId: string; inputKey: string; }) => entry.caseId === outerAttempt.caseId && entry.inputKey === outerAttempt.inputKey
            );
            manifest.outerAttempts = [outerAttempt];
            await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
            expect(await runtime.captureWorkload({ baselineId, workloadId: 'RTC-B03' })).toMatchObject({
                ok: true
            });
            const samplePath = join(
                rootPath,
                'tmp/perf/rtc-baseline',
                baselineId,
                'results/samples',
                `${outerAttempt.sampleIds[0]}.json`
            );
            const environmentPath = join(
                rootPath,
                'tmp/perf/rtc-baseline',
                baselineId,
                'environment.json'
            );
            const sample = JSON.parse(await readFile(samplePath, 'utf8'));
            const environment = JSON.parse(await readFile(environmentPath, 'utf8'));
            expect(sample.runtimeObservation).toEqual(environment.observation);
            expect(sample.identity).toEqual({
                sampleId: outerAttempt.sampleIds[0],
                workloadId: outerAttempt.workloadId,
                caseId: outerAttempt.caseId,
                inputKey: outerAttempt.inputKey,
                intendedPhase: outerAttempt.intendedPhase,
                outerOrdinal: outerAttempt.outerOrdinal,
                innerOrdinal: 1
            });
            expect(sample).toMatchObject({
                outcome: 'passed',
                evidenceClass: 'synthetic-path',
                metrics: [{ metric: 'durationMs', unit: 'ms', value: 1 }],
                rawEvidence: null,
                rawReferences: [],
                issues: []
            });
            const finalized = await runtime.finalize({ baselineId });
            expect(finalized).toMatchObject({ ok: true });
        }
        finally {
            await rm(rootPath, { force: true, recursive: true });
        }
    });
});

function createLiveRtcBaselineCaptureRequestFixture(): RtcBaselineCaptureRequestDto {
    return {
        schema: 'rallar.rtc-baseline.capture-request.v1' as const,
        baselineId: '20260816-956a057c9ab5-e3-memory',
        workloadIds: ['RTC-B06'] as const,
        environmentId: 'E3-memory' as const,
        retainedSampleMultiplier: 1 as const,
        repeatLink: null,
        conditionalEnvironmentDecisions: []
    };
}
