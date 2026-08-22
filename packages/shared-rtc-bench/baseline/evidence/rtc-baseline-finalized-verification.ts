import { computeRtcBaselineExpectedSampleIdentities } from '../catalog/rtc-baseline-workload-manifest.ts';
import {
    validateRtcBaselineArtifactReconciliation,
    validateRtcBaselineCompleteAccounting,
    validateRtcBaselinePassingSummary
} from '../contracts/rtc-baseline-artifact-validation.ts';
import type { RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';
import { validateRtcBaselineArtifactOutcomeReconciliation } from './rtc-baseline-artifact-projection.ts';
import {
    inspectRtcBaselineChecksumEntries,
    RTC_BASELINE_CHECKSUM_FILE,
    RTC_BASELINE_SUMMARY_FILE,
    validateRtcBaselineRawArtifactIntegrity,
    validateRtcBaselineRawArtifactMembership,
    validateRtcBaselineRepeatLinkIdentity,
    validateRtcBaselineRepeatPrimaryDigest,
    type RtcBaselineSummaryArtifactRecord,
    type RtcBaselineVerifiedArtifacts
} from './rtc-baseline-evidence-layout.ts';
import {
    createRtcBaselineFinalizedArtifactReader,
    type RtcBaselineFinalizedReaderDependencies,
    type RtcBaselineReadFinalizedArtifacts
} from './rtc-baseline-finalized-artifact-reader.ts';
import {
    partitionRtcBaselineMetricObservations,
    summarizeRtcBaselineMetricPartitions,
    validateRtcBaselinePersistedMetricSummaries
} from './rtc-baseline-statistics.ts';

export interface RtcBaselineFinalizedArtifactVerifier {
    readVerifiedArtifacts(
        baselineId: string
    ): Promise<RtcBaselineResult<RtcBaselineVerifiedArtifacts>>;
    validateRepeatLink(
        baselineId: string,
        summary: RtcBaselineSummaryArtifactRecord
    ): Promise<RtcBaselineResult<void>>;
}

function failed(path: string, code: string, message: string): RtcBaselineResult<never> {
    return { ok: false, issues: [{ path, code, message }] };
}

function validateProjectedArtifacts(value: RtcBaselineReadFinalizedArtifacts): void {
    if (!value.manifest || !value.summary || !value.projection) {
        return;
    }
    value.issues.push(
        ...validateRtcBaselineCompleteAccounting({
            expectedSamples: computeRtcBaselineExpectedSampleIdentities(value.manifest),
            expectedCohorts: value.manifest.expectedCohorts,
            sampleOutcomes: value.summary.sampleOutcomes,
            cohortOutcomes: value.summary.cohortOutcomes
        })
    );
    const partitioned = partitionRtcBaselineMetricObservations(value.projection.metricObservations);
    if (!partitioned.ok) {
        value.issues.push(...partitioned.issues);
    }
    else {
        const expected = summarizeRtcBaselineMetricPartitions(partitioned.value);
        value.issues.push(
            ...validateRtcBaselinePersistedMetricSummaries(expected, value.summary.metricSummaries)
        );
    }
    value.issues.push(
        ...validateRtcBaselineArtifactOutcomeReconciliation({
            sampleOutcomes: value.projection.sampleOutcomes,
            rawReferences: value.projection.rawReferences,
            cohorts: value.projection.cohortOutcomes,
            failures: value.projection.failures,
            summary: value.summary
        }),
        ...validateRtcBaselinePassingSummary(value.summary)
    );
}

function validateArtifactSet(baselineId: string, value: RtcBaselineReadFinalizedArtifacts): void {
    if (value.environment && value.manifest && value.summary) {
        value.issues.push(
            ...validateRtcBaselineArtifactReconciliation({
                baselineId,
                environment: value.environment,
                manifest: value.manifest,
                summary: value.summary
            })
        );
    }
    if (value.summary) {
        value.issues.push(
            ...validateRtcBaselineRawArtifactMembership({
                retainedArtifactPaths: [...value.retainedPaths],
                rawReferencePaths: value.summary.rawReferences.map((reference) => reference.relativePath)
            }),
            ...validateRtcBaselineRawArtifactIntegrity({
                rawReferences: value.summary.rawReferences,
                checksumEntries: value.checksumEntries
            })
        );
    }
}

function toVerifiedArtifacts(
    baselineId: string,
    value: RtcBaselineReadFinalizedArtifacts
): RtcBaselineResult<RtcBaselineVerifiedArtifacts> {
    if (value.issues.length > 0) {
        return { ok: false, issues: value.issues };
    }
    const summarySha256 = value.checksumEntries.get(RTC_BASELINE_SUMMARY_FILE);
    if (!value.environment || !value.manifest || !value.summary || !summarySha256) {
        return failed(
            '$.retainedArtifactPaths',
            'missing-finalized-artifact',
            'Environment, manifest, summary, and summary checksum are required.'
        );
    }
    return {
        ok: true,
        value: {
            environment: value.environment,
            manifest: value.manifest,
            summary: value.summary,
            summarySha256,
            validation: {
                baselineId,
                retainedArtifactPaths: [...value.retainedPaths],
                checksumEntryCount: value.checksumEntries.size
            }
        }
    };
}

async function validateRepeatLink(
    dependencies: RtcBaselineFinalizedReaderDependencies,
    baselineId: string,
    summary: RtcBaselineSummaryArtifactRecord
): Promise<RtcBaselineResult<void>> {
    const identity = validateRtcBaselineRepeatLinkIdentity(baselineId, summary.repeatLink);
    if (!identity.ok || summary.repeatLink === null) {
        return identity;
    }
    const primaryId = summary.repeatLink.primaryBaselineId;
    const checksumBytes = await dependencies.readBytes(primaryId, RTC_BASELINE_CHECKSUM_FILE);
    if (!checksumBytes.ok) {
        return checksumBytes;
    }
    const checksums = inspectRtcBaselineChecksumEntries(checksumBytes.value);
    if (checksums.issues.length > 0) {
        return { ok: false, issues: checksums.issues };
    }
    const checksum = validateRtcBaselineRepeatPrimaryDigest({
        summary,
        sha256: checksums.entries.get(RTC_BASELINE_SUMMARY_FILE) ?? '',
        source: 'checksum'
    });
    if (!checksum.ok) {
        return checksum;
    }
    const primaryBytes = await dependencies.readBytes(primaryId, RTC_BASELINE_SUMMARY_FILE);
    if (!primaryBytes.ok) {
        return primaryBytes;
    }
    return validateRtcBaselineRepeatPrimaryDigest({
        summary,
        sha256: await dependencies.sha256(primaryBytes.value),
        source: 'summary-bytes'
    });
}

export function createRtcBaselineFinalizedArtifactVerifier(
    dependencies: RtcBaselineFinalizedReaderDependencies
): RtcBaselineFinalizedArtifactVerifier {
    const artifactReader = createRtcBaselineFinalizedArtifactReader(dependencies);
    return {
        async readVerifiedArtifacts(baselineId) {
            const read = await artifactReader.read(baselineId);
            if (!read.ok) {
                return read;
            }
            validateProjectedArtifacts(read.value);
            validateArtifactSet(baselineId, read.value);
            return toVerifiedArtifacts(baselineId, read.value);
        },
        validateRepeatLink: (baselineId, summary) => validateRepeatLink(dependencies, baselineId, summary)
    };
}
