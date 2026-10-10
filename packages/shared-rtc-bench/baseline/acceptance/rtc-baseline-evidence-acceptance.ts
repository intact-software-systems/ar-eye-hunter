import { decodeRtcBaselineSample } from '../contracts/rtc-baseline-artifact-decoding.ts';
import { validateRtcBaselineSample } from '../contracts/rtc-baseline-artifact-validation.ts';
import type {
    RtcBaselineCaptureManifestDto,
    RtcBaselineCaptureWorkloadInputDto,
    RtcBaselineExternalAttemptDto,
    RtcBaselineInitializeAcceptanceInputDto,
    RtcBaselineIssueDto,
    RtcBaselineJson,
    RtcBaselineOuterAttemptDto,
    RtcBaselineRecordAttemptInputDto,
    RtcBaselineRecordCohortInputDto,
    RtcBaselineResolvedConfigurationValueDto,
    RtcBaselineResult,
    RtcBaselineSampleDto,
    RtcBaselineSampleIdentityDto
} from '../contracts/rtc-baseline-contracts.ts';
import { normalizeRtcBaselineJson } from '../contracts/rtc-baseline-decoding.ts';
import {
    buildRtcBaselineFailureSequence,
    decodeRtcBaselineAcceptedAttempt,
    decodeRtcBaselineAcceptedCohort,
    deriveRtcBaselineSampleIdentities,
    findRtcBaselineAttemptFailureOwner,
    rtcBaselineSampleIdentityEquals,
    type RtcBaselineAcceptedArtifact,
    type RtcBaselineFailureOwner
} from './rtc-baseline-failure-accounting.ts';
import { validateRtcB06CaptureEvidence } from './validate-rtc-b06-capture-evidence.ts';

interface RtcBaselineEvidenceAcceptanceDependencies {
    initializeStore(
        baselineId: string,
        input: RtcBaselineInitializeAcceptanceInputDto
    ): Promise<RtcBaselineResult<void>>;
    readInitializedConfiguration(
        baselineId: string
    ): Promise<RtcBaselineResult<readonly RtcBaselineResolvedConfigurationValueDto[]>>;
    readManifest(baselineId: string): Promise<RtcBaselineResult<RtcBaselineCaptureManifestDto>>;
    writeAcceptedArtifact(
        baselineId: string,
        artifact: RtcBaselineAcceptedArtifact
    ): Promise<RtcBaselineResult<void>>;
    readStagedJson(
        baselineId: string,
        relativePath: string
    ): Promise<RtcBaselineResult<RtcBaselineJson>>;
    runFreshWorker(input: {
        baselineId: string;
        outerAttempt: RtcBaselineOuterAttemptDto;
    }): Promise<{ outcomes: RtcBaselineSampleDto[]; }>;
    reconcileAcceptedOperation(
        operation: 'initialize' | 'capture' | 'browser' | 'external' | 'cohort',
        input: { baselineId?: string; }
    ): Promise<RtcBaselineIssueDto[]>;
}

interface PersistFailureInput {
    baselineId: string;
    manifest?: RtcBaselineCaptureManifestDto;
    owner: RtcBaselineFailureOwner;
    issues: readonly RtcBaselineIssueDto[];
    rawEvidence: RtcBaselineJson;
}

interface RtcBaselineAttemptAdmissionContext {
    manifest: RtcBaselineCaptureManifestDto;
    owner: Extract<RtcBaselineFailureOwner, { kind: 'sample'; }>;
}
interface RtcBaselineWorkerAdmissionInput {
    baselineId: string;
    manifest: RtcBaselineCaptureManifestDto;
    identity: RtcBaselineSampleIdentityDto;
}
interface RtcBaselineWorkerOutcomeInput {
    baselineId: string;
    manifest: RtcBaselineCaptureManifestDto;
    expected: RtcBaselineSampleIdentityDto;
    outcome: RtcBaselineSampleDto;
    index: number;
}

type AcceptedSamples = Promise<RtcBaselineResult<{ acceptedSampleCount: number; }>>;
export interface RtcBaselineEvidenceAcceptance {
    initializeBaseline(
        input: RtcBaselineInitializeAcceptanceInputDto
    ): Promise<RtcBaselineResult<void>>;
    captureWorkload(input: RtcBaselineCaptureWorkloadInputDto): AcceptedSamples;
    recordBrowser(input: RtcBaselineRecordAttemptInputDto): AcceptedSamples;
    recordExternalAttempt(input: RtcBaselineRecordAttemptInputDto): AcceptedSamples;
    recordExternalCohortAssertion(
        input: RtcBaselineRecordCohortInputDto
    ): Promise<RtcBaselineResult<{ acceptedCohortCount: number; }>>;
}

