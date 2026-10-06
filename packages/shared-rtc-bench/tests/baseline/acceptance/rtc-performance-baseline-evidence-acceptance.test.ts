import { describe, expect, it } from 'vitest';

import { createRtcBaselineEvidenceAcceptance } from '../../../baseline/acceptance/rtc-baseline-evidence-acceptance.ts';
import type { RtcBaselineAcceptedArtifact } from '../../../baseline/acceptance/rtc-baseline-failure-accounting.ts';
import type {
    RtcBaselineCaptureManifestDto,
    RtcBaselineExternalAttemptDto,
    RtcBaselineExternalCohortDto,
    RtcBaselineJson,
    RtcBaselineOuterAttemptDto,
    RtcBaselineRecordAttemptInputDto,
    RtcBaselineResolvedConfigurationValueDto,
    RtcBaselineResult,
    RtcBaselineSampleIdentityDto
} from '../../../baseline/contracts/rtc-baseline-contracts.ts';
import { normalizeRtcBaselineJson } from '../../../baseline/contracts/rtc-baseline-decoding.ts';

type RtcBaselineEvidenceAcceptanceDependencies = Parameters<typeof createRtcBaselineEvidenceAcceptance>[0];

const firstIdentity = {
    sampleId: 'rtc-b01-case-input-retained-001-001',
    workloadId: 'RTC-B01',
    caseId: 'case',
    inputKey: 'input',
    intendedPhase: 'retained',
    outerOrdinal: 1,
    innerOrdinal: 1
} as const;
const secondIdentity = {
    ...firstIdentity,
    sampleId: 'rtc-b01-case-input-retained-001-002',
    innerOrdinal: 2
} as const;
function passedSample(
    identity: RtcBaselineSampleIdentityDto,
    evidenceClass: 'synthetic-path' | 'native-browser' | 'local-full-stack' = 'synthetic-path'
) {
    return {
        schema: 'rallar.rtc-baseline.sample.v1' as const,
        identity,
        outcome: 'passed' as const,
        evidenceClass,
        metrics: [{ metric: 'durationMs', unit: 'ms', value: 1 }],
        rawEvidence: { durationMs: 1 },
        rawReferences: [],
        issues: [],
        runtimeObservation: null
    };
}
const passedFirst = passedSample(firstIdentity);
const passedSecond = passedSample(secondIdentity);
const thirdIdentity = {
    ...firstIdentity,
    sampleId: 'rtc-b01-case-input-retained-002-001',
    outerOrdinal: 2
} as const;
const passedThird = passedSample(thirdIdentity);
const attempt = {
    workloadId: 'RTC-B01' as const,
    caseId: 'case',
    inputKey: 'input',
    environmentId: 'E1-local' as const,
    intendedPhase: 'retained' as const,
    outerOrdinal: 1,
    sampleIds: ['rtc-b01-case-input-retained-001-001', 'rtc-b01-case-input-retained-001-002']
};
const secondAttempt = {
    ...attempt,
    outerOrdinal: 2,
    sampleIds: ['rtc-b01-case-input-retained-002-001']
};
const manifest: RtcBaselineCaptureManifestDto = {
    schema: 'rallar.rtc-baseline.manifest.v1' as const,
    request: {
        schema: 'rallar.rtc-baseline.capture-request.v1' as const,
        baselineId: '20260807-0123456789ab-e1-local',
        workloadIds: ['RTC-B01'] as const,
        environmentId: 'E1-local' as const,
        retainedSampleMultiplier: 1 as const,
        repeatLink: null,
        conditionalEnvironmentDecisions: []
    },
    workloadIds: ['RTC-B01'] as const,
    cases: [],
    outerAttempts: [attempt],
    expectedCohorts: [],
    repeatLink: null
};

