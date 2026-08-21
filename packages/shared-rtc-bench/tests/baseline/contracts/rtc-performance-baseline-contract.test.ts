import { describe, expect, it } from 'vitest';

import { computeRtcBaselineFailureId, resolveRtcBaselineAcceptedArtifactPath } from '../../../baseline/acceptance/rtc-baseline-failure-accounting.ts';
import {
    RTC_BASELINE_SCHEMA,
    type RtcBaselineAttemptLocatorDto,
    type RtcBaselineCaptureManifestDto,
    type RtcBaselineCaptureRequestDto,
    type RtcBaselineConditionalEnvironmentDecisionDto,
    type RtcBaselineConfigurationFieldDescriptorDto,
    type RtcBaselineControllerInputDto,
    type RtcBaselineEnvironmentDto,
    type RtcBaselineExternalAttemptDto,
    type RtcBaselineExternalCohortDto,
    type RtcBaselineFinalizationFailureDto,
    type RtcBaselineOuterAttemptDto,
    type RtcBaselineRepeatLinkDto,
    type RtcBaselineResolvedConfigurationValueDto,
    type RtcBaselineSampleDto,
    type RtcBaselineSummaryDto,
    type RtcBaselineWorkerCommandDto
} from '../../../baseline/contracts/rtc-baseline-contracts.ts';