function issue(path: string, code: string, message: string) {
    return { path, code, message };
}

function correctnessIssues(issues: readonly RtcBaselineIssueDto[], path: string, message: string) {
    return issues.length > 0 ? issues : [issue(path, 'correctness-failure', message)];
}

function producerExitIssue(producerExitStatus: number) {
    return issue(
        '$.producerExitStatus',
        'producer-exit-status',
        `Producer exited with status ${producerExitStatus}.`
    );
}

function retainsStructuredProducerFailure(
    input: RtcBaselineRecordAttemptInputDto | RtcBaselineRecordCohortInputDto
) {
    // The RTC-B06 Playwright producer writes its schema-checked attempt from `finally`. Retaining
    // that record makes a failed observation self-diagnosing; every other producer still fails on
    // process status alone because it has no equivalent failed-attempt publication contract.
    return 'locator' in input && input.locator.workloadId === 'RTC-B06';
}

function entryOwnershipIssue(
    entry: 'capture' | 'browser' | 'external',
    workloadId: RtcBaselineCaptureWorkloadInputDto['workloadId']
) {
    const policy = workloadId === 'RTC-B05'
        ? (['browser', 'Native-browser', 'record-browser'] as const)
        : workloadId === 'RTC-B06'
        ? (['external', 'Local-full-stack', 'external ingestion'] as const)
        : (['capture', 'Synthetic', 'capture'] as const);
    const [required, family, route] = policy;
    if (entry === required) {
        return null;
    }
    const path = entry === 'capture' ? '$.workloadId' : '$.locator.workloadId';
    return issue(path, 'entry-ownership', `${family} workloads must enter through ${route}.`);
}

export function createRtcBaselineEvidenceAcceptance(
    dependencies: RtcBaselineEvidenceAcceptanceDependencies
): RtcBaselineEvidenceAcceptance {
    return new RtcBaselineEvidenceAcceptanceController(dependencies);
}

class RtcBaselineEvidenceAcceptanceController implements RtcBaselineEvidenceAcceptance {
    private readonly dependencies: RtcBaselineEvidenceAcceptanceDependencies;

    constructor(dependencies: RtcBaselineEvidenceAcceptanceDependencies) {
        this.dependencies = dependencies;
    }

    recordBrowser(input: RtcBaselineRecordAttemptInputDto): AcceptedSamples {
        return this.prepareAttempt(input, 'browser');
    }

    recordExternalAttempt(input: RtcBaselineRecordAttemptInputDto): AcceptedSamples {
        return this.prepareAttempt(input, 'external');
    }

    private async persistFailure(input: PersistFailureInput) {
        const artifacts = buildRtcBaselineFailureSequence(input);
        for (const artifact of artifacts) {
            const written = await this.dependencies.writeAcceptedArtifact(input.baselineId, artifact);
            if (!written.ok) {
                return written;
            }
        }
        return { ok: false as const, issues: [...input.issues] };
    }

    private async readStagedEvidence(
        input: RtcBaselineRecordAttemptInputDto | RtcBaselineRecordCohortInputDto,
        owner: RtcBaselineFailureOwner,
        manifest?: RtcBaselineCaptureManifestDto
    ) {
        if (input.producerExitStatus !== 0 && !retainsStructuredProducerFailure(input)) {
            const producerIssue = producerExitIssue(input.producerExitStatus);
            return this.persistFailure({
                baselineId: input.baselineId,
                manifest,
                owner,
                issues: [producerIssue],
                rawEvidence: { producerExitStatus: input.producerExitStatus }
            });
        }
        const staged = await this.dependencies.readStagedJson(input.baselineId, input.rawResultRelativePath);
        return staged.ok
            ? staged
            : this.persistFailure({
                baselineId: input.baselineId,
                manifest,
                owner,
                issues: input.producerExitStatus === 0
                    ? staged.issues
                    : [producerExitIssue(input.producerExitStatus)],
                rawEvidence: input.producerExitStatus === 0
                    ? null
                    : { producerExitStatus: input.producerExitStatus }
            });
    }

    async initializeBaseline(input: RtcBaselineInitializeAcceptanceInputDto) {
        const issues = await this.dependencies.reconcileAcceptedOperation('initialize', {
            baselineId: input.request.baselineId
        });
        if (issues.length > 0) {
            return { ok: false as const, issues };
        }
        return this.dependencies.initializeStore(input.request.baselineId, input);
    }