function dependencies(overrides: Partial<RtcBaselineEvidenceAcceptanceDependencies> = {}) {
    return {
        initializeStore: async () => ({ ok: true as const, value: undefined }),
        readManifest: async () => ({ ok: true as const, value: manifest }),
        readInitializedConfiguration: async () => ({ ok: true as const, value: [] }),
        writeAcceptedArtifact: async () => ({ ok: true as const, value: undefined }),
        readStagedJson: async () => ({ ok: false as const, issues: [] }),
        runFreshWorker: async () => ({ outcomes: [] }),
        reconcileAcceptedOperation: async () => [],
        ...overrides
    };
}

const captureRequest = { baselineId: manifest.request.baselineId, workloadId: 'RTC-B01' as const };
const producerIssue = {
    path: '$.producerExitStatus',
    code: 'producer-exit-status',
    message: 'Producer exited with status 9.'
};
const syntheticOwnership = 'Synthetic workloads must enter through capture.';
const browserOwnership = 'Native-browser workloads must enter through record-browser.';
const externalOwnership = 'Local-full-stack workloads must enter through external ingestion.';

function collectWrites(writes: RtcBaselineAcceptedArtifact[]) {
    return async (_baselineId: string, artifact: RtcBaselineAcceptedArtifact) => {
        writes.push(artifact);
        return { ok: true as const, value: undefined };
    };
}

function rejected(path: string, code: string, message: string) {
    return { ok: false, issues: [{ path, code, message }] };
}

function manifestFor(workloadId: 'RTC-B05' | 'RTC-B06'): RtcBaselineCaptureManifestDto {
    const browser = workloadId === 'RTC-B05';
    const baselineId = browser
        ? '20260807-0123456789ab-e2-browser'
        : '20260807-0123456789ab-e3-memory';
    return {
        ...manifest,
        request: {
            ...manifest.request,
            baselineId,
            workloadIds: [workloadId],
            environmentId: browser ? 'E2-browser' : 'E3-memory'
        },
        workloadIds: [workloadId],
        outerAttempts: [
            {
                ...attempt,
                workloadId,
                caseId: browser ? 'browser-data-channel-lifecycle' : 'case',
                inputKey: browser ? 'iterations-25' : 'input',
                environmentId: browser ? 'E2-browser' : 'E3-memory',
                sampleIds: [
                    browser
                        ? 'rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-001-001'
                        : 'rtc-b06-case-input-retained-001-001'
                ]
            }
        ]
    };
}

function externalInput(
    workloadId: 'RTC-B01' | 'RTC-B05' | 'RTC-B06'
): RtcBaselineRecordAttemptInputDto {
    const browser = workloadId === 'RTC-B05';
    return {
        baselineId: browser
            ? '20260807-0123456789ab-e2-browser'
            : workloadId === 'RTC-B06'
            ? '20260807-0123456789ab-e3-memory'
            : manifest.request.baselineId,
        locator: {
            workloadId,
            caseId: browser ? 'browser-data-channel-lifecycle' : 'case',
            inputKey: browser ? 'iterations-25' : 'input',
            intendedPhase: 'retained' as const,
            outerOrdinal: 1
        },
        producerExitStatus: 0,
        rawResultRelativePath: 'artifacts/staging/result.json'
    };
}

function stagedExternalAttempt(): RtcBaselineExternalAttemptDto {
    const workloadId = 'RTC-B06' as const;
    const input = externalInput(workloadId);
    const manifest = manifestFor(workloadId);
    const outer = manifest.outerAttempts[0]!;
    const identity = {
        sampleId: outer.sampleIds[0]!,
        workloadId,
        caseId: outer.caseId,
        inputKey: outer.inputKey,
        intendedPhase: 'retained' as const,
        outerOrdinal: 1,
        innerOrdinal: 1
    };
    return {
        schema: 'rallar.rtc-baseline.external-attempt.v1',
        locator: {
            ...input.locator,
            environmentId: outer.environmentId,
            rawResultRelativePath: input.rawResultRelativePath
        },
        producerExitStatus: 0,
        producerFacts: {
            databaseUrl: 'absent',
            allScenariosPresent: false,
            allScenariosRaw: null,
            retentionSoakPresent: false,
            retentionSoakRaw: null,
            retentionCyclesPresent: false,
            retentionCyclesRaw: null,
            iceModePresent: false,
            iceModeRaw: null
        },
        sampleOutcomes: [
            {
                identity,
                outcome: 'passed',
                issues: []
            }
        ],
        samples: [passedSample(identity, 'local-full-stack')],
        issues: []
    };
}

