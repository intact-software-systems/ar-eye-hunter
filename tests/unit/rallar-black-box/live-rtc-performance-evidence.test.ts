import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    symlink,
    writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it
} from 'vitest';
import type {
    RtcBaselineAttemptLocatorDto,
    RtcBaselineCaptureManifestDto,
    RtcBaselineExternalAttemptDto,
    RtcBaselineOuterAttemptDto
} from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';

import type { LiveRtcAgentDiagnostics } from '../../../tests/playwright/rallar-black-box/live-rtc-agent-diagnostics.ts';
import { normalizeJson, requiredJsonRecord } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';
import {
    buildLiveRtcExternalAttempt,
    buildLiveRtcRetentionCohort,
    liveRtcRetentionStateReturned,
    loadLiveRtcPerformanceAttempt,
    writeLiveRtcPerformanceEvidence,
    writeLiveRtcRetentionCohortIfComplete,
    type LiveRtcPerformanceAttemptContext,
    type LiveRtcPerformanceRawEvidence,
    type LiveRtcRetentionCheckpoint
} from '../../../tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts';

const temporaryDirectories: string[] = [];
const baselineId = '20260829T081500417Z-0123456789ab-e3-memory-local';
const e3DefaultLocator = {
    workloadId: 'RTC-B06',
    caseId: 'default',
    inputKey: 'e3-memory-default',
    intendedPhase: 'retained',
    outerOrdinal: 1,
    environmentId: 'E3-memory',
    rawResultRelativePath: 'artifacts/staging/rtc-b06-default-e3-memory-default-retained-001.json'
} as const;
const e3DefaultIdentity = {
    sampleId: 'rtc-b06-default-e3-memory-default-retained-001-001',
    workloadId: 'RTC-B06',
    caseId: 'default',
    inputKey: 'e3-memory-default',
    intendedPhase: 'retained',
    outerOrdinal: 1,
    innerOrdinal: 1
} as const;
const runtimeObservation = {
    git: {
        headCommit: 'a'.repeat(40),
        headTree: 'b'.repeat(40),
        ref: 'codex/rallar-rtc-performance-baseline-b06',
        clean: true
    },
    runtime: {
        node: 'v24.0.0',
        npm: '11.0.0',
        deno: '2.4.0',
        playwright: '1.55.0',
        chromium: '140.0.0.0'
    },
    host: {
        os: 'darwin',
        kernel: '24.0.0',
        architecture: 'arm64',
        logicalCpuCount: 12,
        cpuModel: 'Apple M4 Pro',
        totalMemoryBytes: 24 * 1024 * 1024 * 1024,
        executionContext: 'local'
    },
    timing: {
        startedAtUtc: '2026-08-29T08:00:00.000Z',
        endedAtUtc: '2026-08-29T08:10:00.000Z',
        monotonicDurationMs: 600_000,
        monotonicSource: 'performance.now'
    },
    deviations: [],
    sourceHashes: [
        {
            path: 'tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts',
            sha256: 'c'.repeat(64),
            kind: 'source'
        }
    ],
    configurationInputs: [],
    resolvedConfiguration: [],
    controllerInputs: [],
    workerCommand: {
        redactedArgv: {
            executable: 'npm',
            arguments: ['run', 'test:rallar:full-stack:memory:live-rtc-3']
        },
        projection: {
            fixedWorkerFlags: [],
            configurationFlags: []
        }
    },
    allowlistedEnvironment: {}
} as const;

function e3CaptureManifest(): RtcBaselineCaptureManifestDto {
    const retentionAttempts = Array.from({ length: 3 }, (_, index) => {
        const outerOrdinal = index + 1;
        const ordinal = String(outerOrdinal).padStart(3, '0');
        return {
            workloadId: 'RTC-B06' as const,
            caseId: 'retention-100',
            inputKey: 'e3-memory-retention-100',
            environmentId: 'E3-memory' as const,
            intendedPhase: 'retained' as const,
            outerOrdinal,
            sampleIds: [
                `rtc-b06-retention-100-e3-memory-retention-100-retained-${ordinal}-001`
            ]
        };
    });
    return {
        schema: 'rallar.rtc-baseline.manifest.v1' as const,
        request: {
            schema: 'rallar.rtc-baseline.capture-request.v1' as const,
            baselineId,
            workloadIds: ['RTC-B06'] as const,
            environmentId: 'E3-memory' as const,
            retainedSampleMultiplier: 1,
            repeatLink: null,
            conditionalEnvironmentDecisions: []
        },
        workloadIds: ['RTC-B06'] as const,
        cases: [
            {
                workloadId: 'RTC-B06' as const,
                caseId: 'default',
                inputKey: 'e3-memory-default'
            },
            {
                workloadId: 'RTC-B06' as const,
                caseId: 'retention-100',
                inputKey: 'e3-memory-retention-100'
            }
        ],
        outerAttempts: [{
            workloadId: 'RTC-B06' as const,
            caseId: 'default',
            inputKey: 'e3-memory-default',
            environmentId: 'E3-memory' as const,
            intendedPhase: 'retained' as const,
            outerOrdinal: 1,
            sampleIds: [e3DefaultIdentity.sampleId]
        }, ...retentionAttempts],
        expectedCohorts: [{
            cohortId: 'rtc-b06-e3-memory-retention',
            workloadId: 'RTC-B06' as const,
            memberSampleIds: retentionAttempts.flatMap((attempt) => attempt.sampleIds)
        }],
        repeatLink: null
    };
}