    async captureWorkload(input: RtcBaselineCaptureWorkloadInputDto) {
        const manifestResult = await this.dependencies.readManifest(input.baselineId);
        if (!manifestResult.ok) {
            return manifestResult;
        }
        const ownershipIssue = entryOwnershipIssue('capture', input.workloadId);
        if (ownershipIssue) {
            return { ok: false as const, issues: [ownershipIssue] };
        }
        const attempts = manifestResult.value.outerAttempts.filter(
            (attempt) => attempt.workloadId === input.workloadId
        );
        const allIdentities = deriveRtcBaselineSampleIdentities(attempts);
        const reconciliation = await this.dependencies.reconcileAcceptedOperation('capture', input);
        if (reconciliation.length > 0) {
            return this.persistFailure({
                baselineId: input.baselineId,
                manifest: manifestResult.value,
                owner: { kind: 'sample', identity: allIdentities[0]! },
                issues: reconciliation,
                rawEvidence: null
            });
        }
        let acceptedSampleCount = 0;
        let globalIndex = 0;
        for (const outerAttempt of attempts) {
            const worker = await this.readWorkerAttempt({
                baselineId: input.baselineId,
                manifest: manifestResult.value,
                identity: allIdentities[globalIndex]!
            }, outerAttempt);
            if (!worker.ok) {
                return worker;
            }
            for (let index = 0; index < outerAttempt.sampleIds.length; index += 1) {
                const accepted = await this.acceptWorkerOutcome({
                    baselineId: input.baselineId,
                    manifest: manifestResult.value,
                    expected: allIdentities[globalIndex]!,
                    outcome: worker.value.outcomes[index]!,
                    index
                });
                if (!accepted.ok) {
                    return accepted;
                }
                acceptedSampleCount += 1;
                globalIndex += 1;
            }
        }
        return { ok: true as const, value: { acceptedSampleCount } };
    }

    private async readWorkerAttempt(
        input: RtcBaselineWorkerAdmissionInput,
        outerAttempt: RtcBaselineOuterAttemptDto
    ): Promise<RtcBaselineResult<{ outcomes: RtcBaselineSampleDto[]; }>> {
        let worker: { outcomes: RtcBaselineSampleDto[]; };
        try {
            worker = await this.dependencies.runFreshWorker({ baselineId: input.baselineId, outerAttempt });
        }
        catch (error) {
            const workerIssue = issue(
                '$.worker',
                'worker-threw',
                error instanceof Error ? error.message : String(error)
            );
            return this.persistFailure({
                baselineId: input.baselineId,
                manifest: input.manifest,
                owner: { kind: 'sample', identity: input.identity },
                issues: [workerIssue],
                rawEvidence: null
            });
        }
        const actualCount = worker.outcomes.length;
        if (actualCount !== outerAttempt.sampleIds.length) {
            const expectedCount = outerAttempt.sampleIds.length;
            const cardinalityIssue = issue(
                '$.worker.outcomes',
                'worker-outcome-cardinality',
                `Worker returned ${actualCount} outcomes for ${expectedCount} expected inner samples.`
            );
            return this.persistFailure({
                baselineId: input.baselineId,
                manifest: input.manifest,
                owner: { kind: 'sample', identity: input.identity },
                issues: [cardinalityIssue],
                rawEvidence: null
            });
        }
        return { ok: true, value: worker };
    }