describe('RTC baseline data contracts', () => {
    it('creates stable noncolliding failure IDs from resolved sample and cohort identities', () => {
        expect(
            computeRtcBaselineFailureId({
                kind: 'sample',
                identity: {
                    sampleId: 'rtc-b01-case-input-retained-001-001',
                    workloadId: 'RTC-B01',
                    caseId: 'case',
                    inputKey: 'input',
                    intendedPhase: 'retained',
                    outerOrdinal: 1,
                    innerOrdinal: 1
                }
            })
        ).toBe('failure-sample-rtc-b01-case-input-retained-001-001');
        expect(
            computeRtcBaselineFailureId({
                kind: 'cohort',
                identity: {
                    cohortId: 'rtc-b06-e3-memory-retention',
                    workloadId: 'RTC-B06',
                    memberSampleIds: ['member-a', 'member-b']
                }
            })
        ).toBe('failure-cohort-rtc-b06-e3-memory-retention');
    });

    it('keeps the schema and request JSON-safe with ordered plural workloads', () => {
        const request: RtcBaselineCaptureRequestDto = {
            schema: 'rallar.rtc-baseline.capture-request.v1',
            baselineId: '20260807-0123456789ab-e1-local',
            workloadIds: ['RTC-B03', 'RTC-B01'],
            environmentId: 'E1-local',
            retainedSampleMultiplier: 1,
            repeatLink: null,
            conditionalEnvironmentDecisions: []
        };

        expect(RTC_BASELINE_SCHEMA).toBe('rallar.rtc-baseline.v1');
        expect(JSON.parse(JSON.stringify(request))).toEqual(request);
        expect(request.workloadIds).toEqual(['RTC-B03', 'RTC-B01']);
    });

    it('models a repeat as an exact two-field immutable link', () => {
        const link: RtcBaselineRepeatLinkDto = {
            primaryBaselineId: '20260807-0123456789ab-e1-local',
            primarySummarySha256: 'a'.repeat(64)
        };

        expect(Object.keys(link)).toEqual(['primaryBaselineId', 'primarySummarySha256']);
        expect(JSON.parse(JSON.stringify(link))).toEqual(link);
    });

    it('keeps conditional environment decisions generic and reasoned', () => {
        const required: RtcBaselineConditionalEnvironmentDecisionDto = {
            environmentId: 'E4-pg',
            decision: 'required',
            reason: 'The selected call path includes persistent RTT reads.'
        };
        const notRequired: RtcBaselineConditionalEnvironmentDecisionDto = {
            environmentId: 'E4-pg',
            decision: 'not-required',
            reason: 'The selected workload is wholly browser-native.'
        };

        expect([required, notRequired]).toEqual([
            {
                environmentId: 'E4-pg',
                decision: 'required',
                reason: 'The selected call path includes persistent RTT reads.'
            },
            {
                environmentId: 'E4-pg',
                decision: 'not-required',
                reason: 'The selected workload is wholly browser-native.'
            }
        ]);
    });

    it('keeps descriptors, resolved values, argv, and worker projection separate', () => {
        const descriptor: RtcBaselineConfigurationFieldDescriptorDto = {
            caseKey: {
                workloadId: 'RTC-B01',
                caseId: 'peer-connection-diagnostics-burst',
                inputKey: 'pairs-500'
            },
            field: 'innerRuns',
            flag: '--rtc-inner-runs',
            scalarKind: 'nonnegative-integer',
            defaultValue: 5,
            allowlistedEnvironmentVariable: null,
            environmentUnsetBehavior: null
        };
        const command: RtcBaselineWorkerCommandDto = {
            redactedArgv: {
                executable: 'deno',
                arguments: [
                    'run',
                    '--config=packages/shared-rtc-bench/deno.json',
                    '--allow-read',
                    '--allow-write',
                    'packages/shared-rtc-bench/workloads/signaling/rtc-peer-connection-diagnostics-burst.ts',
                    '--capture=worker',
                    '--baseline-id=20260807-0123456789ab-e1-local',
                    '--workload=RTC-B01',
                    '--case-id=peer-connection-diagnostics-burst',
                    '--input-key=pairs-500',
                    '--intended-phase=retained',
                    '--outer-ordinal=1',
                    '--sample-ids=rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-001',
                    '--rtc-ice-candidates-per-peer=5',
                    '--rtc-inner-runs=5',
                    '--rtc-offer-collisions-per-peer=3',
                    '--rtc-peers=500'
                ]
            },
            projection: {
                fixedWorkerFlags: [
                    '--capture=worker',
                    '--baseline-id=20260807-0123456789ab-e1-local',
                    '--workload=RTC-B01',
                    '--case-id=peer-connection-diagnostics-burst',
                    '--input-key=pairs-500',
                    '--intended-phase=retained',
                    '--outer-ordinal=1',
                    '--sample-ids=rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-001'
                ],
                configurationFlags: [
                    '--rtc-ice-candidates-per-peer=5',
                    '--rtc-inner-runs=5',
                    '--rtc-offer-collisions-per-peer=3',
                    '--rtc-peers=500'
                ]
            }
        };

        expect(descriptor.flag).toBe('--rtc-inner-runs');
        expect(command.projection.configurationFlags).toEqual([
            '--rtc-ice-candidates-per-peer=5',
            '--rtc-inner-runs=5',
            '--rtc-offer-collisions-per-peer=3',
            '--rtc-peers=500'
        ]);
    });

    it('keeps controller inputs and resolved configuration as distinct complete records', () => {
        const resolved: RtcBaselineResolvedConfigurationValueDto = {
            caseKey: {
                workloadId: 'RTC-B06',
                caseId: 'retention-100',
                inputKey: 'e4-pg-retention-100'
            },
            field: 'retentionCycles',
            value: 100,
            source: 'environment'
        };
        const controllerInputs = [
            { name: 'baselineId', value: '20260807-0123456789ab-e4-pg', secret: false },
            { name: 'producerExitStatus', value: 0, secret: false },
            { name: 'rawResultRelativePath', value: 'artifacts/staging/result.json', secret: false },
            { name: 'DATABASE_URL', value: 'present', secret: true }
        ];

        expect({ resolved, controllerInputs }).toEqual({
            resolved: {
                caseKey: {
                    workloadId: 'RTC-B06',
                    caseId: 'retention-100',
                    inputKey: 'e4-pg-retention-100'
                },
                field: 'retentionCycles',
                value: 100,
                source: 'environment'
            },
            controllerInputs: [
                { name: 'baselineId', value: '20260807-0123456789ab-e4-pg', secret: false },
                { name: 'producerExitStatus', value: 0, secret: false },
                { name: 'rawResultRelativePath', value: 'artifacts/staging/result.json', secret: false },
                { name: 'DATABASE_URL', value: 'present', secret: true }
            ]
        });
    });

    it('round-trips complete manifest, outer-attempt, locator, and controller-input DTOs', () => {
        const outerAttempt: RtcBaselineOuterAttemptDto = {
            workloadId: 'RTC-B05',
            caseId: 'browser-data-channel-lifecycle',
            inputKey: 'iterations-25',
            environmentId: 'E2-browser',
            intendedPhase: 'retained',
            outerOrdinal: 3,
            sampleIds: ['rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-003-001']
        };
        const locator: RtcBaselineAttemptLocatorDto = {
            workloadId: 'RTC-B05',
            caseId: 'browser-data-channel-lifecycle',
            inputKey: 'iterations-25',
            intendedPhase: 'retained',
            outerOrdinal: 3,
            environmentId: 'E2-browser',
            rawResultRelativePath: 'artifacts/staging/rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-003.json'
        };
        const controllerInput: RtcBaselineControllerInputDto = {
            name: 'producerExitStatus',
            value: 0,
            secret: false
        };
        const manifest: RtcBaselineCaptureManifestDto = {
            schema: 'rallar.rtc-baseline.manifest.v1',
            request: {
                schema: 'rallar.rtc-baseline.capture-request.v1',
                baselineId: '20260807-0123456789ab-e2-browser',
                workloadIds: ['RTC-B05'],
                environmentId: 'E2-browser',
                retainedSampleMultiplier: 1,
                repeatLink: null,
                conditionalEnvironmentDecisions: []
            },
            workloadIds: ['RTC-B05'],
            cases: [],
            outerAttempts: [outerAttempt],
            expectedCohorts: [],
            repeatLink: null
        };
        expect(
            JSON.parse(JSON.stringify({ manifest, outerAttempt, locator, controllerInput }))
        ).toEqual({
            manifest,
            outerAttempt,
            locator,
            controllerInput
        });
    });

    it('round-trips the complete persisted artifact family with singular attempt workload IDs', () => {
        const identity = {
            sampleId: 'rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-001-001',
            workloadId: 'RTC-B05' as const,
            caseId: 'browser-data-channel-lifecycle',
            inputKey: 'iterations-25',
            intendedPhase: 'retained' as const,
            outerOrdinal: 1,
            innerOrdinal: 1
        };
        const environment: RtcBaselineEnvironmentDto = {
            schema: 'rallar.rtc-baseline.environment.v1',
            baselineId: '20260807-0123456789ab-e2-browser',
            workloadIds: ['RTC-B05'],
            environmentId: 'E2-browser',
            repeatLink: null,
            conditionalEnvironmentDecisions: [],
            observation: null
        };
        const sample: RtcBaselineSampleDto = {
            schema: 'rallar.rtc-baseline.sample.v1',
            identity,
            outcome: 'passed',
            evidenceClass: 'native-browser',
            metrics: [{ metric: 'openDurationMs', unit: 'ms', value: 4 }],
            rawEvidence: { opened: true },
            rawReferences: [{ relativePath: 'artifacts/raw-1.json', sha256: 'd'.repeat(64), bytes: 12 }],
            issues: [],
            runtimeObservation: null
        };
        const externalAttempt: RtcBaselineExternalAttemptDto = {
            schema: 'rallar.rtc-baseline.external-attempt.v1',
            locator: {
                workloadId: 'RTC-B05',
                caseId: 'browser-data-channel-lifecycle',
                inputKey: 'iterations-25',
                intendedPhase: 'retained',
                outerOrdinal: 1,
                environmentId: 'E2-browser',
                rawResultRelativePath: 'artifacts/staging/rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-001.json'
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
            sampleOutcomes: [{ identity, outcome: 'passed', issues: [] }],
            samples: [sample],
            issues: []
        };
        const cohort: RtcBaselineExternalCohortDto = {
            schema: 'rallar.rtc-baseline.external-cohort.v1',
            identity: {
                cohortId: 'rtc-b06-e3-memory-retention',
                workloadId: 'RTC-B06',
                memberSampleIds: ['member-a', 'member-b']
            },
            outcome: 'passed',
            rawEvidence: { breaches: 0 },
            issues: [],
            samples: []
        };
        const failure: RtcBaselineFinalizationFailureDto = {
            schema: 'rallar.rtc-baseline.finalization-failure.v1',
            baselineId: '20260807-0123456789ab-e2-browser',
            failureId: 'finalization-001',
            issues: [{ path: '$.SHA256SUMS', code: 'write-failed', message: 'disk full' }],
            rawEvidence: null
        };
        const summary: RtcBaselineSummaryDto = {
            schema: 'rallar.rtc-baseline.summary.v1',
            baselineId: '20260807-0123456789ab-e2-browser',
            workloadIds: ['RTC-B05'],
            environmentId: 'E2-browser',
            repeatLink: null,
            conditionalEnvironmentDecisions: [],
            sampleOutcomes: [{ identity, outcome: 'passed', issues: [] }],
            cohortOutcomes: [],
            metricSummaries: [
                {
                    workloadId: 'RTC-B05',
                    caseId: 'browser-data-channel-lifecycle',
                    inputKey: 'iterations-25',
                    metric: 'openDurationMs',
                    unit: 'ms',
                    count: 1,
                    minimum: 4,
                    median: 4,
                    maximum: 4,
                    mad: 0,
                    coefficientOfVariation: 0
                }
            ],
            rawReferences: sample.rawReferences
        };

        expect(
            JSON.parse(
                JSON.stringify({ environment, sample, externalAttempt, cohort, failure, summary })
            )
        ).toEqual({
            environment,
            sample,
            externalAttempt,
            cohort,
            failure,
            summary
        });
        expect(externalAttempt.locator.workloadId).toBe('RTC-B05');
        expect(summary.workloadIds).toEqual(['RTC-B05']);
        expect(resolveRtcBaselineAcceptedArtifactPath(sample)).toEqual({
            ok: true,
            value: 'results/samples/rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-001-001.json'
        });
        expect(resolveRtcBaselineAcceptedArtifactPath(externalAttempt)).toEqual({
            ok: true,
            value: 'results/external-attempts/RTC-B05-browser-data-channel-lifecycle-iterations-25-retained-001.json'
        });
        expect(resolveRtcBaselineAcceptedArtifactPath(cohort)).toEqual({
            ok: true,
            value: 'results/external-cohorts/rtc-b06-e3-memory-retention.json'
        });
        expect(resolveRtcBaselineAcceptedArtifactPath(failure)).toEqual({
            ok: true,
            value: 'results/finalization-failures/finalization-001.json'
        });
    });
});