function externalLocator(
    attempt: RtcBaselineOuterAttemptDto
): RtcBaselineAttemptLocatorDto {
    const ordinal = String(attempt.outerOrdinal).padStart(3, '0');
    return {
        workloadId: attempt.workloadId,
        caseId: attempt.caseId,
        inputKey: attempt.inputKey,
        environmentId: attempt.environmentId,
        intendedPhase: attempt.intendedPhase,
        outerOrdinal: attempt.outerOrdinal,
        rawResultRelativePath: `artifacts/staging/rtc-b06-${attempt.caseId}-${attempt.inputKey}-${attempt.intendedPhase}-${ordinal}.json`
    };
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

function agentDiagnostics(agentId: 'agent-a' | 'agent-b' | 'agent-c'): LiveRtcAgentDiagnostics {
    const peers = ['agent-a', 'agent-b', 'agent-c'].filter(
        (candidate) => candidate !== agentId
    );
    return {
        agentId,
        settledPeerIds: peers,
        readyPeerIds: peers,
        laneStates: peers.map((peerId) => ({
            peerId,
            laneId: 'json',
            isOpen: true,
            isReconnectable: true
        })),
        connectionTimerActive: false,
        peerCount: 2,
        connectedPeerCount: 2,
        relayPeerCount: 0,
        details: {}
    } as const;
}

const defaultTimings: LiveRtcPerformanceRawEvidence['timings'] = [
    {
        kind: 'peer-ready',
        transport: 'realtime',
        senderAgentId: 'agent-a',
        receiverAgentIds: ['agent-b', 'agent-c'],
        durationMs: 12
    },
    {
        kind: 'direct-delivery',
        transport: 'realtime',
        senderAgentId: 'agent-a',
        receiverAgentIds: ['agent-b'],
        durationMs: 4
    },
    {
        kind: 'multicast-delivery',
        transport: 'realtime',
        senderAgentId: 'agent-a',
        receiverAgentIds: ['agent-b', 'agent-c'],
        durationMs: 5
    },
    {
        kind: 'broadcast-delivery',
        transport: 'realtime',
        senderAgentId: 'agent-a',
        receiverAgentIds: ['agent-b', 'agent-c'],
        durationMs: 6
    },
    {
        kind: 'peer-ready',
        transport: 'messages.rtc',
        senderAgentId: 'agent-a',
        receiverAgentIds: ['agent-b', 'agent-c'],
        durationMs: 13
    },
    {
        kind: 'direct-delivery',
        transport: 'messages.rtc',
        senderAgentId: 'agent-a',
        receiverAgentIds: ['agent-b'],
        durationMs: 7
    },
    {
        kind: 'multicast-delivery',
        transport: 'messages.rtc',
        senderAgentId: 'agent-a',
        receiverAgentIds: ['agent-b', 'agent-c'],
        durationMs: 8
    },
    {
        kind: 'broadcast-delivery',
        transport: 'messages.rtc',
        senderAgentId: 'agent-a',
        receiverAgentIds: ['agent-b', 'agent-c'],
        durationMs: 9
    }
];

function defaultRawEvidence(
    overrides: Partial<LiveRtcPerformanceRawEvidence> = {}
): LiveRtcPerformanceRawEvidence {
    return {
        identity: {
            workloadId: 'RTC-B06',
            caseId: 'default',
            inputKey: 'e3-memory-default',
            intendedPhase: 'retained',
            outerOrdinal: 1,
            environmentId: 'E3-memory'
        },
        producer: {
            provider: 'browser-rallar',
            browserCount: 3,
            auth: {
                A: 'login',
                B: 'login',
                C: 'login'
            },
            databaseProvider: 'memory',
            databaseUrl: 'absent',
            iceMode: 'repository-default',
            allScenariosRaw: null,
            retentionSoakRaw: null,
            retentionCyclesRaw: null,
            iceModeRaw: null,
            transports: ['realtime', 'messages.rtc']
        },
        runtime: {
            node: 'v24.0.0',
            playwright: '1.55.0',
            chromium: '140.0.0.0'
        },
        timings: defaultTimings,
        diagnostics: [
            {
                label: 'realtime-final',
                cycle: null,
                agents: [
                    agentDiagnostics('agent-a'),
                    agentDiagnostics('agent-b'),
                    agentDiagnostics('agent-c')
                ]
            }
        ],
        retention: null,
        assertions: {
            matrixPassed: true,
            artifactBundlePassed: true,
            unexpectedDeliveryCount: 0,
            reconnectPassed: null
        },
        ...overrides
    };
}

interface RetentionEvidenceInput {
    environmentId?: 'E3-memory' | 'E4-pg';
    inputKey?: 'e3-memory-retention-100' | 'e4-pg-retention-100';
    outerOrdinal: number;
    cycle0HeapBytes: number;
    finalHeapBytes: number;
    stateReturned?: boolean;
}

function retentionRawEvidence(
    input: RetentionEvidenceInput
): LiveRtcPerformanceRawEvidence {
    const environmentId = input.environmentId ?? 'E3-memory';
    const inputKey = input.inputKey ?? 'e3-memory-retention-100';
    const stateReturned = input.stateReturned ?? true;
    const checkpoints = toRetentionCheckpoints(input);
    return {
        ...defaultRawEvidence(),
        identity: {
            workloadId: 'RTC-B06',
            caseId: 'retention-100',
            inputKey,
            intendedPhase: 'retained',
            outerOrdinal: input.outerOrdinal,
            environmentId
        },
        producer: {
            ...defaultRawEvidence().producer,
            databaseProvider: environmentId === 'E4-pg' ? 'postgres' : 'memory',
            databaseUrl: environmentId === 'E4-pg' ? 'present' : 'absent',
            iceMode: environmentId === 'E4-pg' ? 'local' : 'repository-default',
            retentionSoakRaw: '1',
            retentionCyclesRaw: '100',
            iceModeRaw: environmentId === 'E4-pg' ? 'local' : null
        },
        timings: [
            {
                kind: 'reconnect-ready',
                transport: 'messages.rtc',
                senderAgentId: 'agent-b',
                receiverAgentIds: ['agent-c'],
                durationMs: 14
            }
        ],
        diagnostics: checkpoints.map((checkpoint) => ({
            label: `retention-cycle-${checkpoint.cycle}`,
            cycle: checkpoint.cycle,
            agents: checkpoint.agents
        })),
        retention: {
            cycles: 100,
            checkpoints,
            settledStateReturned: stateReturned
        },
        assertions: {
            matrixPassed: true,
            artifactBundlePassed: true,
            unexpectedDeliveryCount: 0,
            reconnectPassed: true
        }
    };
}

function toRetentionCheckpoints(input: RetentionEvidenceInput): LiveRtcRetentionCheckpoint[] {
    return Array.from({ length: 11 }, (_, index) => {
        const cycle = index * 10;
        const progress = cycle / 100;
        return {
            cycle,
            postGcHeapBytes: Math.round(
                input.cycle0HeapBytes +
                    (input.finalHeapBytes - input.cycle0HeapBytes) * progress
            ),
            agents: [
                agentDiagnostics('agent-a'),
                agentDiagnostics('agent-b'),
                {
                    ...agentDiagnostics('agent-c'),
                    laneStates: cycle === 100 && input.stateReturned === false
                        ? [{
                            peerId: 'agent-b',
                            laneId: 'json',
                            isOpen: false,
                            isReconnectable: true
                        }]
                        : agentDiagnostics('agent-c').laneStates,
                    connectionTimerActive: cycle === 100 && input.stateReturned === false
                }
            ]
        } as const;
    });
}

function retentionAttempt(
    input: Pick<RetentionEvidenceInput, 'outerOrdinal' | 'cycle0HeapBytes' | 'finalHeapBytes' | 'stateReturned'>
): RtcBaselineExternalAttemptDto {
    const ordinal = String(input.outerOrdinal).padStart(3, '0');
    return buildLiveRtcExternalAttempt({
        locator: {
            workloadId: 'RTC-B06',
            caseId: 'retention-100',
            inputKey: 'e3-memory-retention-100',
            intendedPhase: 'retained',
            outerOrdinal: input.outerOrdinal,
            environmentId: 'E3-memory',
            rawResultRelativePath: `artifacts/staging/rtc-b06-retention-100-e3-memory-retention-100-retained-${ordinal}.json`
        },
        sampleIdentity: {
            sampleId: `rtc-b06-retention-100-e3-memory-retention-100-retained-${ordinal}-001`,
            workloadId: 'RTC-B06',
            caseId: 'retention-100',
            inputKey: 'e3-memory-retention-100',
            intendedPhase: 'retained',
            outerOrdinal: input.outerOrdinal,
            innerOrdinal: 1
        },
        producerExitStatus: 0,
        runtimeObservation,
        rawEvidence: retentionRawEvidence(input)
    });
}

describe('live RTC external-attempt evidence', () => {
    it('loads one exact predeclared attempt from the controller environment', async () => {
        const repoRoot = await mkdtemp(join(tmpdir(), 'rallar-rtc-b06-context-'));
        temporaryDirectories.push(repoRoot);
        const manifest = e3CaptureManifest();
        const locator = e3DefaultLocator;
        const baselineRoot = join(repoRoot, 'tmp', 'perf', 'rtc-baseline', baselineId);
        await mkdir(baselineRoot, { recursive: true });
        await writeFile(join(baselineRoot, 'manifest.json'), JSON.stringify(manifest));
        await writeFile(
            join(baselineRoot, 'environment.json'),
            JSON.stringify({
                schema: 'rallar.rtc-baseline.environment.v1',
                baselineId,
                workloadIds: ['RTC-B06'],
                environmentId: 'E3-memory',
                repeatLink: null,
                conditionalEnvironmentDecisions: [],
                observation: runtimeObservation
            })
        );

        const context = await loadLiveRtcPerformanceAttempt({
            repoRoot,
            environment: {
                RALLAR_BLACK_BOX_RTC_BASELINE_ID: baselineId,
                RALLAR_BLACK_BOX_RTC_CASE_ID: locator.caseId,
                RALLAR_BLACK_BOX_RTC_INPUT_KEY: locator.inputKey,
                RALLAR_BLACK_BOX_RTC_INTENDED_PHASE: locator.intendedPhase,
                RALLAR_BLACK_BOX_RTC_OUTER_ORDINAL: String(locator.outerOrdinal)
            }
        });

        expect(context).toMatchObject({
            repoRoot,
            baselineId,
            locator,
            sampleIdentity: e3DefaultIdentity,
            runtimeObservation
        });
        await expect(loadLiveRtcPerformanceAttempt({
            repoRoot,
            environment: {
                RALLAR_BLACK_BOX_RTC_BASELINE_ID: baselineId
            }
        })).rejects.toThrow(/missing/i);
        await expect(loadLiveRtcPerformanceAttempt({
            repoRoot,
            environment: {
                RALLAR_BLACK_BOX_RTC_BASELINE_ID: baselineId,
                RALLAR_BLACK_BOX_RTC_CASE_ID: locator.caseId,
                RALLAR_BLACK_BOX_RTC_INPUT_KEY: locator.inputKey,
                RALLAR_BLACK_BOX_RTC_INTENDED_PHASE: locator.intendedPhase,
                RALLAR_BLACK_BOX_RTC_OUTER_ORDINAL: '1x'
            }
        })).rejects.toThrow(/positive integer/i);
        await expect(loadLiveRtcPerformanceAttempt({
            repoRoot,
            environment: {
                RALLAR_BLACK_BOX_RTC_BASELINE_ID: '../outside',
                RALLAR_BLACK_BOX_RTC_CASE_ID: locator.caseId,
                RALLAR_BLACK_BOX_RTC_INPUT_KEY: locator.inputKey,
                RALLAR_BLACK_BOX_RTC_INTENDED_PHASE: locator.intendedPhase,
                RALLAR_BLACK_BOX_RTC_OUTER_ORDINAL: String(locator.outerOrdinal)
            }
        })).rejects.toThrow(/canonical/i);
        await expect(loadLiveRtcPerformanceAttempt({
            repoRoot,
            environment: {}
        })).resolves.toBeNull();
    });

    it('accepts the GitHub-provenanced E3 observation identity', async () => {
        const repoRoot = await mkdtemp(join(tmpdir(), 'rallar-rtc-b06-github-context-'));
        temporaryDirectories.push(repoRoot);
        const githubBaselineId = '20260830T100000Z-c0cadb8216cf-e3-memory-gh987654321-a3';
        const manifest = {
            ...e3CaptureManifest(),
            request: {
                ...e3CaptureManifest().request,
                baselineId: githubBaselineId
            }
        };
        const baselineRoot = join(
            repoRoot,
            'tmp',
            'perf',
            'rtc-baseline',
            githubBaselineId
        );
        await mkdir(baselineRoot, { recursive: true });
        await writeFile(join(baselineRoot, 'manifest.json'), JSON.stringify(manifest));
        await writeFile(
            join(baselineRoot, 'environment.json'),
            JSON.stringify({
                schema: 'rallar.rtc-baseline.environment.v1',
                baselineId: githubBaselineId,
                workloadIds: ['RTC-B06'],
                environmentId: 'E3-memory',
                repeatLink: null,
                conditionalEnvironmentDecisions: [],
                observation: runtimeObservation
            })
        );

        await expect(loadLiveRtcPerformanceAttempt({
            repoRoot,
            environment: {
                RALLAR_BLACK_BOX_RTC_BASELINE_ID: githubBaselineId,
                RALLAR_BLACK_BOX_RTC_CASE_ID: e3DefaultLocator.caseId,
                RALLAR_BLACK_BOX_RTC_INPUT_KEY: e3DefaultLocator.inputKey,
                RALLAR_BLACK_BOX_RTC_INTENDED_PHASE: e3DefaultLocator.intendedPhase,
                RALLAR_BLACK_BOX_RTC_OUTER_ORDINAL: String(e3DefaultLocator.outerOrdinal)
            }
        })).resolves.toMatchObject({ baselineId: githubBaselineId });
    });

    it('preserves exact identity plus complete E3 default facts and timing samples', () => {
        const attempt = buildLiveRtcExternalAttempt({
            locator: e3DefaultLocator,
            sampleIdentity: e3DefaultIdentity,
            producerExitStatus: 0,
            runtimeObservation,
            rawEvidence: defaultRawEvidence()
        });

        expect(attempt.schema).toBe('rallar.rtc-baseline.external-attempt.v1');
        expect(attempt.locator).toEqual(e3DefaultLocator);
        expect(attempt.producerFacts).toEqual({
            databaseUrl: 'absent',
            allScenariosPresent: false,
            allScenariosRaw: null,
            retentionSoakPresent: false,
            retentionSoakRaw: null,
            retentionCyclesPresent: false,
            retentionCyclesRaw: null,
            iceModePresent: false,
            iceModeRaw: null
        });
        expect(attempt.samples).toHaveLength(1);
        expect(attempt.samples[0]).toMatchObject({
            identity: e3DefaultIdentity,
            outcome: 'passed',
            evidenceClass: 'local-full-stack',
            runtimeObservation
        });
        expect(attempt.samples[0]?.rawEvidence).toEqual(defaultRawEvidence());
        expect(attempt.samples[0]?.metrics).toEqual([
            { metric: 'peer-ready.realtime', unit: 'milliseconds', value: 12 },
            { metric: 'direct-delivery.realtime', unit: 'milliseconds', value: 4 },
            { metric: 'multicast-delivery.realtime', unit: 'milliseconds', value: 5 },
            { metric: 'broadcast-delivery.realtime', unit: 'milliseconds', value: 6 },
            { metric: 'peer-ready.messages-rtc', unit: 'milliseconds', value: 13 },
            { metric: 'direct-delivery.messages-rtc', unit: 'milliseconds', value: 7 },
            { metric: 'multicast-delivery.messages-rtc', unit: 'milliseconds', value: 8 },
            { metric: 'broadcast-delivery.messages-rtc', unit: 'milliseconds', value: 9 }
        ]);
    });

    it('fails evidence when one transport timing series is incomplete', () => {
        const rawEvidence = defaultRawEvidence();
        const attempt = buildLiveRtcExternalAttempt({
            locator: e3DefaultLocator,
            sampleIdentity: e3DefaultIdentity,
            producerExitStatus: 0,
            runtimeObservation,
            rawEvidence: {
                ...rawEvidence,
                timings: rawEvidence.timings.filter((timing) => timing.kind !== 'direct-delivery' || timing.transport !== 'messages.rtc')
            }
        });

        expect(attempt.samples[0]?.outcome).toBe('failed');
        expect(attempt.samples[0]?.issues).toContainEqual({
            path: '$.rawEvidence.timings',
            code: 'missing-receiver-timing',
            message: 'Receiver-observed direct-delivery timing is required for messages.rtc.'
        });
    });

    it('fails evidence when a diagnostic checkpoint omits one browser agent', () => {
        const rawEvidence = defaultRawEvidence();
        const attempt = buildLiveRtcExternalAttempt({
            locator: e3DefaultLocator,
            sampleIdentity: e3DefaultIdentity,
            producerExitStatus: 0,
            runtimeObservation,
            rawEvidence: {
                ...rawEvidence,
                diagnostics: rawEvidence.diagnostics.map((checkpoint) => ({
                    ...checkpoint,
                    agents: checkpoint.agents.slice(0, 2)
                }))
            }
        });

        expect(attempt.samples[0]?.issues).toContainEqual({
            path: '$.rawEvidence.diagnostics',
            code: 'incomplete-rtc-diagnostics',
            message: 'Every RTC diagnostics checkpoint must contain three distinct browser agents.'
        });
    });

    it('accepts DATABASE_URL presence in E3 without treating it as the active provider', () => {
        const rawEvidence = defaultRawEvidence({
            producer: {
                ...defaultRawEvidence().producer,
                databaseUrl: 'present'
            }
        });
        const attempt = buildLiveRtcExternalAttempt({
            locator: e3DefaultLocator,
            sampleIdentity: e3DefaultIdentity,
            producerExitStatus: 0,
            runtimeObservation,
            rawEvidence
        });

        expect(attempt.producerFacts.databaseUrl).toBe('present');
        expect(attempt.samples[0]?.outcome).toBe('passed');
    });

    it('fails retention evidence whose checkpoints repeat an agent identity', () => {
        const rawEvidence = retentionRawEvidence({
            outerOrdinal: 1,
            cycle0HeapBytes: 100,
            finalHeapBytes: 100
        });
        const duplicateAgentCheckpoints = rawEvidence.retention!.checkpoints.map(
            (checkpoint) => ({
                ...checkpoint,
                agents: [
                    checkpoint.agents[0]!,
                    checkpoint.agents[0]!,
                    checkpoint.agents[2]!
                ]
            })
        );
        const attempt = buildLiveRtcExternalAttempt({
            locator: {
                workloadId: 'RTC-B06',
                caseId: 'retention-100',
                inputKey: 'e3-memory-retention-100',
                intendedPhase: 'retained',
                outerOrdinal: 1,
                environmentId: 'E3-memory',
                rawResultRelativePath: 'artifacts/staging/rtc-b06-retention-100-e3-memory-retention-100-retained-001.json'
            },
            sampleIdentity: {
                sampleId: 'rtc-b06-retention-100-e3-memory-retention-100-retained-001-001',
                workloadId: 'RTC-B06',
                caseId: 'retention-100',
                inputKey: 'e3-memory-retention-100',
                intendedPhase: 'retained',
                outerOrdinal: 1,
                innerOrdinal: 1
            },
            producerExitStatus: 0,
            runtimeObservation,
            rawEvidence: {
                ...rawEvidence,
                diagnostics: duplicateAgentCheckpoints.map((checkpoint) => ({
                    label: `retention-cycle-${checkpoint.cycle}`,
                    cycle: checkpoint.cycle,
                    agents: checkpoint.agents
                })),
                retention: {
                    ...rawEvidence.retention!,
                    checkpoints: duplicateAgentCheckpoints
                }
            }
        });

        expect(attempt.samples[0]?.issues).toContainEqual({
            path: '$.rawEvidence.retention.checkpoints',
            code: 'invalid-retention-checkpoints',
            message: 'Retention requires cycle 0 and every tenth cycle through 100 with three distinct agents and post-GC facts.'
        });
    });

    it('binds E4 all-scenarios facts and requires reconnect evidence', () => {
        const rawEvidence = defaultRawEvidence({
            identity: {
                workloadId: 'RTC-B06',
                caseId: 'all-scenarios',
                inputKey: 'e4-pg-all-scenarios',
                intendedPhase: 'warmup',
                outerOrdinal: 1,
                environmentId: 'E4-pg'
            },
            producer: {
                ...defaultRawEvidence().producer,
                databaseProvider: 'postgres',
                databaseUrl: 'present',
                iceMode: 'local',
                allScenariosRaw: '1',
                iceModeRaw: 'local'
            },
            timings: [
                ...defaultRawEvidence().timings,
                {
                    kind: 'reconnect-ready',
                    transport: 'messages.rtc',
                    senderAgentId: 'agent-b',
                    receiverAgentIds: ['agent-c'],
                    durationMs: 18
                }
            ],
            assertions: {
                ...defaultRawEvidence().assertions,
                reconnectPassed: true
            }
        });
        const attempt = buildLiveRtcExternalAttempt({
            locator: {
                workloadId: 'RTC-B06',
                caseId: 'all-scenarios',
                inputKey: 'e4-pg-all-scenarios',
                intendedPhase: 'warmup',
                outerOrdinal: 1,
                environmentId: 'E4-pg',
                rawResultRelativePath: 'artifacts/staging/rtc-b06-all-scenarios-e4-pg-all-scenarios-warmup-001.json'
            },
            sampleIdentity: {
                sampleId: 'rtc-b06-all-scenarios-e4-pg-all-scenarios-warmup-001-001',
                workloadId: 'RTC-B06',
                caseId: 'all-scenarios',
                inputKey: 'e4-pg-all-scenarios',
                intendedPhase: 'warmup',
                outerOrdinal: 1,
                innerOrdinal: 1
            },
            producerExitStatus: 0,
            runtimeObservation,
            rawEvidence
        });

        expect(attempt.producerFacts).toEqual({
            databaseUrl: 'present',
            allScenariosPresent: true,
            allScenariosRaw: '1',
            retentionSoakPresent: false,
            retentionSoakRaw: null,
            retentionCyclesPresent: false,
            retentionCyclesRaw: null,
            iceModePresent: true,
            iceModeRaw: 'local'
        });
        expect(attempt.samples[0]?.metrics).toContainEqual({
            metric: 'reconnect-ready.messages-rtc',
            unit: 'milliseconds',
            value: 18
        });
        expect(attempt.samples[0]?.outcome).toBe('passed');
    });

    it('lets a nonzero producer status override valid-looking matrix evidence', () => {
        const attempt = buildLiveRtcExternalAttempt({
            locator: e3DefaultLocator,
            sampleIdentity: e3DefaultIdentity,
            producerExitStatus: 7,
            runtimeObservation,
            rawEvidence: defaultRawEvidence()
        });

        expect(attempt.sampleOutcomes[0]?.outcome).toBe('failed');
        expect(attempt.sampleOutcomes[0]?.issues[0]).toEqual({
            path: '$.producerExitStatus',
            code: 'producer-failed',
            message: 'The live RTC producer exited with status 7.'
        });
    });

    it('rejects locator, raw identity, sample identity, and runtime mismatches', () => {
        expect(() =>
            buildLiveRtcExternalAttempt({
                locator: e3DefaultLocator,
                sampleIdentity: {
                    ...e3DefaultIdentity,
                    outerOrdinal: 2
                },
                producerExitStatus: 0,
                runtimeObservation,
                rawEvidence: defaultRawEvidence()
            })
        ).toThrow(/sample identity/i);

        expect(() =>
            buildLiveRtcExternalAttempt({
                locator: e3DefaultLocator,
                sampleIdentity: e3DefaultIdentity,
                producerExitStatus: 0,
                runtimeObservation,
                rawEvidence: defaultRawEvidence({
                    identity: {
                        ...defaultRawEvidence().identity,
                        environmentId: 'E4-pg'
                    }
                })
            })
        ).toThrow(/raw evidence identity/i);

        expect(() =>
            buildLiveRtcExternalAttempt({
                locator: e3DefaultLocator,
                sampleIdentity: e3DefaultIdentity,
                producerExitStatus: 0,
                runtimeObservation,
                rawEvidence: defaultRawEvidence({
                    runtime: {
                        ...defaultRawEvidence().runtime,
                        chromium: 'different-browser'
                    }
                })
            })
        ).toThrow(/runtime facts/i);
    });
});

describe('live RTC retention cohort evidence', () => {
    it('detects state drift at an intermediate settled checkpoint', () => {
        const retention = retentionRawEvidence({
            outerOrdinal: 1,
            cycle0HeapBytes: 100,
            finalHeapBytes: 100
        }).retention!;
        const checkpoints = retention.checkpoints.map((checkpoint) =>
            checkpoint.cycle === 50
                ? {
                    ...checkpoint,
                    agents: checkpoint.agents.map((agent) =>
                        agent.agentId === 'agent-c'
                            ? { ...agent, connectionTimerActive: true }
                            : agent
                    )
                }
                : checkpoint
        );

        expect(liveRtcRetentionStateReturned(checkpoints)).toBe(false);
    });

    it('uses exact retained membership and applies the primary two-of-three heap rule', () => {
        const attempts = [
            retentionAttempt({
                outerOrdinal: 1,
                cycle0HeapBytes: 100 * 1024 * 1024,
                finalHeapBytes: 117 * 1024 * 1024
            }),
            retentionAttempt({
                outerOrdinal: 2,
                cycle0HeapBytes: 100 * 1024 * 1024,
                finalHeapBytes: 116 * 1024 * 1024
            }),
            retentionAttempt({
                outerOrdinal: 3,
                cycle0HeapBytes: 100 * 1024 * 1024,
                finalHeapBytes: 104 * 1024 * 1024
            })
        ];
        const memberSampleIds = attempts.map(
            (attempt) => attempt.samples[0]!.identity.sampleId
        );
        const cohort = buildLiveRtcRetentionCohort({
            identity: {
                cohortId: 'rtc-b06-e3-memory-retention',
                workloadId: 'RTC-B06',
                memberSampleIds
            },
            attempts
        });

        expect(cohort.schema).toBe('rallar.rtc-baseline.external-cohort.v1');
        expect(cohort.identity.memberSampleIds).toEqual(memberSampleIds);
        expect(cohort.outcome).toBe('failed');
        expect(cohort.rawEvidence).toEqual({
            retainedAttemptCount: 3,
            requiredHeapBreachCount: 2,
            heapBreachingSampleIds: memberSampleIds.slice(0, 2),
            stateDriftSampleIds: [],
            failedMemberSampleIds: []
        });
    });

    it('fails immediately for settled peer, lane, or timer drift', () => {
        const attempts = [
            retentionAttempt({
                outerOrdinal: 1,
                cycle0HeapBytes: 100,
                finalHeapBytes: 100,
                stateReturned: false
            }),
            retentionAttempt({ outerOrdinal: 2, cycle0HeapBytes: 100, finalHeapBytes: 100 }),
            retentionAttempt({ outerOrdinal: 3, cycle0HeapBytes: 100, finalHeapBytes: 100 })
        ];
        const memberSampleIds = attempts.map(
            (attempt) => attempt.samples[0]!.identity.sampleId
        );
        const cohort = buildLiveRtcRetentionCohort({
            identity: {
                cohortId: 'rtc-b06-e3-memory-retention',
                workloadId: 'RTC-B06',
                memberSampleIds
            },
            attempts
        });

        expect(cohort.outcome).toBe('failed');
        expect(cohort.rawEvidence).toMatchObject({
            heapBreachingSampleIds: [],
            stateDriftSampleIds: [memberSampleIds[0]],
            failedMemberSampleIds: [memberSampleIds[0]]
        });
    });

    it('uses four-of-six heap breaches for a doubled repeat cohort', () => {
        const attempts = Array.from({ length: 6 }, (_, index) =>
            retentionAttempt({
                outerOrdinal: index + 1,
                cycle0HeapBytes: 100 * 1024 * 1024,
                finalHeapBytes: (index < 3 ? 116 : 104) * 1024 * 1024
            }));
        const memberSampleIds = attempts.map(
            (attempt) => attempt.samples[0]!.identity.sampleId
        );
        const cohort = buildLiveRtcRetentionCohort({
            identity: {
                cohortId: 'rtc-b06-e3-memory-retention',
                workloadId: 'RTC-B06',
                memberSampleIds
            },
            attempts
        });

        expect(cohort.outcome).toBe('passed');
        expect(cohort.rawEvidence).toMatchObject({
            retainedAttemptCount: 6,
            requiredHeapBreachCount: 4,
            heapBreachingSampleIds: memberSampleIds.slice(0, 3)
        });
    });

    it('writes the predeclared cohort only after the final retained attempt is staged', async () => {
        const repoRoot = await mkdtemp(join(tmpdir(), 'rallar-rtc-b06-cohort-'));
        temporaryDirectories.push(repoRoot);
        const manifest = e3CaptureManifest();
        const baselineRoot = join(repoRoot, 'tmp', 'perf', 'rtc-baseline', baselineId);
        await mkdir(baselineRoot, { recursive: true });
        await writeFile(join(baselineRoot, 'manifest.json'), JSON.stringify(manifest));
        const locators = manifest.outerAttempts.filter(
            (attempt) =>
                attempt.caseId === 'retention-100' &&
                attempt.intendedPhase === 'retained'
        ).map(externalLocator);
        const attempts = locators.map((locator) =>
            retentionAttempt({
                outerOrdinal: locator.outerOrdinal,
                cycle0HeapBytes: 100 * 1024 * 1024,
                finalHeapBytes: 104 * 1024 * 1024
            })
        );
        const context = (index: number): LiveRtcPerformanceAttemptContext => ({
            repoRoot,
            baselineId,
            locator: {
                ...locators[index]!,
                workloadId: 'RTC-B06',
                caseId: 'retention-100',
                inputKey: 'e3-memory-retention-100',
                intendedPhase: 'retained',
                environmentId: 'E3-memory'
            },
            sampleIdentity: attempts[index]!.samples[0]!.identity,
            runtimeObservation
        });
        for (const attempt of attempts.slice(0, 2)) {
            await writeLiveRtcPerformanceEvidence({
                repoRoot,
                baselineId,
                relativePath: attempt.locator.rawResultRelativePath,
                evidence: attempt
            });
        }

        await expect(writeLiveRtcRetentionCohortIfComplete(context(1))).resolves.toBeNull();
        await writeLiveRtcPerformanceEvidence({
            repoRoot,
            baselineId,
            relativePath: attempts[2]!.locator.rawResultRelativePath,
            evidence: attempts[2]!
        });
        const cohortPath = await writeLiveRtcRetentionCohortIfComplete(context(2));
        const cohort = requiredJsonRecord(normalizeJson(JSON.parse(await readFile(cohortPath!, 'utf8'))), '$.cohort');

        expect(cohortPath).toBe(join(
            await realpath(repoRoot),
            'tmp',
            'perf',
            'rtc-baseline',
            baselineId,
            'artifacts',
            'staging',
            'rtc-b06-e3-memory-retention.json'
        ));
        expect(cohort.schema).toBe('rallar.rtc-baseline.external-cohort.v1');
        expect(cohort).toMatchObject({
            identity: manifest.expectedCohorts[0],
            outcome: 'passed',
            rawEvidence: {
                retainedAttemptCount: 3,
                requiredHeapBreachCount: 2
            }
        });
    });
});

describe('live RTC staged evidence writer', () => {
    it('creates one confined file and refuses overwrite or traversal', async () => {
        const repoRoot = await mkdtemp(join(tmpdir(), 'rallar-rtc-b06-'));
        temporaryDirectories.push(repoRoot);
        const attempt = buildLiveRtcExternalAttempt({
            locator: e3DefaultLocator,
            sampleIdentity: e3DefaultIdentity,
            producerExitStatus: 0,
            runtimeObservation,
            rawEvidence: defaultRawEvidence()
        });

        const absolutePath = await writeLiveRtcPerformanceEvidence({
            repoRoot,
            baselineId,
            relativePath: e3DefaultLocator.rawResultRelativePath,
            evidence: attempt
        });

        expect(normalizeJson(JSON.parse(await readFile(absolutePath, 'utf8')))).toEqual(attempt);
        await expect(writeLiveRtcPerformanceEvidence({
            repoRoot,
            baselineId,
            relativePath: e3DefaultLocator.rawResultRelativePath,
            evidence: attempt
        })).rejects.toMatchObject({ code: 'EEXIST' });
        await expect(writeLiveRtcPerformanceEvidence({
            repoRoot,
            baselineId,
            relativePath: '../escaped.json',
            evidence: attempt
        })).rejects.toThrow(/confined/i);
        await expect(writeLiveRtcPerformanceEvidence({
            repoRoot,
            baselineId,
            relativePath: 'artifacts/staging/../escaped.json',
            evidence: attempt
        })).rejects.toThrow(/confined/i);
    });

    it('rejects a symlinked staging directory', async () => {
        const repoRoot = await mkdtemp(join(tmpdir(), 'rallar-rtc-b06-symlink-'));
        temporaryDirectories.push(repoRoot);
        const baselineRoot = join(repoRoot, 'tmp', 'perf', 'rtc-baseline', baselineId);
        const outside = join(repoRoot, 'outside');
        await mkdir(join(baselineRoot, 'artifacts'), { recursive: true });
        await mkdir(outside);
        await symlink(outside, join(baselineRoot, 'artifacts', 'staging'));
        const attempt = buildLiveRtcExternalAttempt({
            locator: e3DefaultLocator,
            sampleIdentity: e3DefaultIdentity,
            producerExitStatus: 0,
            runtimeObservation,
            rawEvidence: defaultRawEvidence()
        });

        await expect(writeLiveRtcPerformanceEvidence({
            repoRoot,
            baselineId,
            relativePath: e3DefaultLocator.rawResultRelativePath,
            evidence: attempt
        })).rejects.toThrow(/unsafe/i);
    });
});