    private async acceptWorkerOutcome(input: RtcBaselineWorkerOutcomeInput): Promise<RtcBaselineResult<void>> {
        const { expected, outcome, index } = input;
        const rawOutcome = normalizeRtcBaselineJson(outcome);
        const decoded = rawOutcome.ok ? decodeRtcBaselineSample(rawOutcome.value) : rawOutcome;
        const expectedEvidenceClass = expected.workloadId === 'RTC-B05'
            ? 'native-browser'
            : expected.workloadId === 'RTC-B06'
            ? 'local-full-stack'
            : 'synthetic-path';
        if (
            !decoded.ok ||
            validateRtcBaselineSample(decoded.value).length > 0 ||
            !rtcBaselineSampleIdentityEquals(decoded.value.identity, expected) ||
            decoded.value.evidenceClass !== expectedEvidenceClass
        ) {
            const invalidIssue = issue(
                `$.worker.outcomes[${index}]`,
                'invalid-worker-outcome',
                'Worker outcome does not match the expected inner identity.'
            );
            return this.persistFailure({
                baselineId: input.baselineId,
                manifest: input.manifest,
                owner: { kind: 'sample', identity: expected },
                issues: [invalidIssue],
                rawEvidence: rawOutcome.ok ? rawOutcome.value : null
            });
        }
        if (outcome.outcome !== 'passed') {
            const outcomeIssues = outcome.issues.length > 0
                ? outcome.issues
                : [
                    issue(
                        `$.worker.outcomes[${index}].outcome`,
                        'worker-outcome-failed',
                        'A failed worker outcome stops the capture workload.'
                    )
                ];
            return this.persistFailure({
                baselineId: input.baselineId,
                manifest: input.manifest,
                owner: { kind: 'sample', identity: expected },
                issues: outcomeIssues,
                rawEvidence: outcome.rawEvidence
            });
        }
        const written = await this.dependencies.writeAcceptedArtifact(input.baselineId, decoded.value);
        if (!written.ok) {
            return written;
        }
        return written;
    }

    private async readAttemptContext(
        input: RtcBaselineRecordAttemptInputDto,
        entry: 'browser' | 'external'
    ): Promise<RtcBaselineResult<RtcBaselineAttemptAdmissionContext>> {
        const manifestResult = await this.dependencies.readManifest(input.baselineId);
        if (!manifestResult.ok) {
            return manifestResult;
        }
        const workloadId = input.locator.workloadId;
        const ownershipIssue = entryOwnershipIssue(entry, workloadId);
        if (ownershipIssue) {
            return { ok: false as const, issues: [ownershipIssue] };
        }
        const owner = findRtcBaselineAttemptFailureOwner(manifestResult.value, input.locator);
        if (!owner) {
            return {
                ok: false as const,
                issues: [
                    issue(
                        '$.locator',
                        'unknown-external-attempt',
                        'External attempt locator is not predeclared by the initialized manifest.'
                    )
                ]
            };
        }
        const reconciliation = await this.dependencies.reconcileAcceptedOperation(entry, input);
        if (reconciliation.length > 0) {
            return this.persistFailure({
                baselineId: input.baselineId,
                manifest: manifestResult.value,
                owner,
                issues: reconciliation,
                rawEvidence: null
            });
        }
        return { ok: true, value: { manifest: manifestResult.value, owner } };
    }

    private async readAcceptedAttempt(
        input: RtcBaselineRecordAttemptInputDto,
        context: RtcBaselineAttemptAdmissionContext
    ) {
        const staged = await this.readStagedEvidence(input, context.owner, context.manifest);
        if (!staged.ok) {
            return staged;
        }
        const expectedOuter = context.manifest.outerAttempts.find(
            (attempt) => attempt.sampleIds[0] === context.owner.identity.sampleId
        )!;
        const accepted = decodeRtcBaselineAcceptedAttempt(staged.value, {
            baselineId: input.baselineId,
            expectedOuter,
            rawResultRelativePath: input.rawResultRelativePath,
            producerExitStatus: input.producerExitStatus
        });
        if (!accepted.ok) {
            const failedProducer = input.producerExitStatus !== 0;
            return this.persistFailure({
                baselineId: input.baselineId,
                manifest: context.manifest,
                owner: context.owner,
                issues: failedProducer
                    ? [producerExitIssue(input.producerExitStatus)]
                    : accepted.issues,
                rawEvidence: failedProducer
                    ? { producerExitStatus: input.producerExitStatus }
                    : staged.value
            });
        }
        return accepted;
    }

    private async prepareAttempt(input: RtcBaselineRecordAttemptInputDto, entry: 'browser' | 'external') {
        const context = await this.readAttemptContext(input, entry);
        if (!context.ok) {
            return context;
        }
        const accepted = await this.readAcceptedAttempt(input, context.value);
        if (!accepted.ok) {
            return accepted;
        }
        const failed = await this.retainAttemptFailure(input, context.value, accepted.value);
        if (failed !== null) {
            return failed;
        }
        const captureFailure = await this.admitCaptureReceipts(input, context.value, accepted.value.samples);
        if (captureFailure !== null) {
            return captureFailure;
        }
        const written = await this.dependencies.writeAcceptedArtifact(input.baselineId, accepted.value);
        return written.ok
            ? { ok: true as const, value: { acceptedSampleCount: accepted.value.sampleOutcomes.length } }
            : written;
    }