function normalizeStagedJson(value: object): RtcBaselineJson {
    const normalized = normalizeRtcBaselineJson(value);
    if (!normalized.ok) {
        throw new Error(`Test fixture is not valid JSON: ${JSON.stringify(normalized.issues)}`);
    }
    return normalized.value;
}

describe('RTC baseline evidence acceptance', () => {
    it.each(['empty', 'other-case'] as const)(
        'refuses new B06 admission with %s configuration and accounts every remaining owner once',
        async (configurationKind) => {
            const staged = stagedExternalAttempt();
            const original = {
                ...staged.samples[0]!,
                rawEvidence: {
                    durationMs: 1,
                    rtcConnectCaptures: [{
                        receipt: {
                            configuration: { mode: 'native', origin: 'step' },
                            application: { status: 'applied', mode: 'native' },
                            configurationVersion: 1,
                            connectionId: { status: 'observed', value: 'completed-connect' },
                            nativeScopeId: { status: 'unavailable', reason: 'unsupported' },
                            nativeAvailability: { status: 'unavailable', reason: 'unsupported' },
                            nativeCoverage: 'unavailable'
                        }
                    }]
                }
            };
            const laterIdentities = [
                { ...original.identity, sampleId: 'rtc-b06-case-input-retained-001-002', innerOrdinal: 2 },
                { ...original.identity, sampleId: 'rtc-b06-case-input-retained-002-001', outerOrdinal: 2 },
                { ...original.identity, sampleId: 'rtc-b06-other-case-input-retained-001-001', caseId: 'other-case' }
            ];
            const firstOuter = manifestFor('RTC-B06').outerAttempts[0]!;
            const cohort = {
                cohortId: 'rtc-b06-e3-memory-retention',
                workloadId: 'RTC-B06' as const,
                memberSampleIds: [original.identity.sampleId, ...laterIdentities.map((identity) => identity.sampleId)]
            };
            const currentManifest: RtcBaselineCaptureManifestDto = {
                ...manifestFor('RTC-B06'),
                outerAttempts: [
                    { ...firstOuter, sampleIds: [original.identity.sampleId, laterIdentities[0]!.sampleId] },
                    { ...firstOuter, outerOrdinal: 2, sampleIds: [laterIdentities[1]!.sampleId] },
                    { ...firstOuter, caseId: 'other-case', sampleIds: [laterIdentities[2]!.sampleId] }
                ],
                expectedCohorts: [cohort]
            };
            const configuration: RtcBaselineResolvedConfigurationValueDto[] = configurationKind === 'empty' ? [] : [{
                caseKey: { workloadId: 'RTC-B06', caseId: 'other-case', inputKey: 'input' },
                field: 'rtcCaptureMode',
                value: 'native',
                source: 'cli'
            }];
            const writes: RtcBaselineAcceptedArtifact[] = [];
            const service = createRtcBaselineEvidenceAcceptance(dependencies({
                readManifest: async () => ({ ok: true, value: currentManifest }),
                readInitializedConfiguration: async () => ({ ok: true, value: configuration }),
                readStagedJson: async () => ({
                    ok: true,
                    value: normalizeStagedJson({
                        ...staged,
                        samples: [original, { ...original, identity: laterIdentities[0] }],
                        sampleOutcomes: [staged.sampleOutcomes[0], { identity: laterIdentities[0], outcome: 'passed', issues: [] }]
                    })
                }),
                writeAcceptedArtifact: collectWrites(writes)
            }));
            const result = await service.recordExternalAttempt(externalInput('RTC-B06'));
            expect(result).toMatchObject({ ok: false, issues: [{ code: 'missing-capture-admission' }] });
            const failureId = `failure-sample-${original.identity.sampleId}`;
            expect(writes).toHaveLength(5);
            expect(writes[0]).toMatchObject({
                artifactKind: 'failure',
                identity: original.identity,
                failureId,
                causalFailureId: null,
                issues: [{ code: 'missing-capture-admission' }],
                rawEvidence: original
            });
            expect(writes.slice(1, 4)).toEqual(laterIdentities.map((identity) => ({
                artifactKind: 'not-run',
                failureId,
                identity,
                outcome: 'not-run',
                causalFailureId: failureId,
                issues: [{ path: '$', code: 'causal-not-run', message: 'Not run after the first workload correctness failure.' }],
                rawEvidence: null
            })));
            expect(writes[4]).toEqual({
                artifactKind: 'failure',
                failureId: `failure-cohort-${cohort.cohortId}`,
                identity: cohort,
                outcome: 'failed',
                causalFailureId: null,
                issues: [{
                    path: '$.identity.memberSampleIds',
                    code: 'cohort-members-unavailable',
                    message: 'Cohort assertion cannot run after a member sample failed or was causally not run.'
                }],
                rawEvidence: { causalFailureId: failureId, blockedMemberSampleIds: cohort.memberSampleIds }
            });
            expect(writes.some((artifact) => 'schema' in artifact)).toBe(false);
        }
    );

    it.each(['mode-mismatch', 'receipt-unavailable', 'application-unavailable'])(
        'refuses new B06 completed Connect evidence with %s and retains the original sample',
        async (reason) => {
            const staged = stagedExternalAttempt();
            const sample = staged.samples[0]!;
            const receipt = {
                configuration: { mode: reason === 'mode-mismatch' ? 'signaling' : 'native', origin: 'step' },
                application: reason === 'application-unavailable'
                    ? { status: 'unavailable', reason: 'sink-unavailable' }
                    : { status: 'applied', mode: reason === 'mode-mismatch' ? 'signaling' : 'native' },
                configurationVersion: 1,
                connectionId: { status: 'observed', value: 'connection-one' },
                nativeScopeId: { status: 'unavailable', reason: 'unsupported' },
                nativeAvailability: { status: 'unavailable', reason: 'unsupported' },
                nativeCoverage: 'unavailable'
            };
            const original = {
                ...sample,
                rawEvidence: reason === 'receipt-unavailable'
                    ? { rtcConnectCaptures: [] }
                    : { rtcConnectCaptures: [{ receipt }] }
            };
            const writes: RtcBaselineAcceptedArtifact[] = [];
            const initialized = {
                resolvedConfiguration: [{
                    caseKey: { workloadId: 'RTC-B06' as const, caseId: 'case', inputKey: 'input' },
                    field: 'rtcCaptureMode',
                    value: 'native',
                    source: 'cli' as const
                }]
            };
            const service = createRtcBaselineEvidenceAcceptance(dependencies({
                readManifest: async () => ({ ok: true, value: manifestFor('RTC-B06') }),
                readStagedJson: async () => ({ ok: true, value: normalizeStagedJson({ ...staged, samples: [original] }) }),
                writeAcceptedArtifact: collectWrites(writes),
                readInitializedConfiguration: async () => ({ ok: true, value: initialized.resolvedConfiguration })
            }));
            const result = await service.recordExternalAttempt(externalInput('RTC-B06'));
            expect(result).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: reason })]) });
            expect(writes[0]).toMatchObject({ artifactKind: 'failure', identity: original.identity, rawEvidence: original });
            expect(writes.some((artifact) => 'schema' in artifact && artifact.schema === 'rallar.rtc-baseline.external-attempt.v1')).toBe(false);
        }
    );

    it.each(['off', 'signaling', 'native'] as const)('accepts applied %s while retaining truthful unavailable Native observation', async (mode) => {
        const staged = stagedExternalAttempt();
        const receipt = {
            configuration: { mode, origin: 'step' },
            application: { status: 'applied', mode },
            configurationVersion: 1,
            connectionId: { status: 'observed', value: 'completed-connect' },
            nativeScopeId: { status: 'unavailable', reason: 'unsupported' },
            nativeAvailability: { status: 'unavailable', reason: 'unsupported' },
            nativeCoverage: 'unavailable'
        };
        const original = { ...staged.samples[0]!, rawEvidence: { rtcConnectCaptures: [{ receipt }] } };
        const writes: RtcBaselineAcceptedArtifact[] = [];
        const service = createRtcBaselineEvidenceAcceptance(dependencies({
            readManifest: async () => ({ ok: true, value: manifestFor('RTC-B06') }),
            readStagedJson: async () => ({ ok: true, value: normalizeStagedJson({ ...staged, samples: [original] }) }),
            writeAcceptedArtifact: collectWrites(writes),
            readInitializedConfiguration: async () => ({
                ok: true,
                value: [{
                    caseKey: { workloadId: 'RTC-B06', caseId: 'case', inputKey: 'input' },
                    field: 'rtcCaptureMode',
                    value: mode,
                    source: 'cli'
                }]
            })
        }));
        expect(await service.recordExternalAttempt(externalInput('RTC-B06'))).toEqual({ ok: true, value: { acceptedSampleCount: 1 } });
        expect(writes).toEqual([{ ...staged, samples: [original] }]);
    });

    it('starts one fresh child per outer attempt and persists every exact inner outcome', async () => {
        const writes: RtcBaselineAcceptedArtifact[] = [];
        const workerInputs: Array<{ baselineId: string; outerAttempt: RtcBaselineOuterAttemptDto; }> = [];
        const runFreshWorker = async (input: {
            baselineId: string;
            outerAttempt: RtcBaselineOuterAttemptDto;
        }) => {
            workerInputs.push(input);
            return input.outerAttempt.outerOrdinal === 1
                ? { outcomes: [passedFirst, passedSecond] }
                : { outcomes: [passedThird] };
        };
        const acceptance = createRtcBaselineEvidenceAcceptance(
            dependencies({
                runFreshWorker,
                readManifest: async () => ({
                    ok: true,
                    value: { ...manifest, outerAttempts: [attempt, secondAttempt] }
                }),
                writeAcceptedArtifact: collectWrites(writes)
            })
        );
        expect(await acceptance.captureWorkload(captureRequest)).toEqual({
            ok: true,
            value: { acceptedSampleCount: 3 }
        });
        expect(workerInputs).toEqual([
            { baselineId: manifest.request.baselineId, outerAttempt: attempt },
            { baselineId: manifest.request.baselineId, outerAttempt: secondAttempt }
        ]);
        expect(writes).toEqual([passedFirst, passedSecond, passedThird]);
    });

    it('gives producer status precedence over valid-looking staged browser evidence', async () => {
        const writes: RtcBaselineAcceptedArtifact[] = [];
        let stagedReadCount = 0;
        const readStagedJson = async (): Promise<RtcBaselineResult<RtcBaselineJson>> => {
            stagedReadCount += 1;
            return { ok: true as const, value: {} };
        };
        const browserManifest: RtcBaselineCaptureManifestDto = {
            ...manifestFor('RTC-B05'),
            outerAttempts: [
                {
                    ...manifestFor('RTC-B05').outerAttempts[0],
                    sampleIds: ['sample-1']
                }
            ]
        };
        const acceptance = createRtcBaselineEvidenceAcceptance(
            dependencies({
                readManifest: async () => ({ ok: true, value: browserManifest }),
                readStagedJson,
                writeAcceptedArtifact: collectWrites(writes)
            })
        );
        const result = await acceptance.recordBrowser({
            baselineId: '20260807-0123456789ab-e2-browser',
            locator: {
                workloadId: 'RTC-B05',
                caseId: 'browser-data-channel-lifecycle',
                inputKey: 'iterations-25',
                intendedPhase: 'retained',
                outerOrdinal: 1
            },
            producerExitStatus: 9,
            rawResultRelativePath: 'artifacts/staging/rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-001.json'
        });
        expect(result).toEqual({ ok: false, issues: [producerIssue] });
        expect(stagedReadCount).toBe(0);
        expect(writes).toHaveLength(1);
    });

    it.each(
        [
            ['external', 'RTC-B01', '$.locator.workloadId', syntheticOwnership],
            ['capture', 'RTC-B05', '$.workloadId', browserOwnership],
            ['browser', 'RTC-B06', '$.locator.workloadId', externalOwnership]
        ] as const
    )('rejects %s entry ownership for %s', async (entry, workloadId, path, message) => {
        const service = createRtcBaselineEvidenceAcceptance(
            dependencies({
                readManifest: async () => ({
                    ok: true,
                    value: workloadId === 'RTC-B01' ? manifest : manifestFor(workloadId)
                })
            })
        );
        const result = entry === 'capture'
            ? service.captureWorkload({ baselineId: manifest.request.baselineId, workloadId })
            : entry === 'browser'
            ? service.recordBrowser(externalInput(workloadId))
            : service.recordExternalAttempt(externalInput(workloadId));
        expect(await result).toEqual(rejected(path, 'entry-ownership', message));
    });

    it('accepts a valid external sample and writes every normalized field', async () => {
        const writes: RtcBaselineAcceptedArtifact[] = [];
        const externalAttempt = stagedExternalAttempt();
        externalAttempt.samples[0]!.rawEvidence = {
            durationMs: 1,
            rtcConnectCaptures: [{
                receipt: {
                    configuration: { mode: 'native', origin: 'step' },
                    application: { status: 'applied', mode: 'native' },
                    configurationVersion: 1,
                    connectionId: { status: 'observed', value: 'completed-connect' },
                    nativeScopeId: { status: 'unavailable', reason: 'unsupported' },
                    nativeAvailability: { status: 'unavailable', reason: 'unsupported' },
                    nativeCoverage: 'unavailable'
                }
            }]
        };
        const external = createRtcBaselineEvidenceAcceptance(
            dependencies({
                readManifest: async () => ({ ok: true, value: manifestFor('RTC-B06') }),
                readStagedJson: async () => ({ ok: true, value: normalizeStagedJson(externalAttempt) }),
                readInitializedConfiguration: async () => ({
                    ok: true,
                    value: [{
                        caseKey: { workloadId: 'RTC-B06', caseId: 'case', inputKey: 'input' },
                        field: 'rtcCaptureMode',
                        value: 'native',
                        source: 'cli'
                    }]
                }),
                writeAcceptedArtifact: collectWrites(writes)
            })
        );
        expect(await external.recordExternalAttempt(externalInput('RTC-B06'))).toEqual({
            ok: true,
            value: { acceptedSampleCount: 1 }
        });
        expect(writes).toEqual([externalAttempt]);
        Object.assign(externalAttempt.samples[0]!, { outcome: 'failed', issues: [producerIssue] });
        Object.assign(externalAttempt.sampleOutcomes[0]!, {
            outcome: 'failed',
            issues: [producerIssue]
        });
        expect(await external.recordExternalAttempt(externalInput('RTC-B06'))).toEqual({
            ok: false,
            issues: [producerIssue]
        });
        expect(writes.at(-1)).toMatchObject({ artifactKind: 'failure' });
    });

    it('retains valid staged RTC-B06 failure facts when its producer exits nonzero', async () => {
        const writes: RtcBaselineAcceptedArtifact[] = [];
        const externalAttempt = stagedExternalAttempt();
        const rawEvidence = {
            attemptFailure: {
                kind: 'control-result-failures',
                failedResults: [{ commandId: 'send-broadcast', state: 'failed' }]
            }
        };
        externalAttempt.producerExitStatus = 9;
        Object.assign(externalAttempt.samples[0]!, {
            outcome: 'failed',
            metrics: [],
            rawEvidence,
            issues: [producerIssue]
        });
        Object.assign(externalAttempt.sampleOutcomes[0]!, {
            outcome: 'failed',
            issues: [producerIssue]
        });
        let stagedReadCount = 0;
        const readStagedJson = async (): Promise<RtcBaselineResult<RtcBaselineJson>> => {
            stagedReadCount += 1;
            return {
                ok: true as const,
                value: normalizeStagedJson(externalAttempt)
            };
        };
        const external = createRtcBaselineEvidenceAcceptance(
            dependencies({
                readManifest: async () => ({ ok: true, value: manifestFor('RTC-B06') }),
                readStagedJson,
                writeAcceptedArtifact: collectWrites(writes)
            })
        );

        expect(
            await external.recordExternalAttempt({
                ...externalInput('RTC-B06'),
                producerExitStatus: 9
            })
        ).toEqual({ ok: false, issues: [producerIssue] });
        expect(stagedReadCount).toBe(1);
        expect(writes.at(-1)).toMatchObject({
            artifactKind: 'failure',
            rawEvidence
        });
    });

    it('binds an external cohort to its exact locator, members, raw path, and producer facts', async () => {
        const writes: RtcBaselineAcceptedArtifact[] = [];
        const b06Manifest: RtcBaselineCaptureManifestDto = {
            ...manifestFor('RTC-B06'),
            expectedCohorts: [
                {
                    cohortId: 'rtc-b06-e3-memory-retention',
                    workloadId: 'RTC-B06',
                    memberSampleIds: ['member-a', 'member-b']
                }
            ]
        };
        const stagedCohort: RtcBaselineExternalCohortDto = {
            schema: 'rallar.rtc-baseline.external-cohort.v1',
            identity: {
                cohortId: 'rtc-b06-e3-memory-retention',
                workloadId: 'RTC-B06',
                memberSampleIds: ['member-a', 'member-b']
            },
            outcome: 'passed',
            rawEvidence: { breaches: 0 },
            issues: [],
            samples: [
                passedSample(
                    { ...firstIdentity, sampleId: 'member-a', workloadId: 'RTC-B06' },
                    'local-full-stack'
                ),
                passedSample(
                    { ...firstIdentity, sampleId: 'member-b', workloadId: 'RTC-B06' },
                    'local-full-stack'
                )
            ]
        };
        const acceptance = createRtcBaselineEvidenceAcceptance(
            dependencies({
                readManifest: async () => ({ ok: true, value: b06Manifest }),
                readStagedJson: async () => ({ ok: true, value: normalizeStagedJson(stagedCohort) }),
                writeAcceptedArtifact: collectWrites(writes)
            })
        );
        const cohortInput = {
            baselineId: '20260807-0123456789ab-e3-memory',
            workloadId: 'RTC-B06' as const,
            cohortId: 'rtc-b06-e3-memory-retention',
            producerExitStatus: 0,
            rawResultRelativePath: 'artifacts/staging/rtc-b06-e3-memory-retention.json'
        };
        expect(await acceptance.recordExternalCohortAssertion(cohortInput)).toEqual({
            ok: true,
            value: { acceptedCohortCount: 1 }
        });
        expect(writes).toEqual([stagedCohort]);
        Object.assign(stagedCohort, { outcome: 'failed', issues: [producerIssue] });
        expect(await acceptance.recordExternalCohortAssertion(cohortInput)).toEqual({
            ok: false,
            issues: [producerIssue]
        });
        expect(writes.at(-1)).toMatchObject({ artifactKind: 'failure' });
    });
});