    private async retainAttemptFailure(
        input: RtcBaselineRecordAttemptInputDto,
        context: RtcBaselineAttemptAdmissionContext,
        attempt: RtcBaselineExternalAttemptDto
    ) {
        const failedIndex = attempt.samples.findIndex(
            (sample) => sample.outcome !== 'passed' || sample.issues.length > 0
        );
        const failed = attempt.samples[failedIndex];
        if (failed) {
            for (const sample of attempt.samples.slice(0, failedIndex)) {
                const written = await this.dependencies.writeAcceptedArtifact(input.baselineId, sample);
                if (!written.ok) {
                    return written;
                }
            }
            const failedIssues = input.producerExitStatus === 0
                ? correctnessIssues(
                    failed.issues,
                    '$.samples.outcome',
                    'A non-passing external sample stops evidence acceptance.'
                )
                : [
                    producerExitIssue(input.producerExitStatus),
                    ...failed.issues.filter((candidate) => candidate.code !== 'producer-exit-status')
                ];
            return this.persistFailure({
                baselineId: input.baselineId,
                manifest: context.manifest,
                owner: { kind: 'sample', identity: failed.identity },
                issues: failedIssues,
                rawEvidence: failed.rawEvidence
            });
        }
        if (input.producerExitStatus !== 0) {
            const producerIssue = producerExitIssue(input.producerExitStatus);
            return this.persistFailure({
                baselineId: input.baselineId,
                manifest: context.manifest,
                owner: context.owner,
                issues: [producerIssue],
                rawEvidence: attempt.samples[0]?.rawEvidence ?? {
                    producerExitStatus: input.producerExitStatus
                }
            });
        }
        return null;
    }

    private async admitCaptureReceipts(
        input: RtcBaselineRecordAttemptInputDto,
        context: RtcBaselineAttemptAdmissionContext,
        samples: readonly RtcBaselineSampleDto[]
    ) {
        if (input.locator.workloadId === 'RTC-B06') {
            const configuration = await this.dependencies.readInitializedConfiguration(input.baselineId);
            if (!configuration.ok) {
                return configuration;
            }
            for (const sample of samples) {
                const issues = validateRtcB06CaptureEvidence(sample, configuration.value);
                if (issues.length > 0) {
                    const original = normalizeRtcBaselineJson(sample);
                    return this.persistFailure({
                        baselineId: input.baselineId,
                        manifest: context.manifest,
                        owner: { kind: 'sample', identity: sample.identity },
                        issues,
                        rawEvidence: original.ok ? original.value : sample.rawEvidence
                    });
                }
            }
        }
        return null;
    }

    async recordExternalCohortAssertion(input: RtcBaselineRecordCohortInputDto) {
        const manifestResult = await this.dependencies.readManifest(input.baselineId);
        if (!manifestResult.ok) {
            return manifestResult;
        }
        const identity = manifestResult.value.expectedCohorts.find(
            (entry) => entry.workloadId === input.workloadId && entry.cohortId === input.cohortId
        );
        if (!identity) {
            return {
                ok: false as const,
                issues: [
                    issue(
                        '$.cohortId',
                        'unknown-cohort',
                        'External cohort is not predeclared by the initialized manifest.'
                    )
                ]
            };
        }
        const owner = { kind: 'cohort' as const, identity };
        const reconciliation = await this.dependencies.reconcileAcceptedOperation('cohort', input);
        if (reconciliation.length > 0) {
            return this.persistFailure({
                baselineId: input.baselineId,
                owner,
                issues: reconciliation,
                rawEvidence: null
            });
        }
        const staged = await this.readStagedEvidence(input, owner);
        if (!staged.ok) {
            return staged;
        }
        const accepted = decodeRtcBaselineAcceptedCohort(staged.value, identity);
        if (!accepted.ok) {
            return this.persistFailure({
                baselineId: input.baselineId,
                owner,
                issues: accepted.issues,
                rawEvidence: staged.value
            });
        }
        if (accepted.value.outcome !== 'passed' || accepted.value.issues.length > 0) {
            return this.persistFailure({
                baselineId: input.baselineId,
                owner,
                issues: correctnessIssues(
                    accepted.value.issues,
                    '$.outcome',
                    'A non-passing external cohort stops evidence acceptance.'
                ),
                rawEvidence: accepted.value.rawEvidence
            });
        }
        const written = await this.dependencies.writeAcceptedArtifact(input.baselineId, accepted.value);
        return written.ok ? { ok: true as const, value: { acceptedCohortCount: 1 } } : written;
    }
}
