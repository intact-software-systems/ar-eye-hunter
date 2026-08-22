import {
    decodeRtcBaselineFailureOutcome,
    resolveRtcBaselineAcceptedArtifactPath
} from '../acceptance/rtc-baseline-failure-accounting.ts';
import { decodeRtcBaselineStoredJson } from '../contracts/rtc-baseline-artifact-decoding.ts';
import { rtcBaselineIssue, type RtcBaselineJson, type RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';
import type { RtcBaselineStoredFile } from '../evidence/rtc-baseline-artifact-files.ts';
import {
    createRtcBaselineArtifactProjector,
    type RtcBaselineArtifactProjection,
    type RtcBaselineArtifactProjector
} from '../evidence/rtc-baseline-artifact-projection.ts';
import {
    classifyRtcBaselineArtifactPath,
    type RtcBaselineArtifactKind
} from '../evidence/rtc-baseline-evidence-layout.ts';
import type { RtcBaselineLockedWriter } from '../evidence/rtc-baseline-evidence-store.ts';
import {
    createRtcBaselineFinalizedEvidence,
    type RtcBaselineCollectedArtifacts,
    type RtcBaselineFinalizationLockedWriter,
    type RtcBaselineFinalizedEvidence
} from '../evidence/rtc-baseline-finalized-evidence.ts';
import {
    createRtcBaselineFinalizedReader,
    type RtcBaselineFinalizedReader
} from '../evidence/rtc-baseline-finalized-reader.ts';
import {
    computeRtcBaselineMetricSummary,
    partitionRtcBaselineMetricObservations
} from '../evidence/rtc-baseline-statistics.ts';
import type { RtcBaselineDenoEvidence } from './rtc-baseline-deno-evidence.ts';

type RtcBaselineClassifiedArtifactKind = NonNullable<ReturnType<typeof classifyRtcBaselineArtifactPath>>;

interface AppendRtcBaselineResultArtifactInput {
    readonly projector: RtcBaselineArtifactProjector;
    readonly kind: RtcBaselineClassifiedArtifactKind;
    readonly artifactJson: RtcBaselineJson;
    readonly relativePath: string;
}

interface CollectRtcBaselineResultArtifactsInput {
    readonly evidence: RtcBaselineDenoEvidence;
    readonly baselineId: string;
    readonly listedFiles: readonly RtcBaselineStoredFile[];
    readonly projector: RtcBaselineArtifactProjector;
}

export interface RtcBaselineDenoFinalization {
    readonly finalizedEvidence: RtcBaselineFinalizedEvidence;
    readonly finalizedReader: RtcBaselineFinalizedReader;
}

function unsupportedArtifactPath(relativePath: string) {
    return {
        ok: false as const,
        issues: [
            rtcBaselineIssue(
                `$.${relativePath}`,
                'unsupported-artifact-path',
                'Result artifact path is not recognized by the RTC baseline protocol.'
            )
        ]
    };
}

function isStoredResultArtifactKind(
    kind: RtcBaselineClassifiedArtifactKind
): kind is RtcBaselineArtifactKind {
    return (
        kind === 'sample' ||
        kind === 'external-attempt' ||
        kind === 'external-cohort' ||
        kind === 'finalization-failure'
    );
}

async function appendRtcBaselineResultArtifact(
    artifactInput: AppendRtcBaselineResultArtifactInput
): Promise<RtcBaselineResult<void>> {
    if (artifactInput.kind === 'failure-outcome') {
        const decoded = decodeRtcBaselineFailureOutcome(
            artifactInput.artifactJson,
            artifactInput.relativePath
        );
        return decoded.ok ? artifactInput.projector.appendFailureOutcome(decoded.value) : decoded;
    }
    if (!isStoredResultArtifactKind(artifactInput.kind)) {
        return unsupportedArtifactPath(artifactInput.relativePath);
    }
    const decoded = decodeRtcBaselineStoredJson(artifactInput.kind, artifactInput.artifactJson);
    return decoded.ok ? artifactInput.projector.appendStoredArtifact(decoded.value) : decoded;
}

async function collectRtcBaselineResultArtifacts(
    input: CollectRtcBaselineResultArtifactsInput
): Promise<RtcBaselineResult<RtcBaselineArtifactProjection>> {
    for (const listedFile of input.listedFiles) {
        const kind = classifyRtcBaselineArtifactPath(listedFile.relativePath);
        if (kind === null) {
            return unsupportedArtifactPath(listedFile.relativePath);
        }
        const artifact = await input.evidence.store.readJson(input.baselineId, listedFile.relativePath);
        if (!artifact.ok) {
            return artifact;
        }
        const appended = await appendRtcBaselineResultArtifact({
            projector: input.projector,
            kind,
            artifactJson: artifact.value,
            relativePath: listedFile.relativePath
        });
        if (!appended.ok) {
            return appended;
        }
    }
    return { ok: true, value: input.projector.getProjection() };
}

async function collectRtcBaselineArtifacts(
    evidence: RtcBaselineDenoEvidence,
    sha256: (bytes: Uint8Array) => Promise<string>,
    baselineId: string
): Promise<RtcBaselineResult<RtcBaselineCollectedArtifacts>> {
    const reconciliation = await evidence.reconcileAcceptedOperation('finalize', { baselineId });
    if (reconciliation.length > 0) {
        return { ok: false, issues: reconciliation };
    }
    const environment = await evidence.readEnvironment(baselineId);
    if (!environment.ok) {
        return environment;
    }
    const observation = environment.value.observation;
    if (observation === null) {
        return {
            ok: false,
            issues: [rtcBaselineIssue('$.observation', 'missing-observation', 'Required.')]
        };
    }
    const manifest = await evidence.readManifest(baselineId);
    if (!manifest.ok) {
        return manifest;
    }
    const listed = await evidence.store.listArtifacts(baselineId, 'results');
    if (!listed.ok) {
        return listed;
    }
    const projector = createRtcBaselineArtifactProjector({
        environmentId: manifest.value.request.environmentId,
        environmentObservation: observation,
        conflictingSampleCode: 'conflicting-sample-duplicate',
        conflictingSampleMessage: (sampleId) => `Sample ${sampleId} has unequal accepted representations.`,
        sha256
    });
    const projection = await collectRtcBaselineResultArtifacts({
        evidence,
        baselineId,
        listedFiles: listed.value,
        projector
    });
    if (!projection.ok) {
        return projection;
    }
    return {
        ok: true,
        value: {
            environment: { ...environment.value, observation },
            manifest: manifest.value,
            workloadIds: manifest.value.workloadIds,
            environmentId: manifest.value.request.environmentId,
            repeatLink: manifest.value.repeatLink,
            conditionalEnvironmentDecisions: manifest.value.request.conditionalEnvironmentDecisions,
            retainedArtifactPaths: [
                'environment.json',
                'manifest.json',
                ...listed.value.map((entry) => entry.relativePath)
            ],
            ...projection.value
        }
    };
}

async function listRtcBaselineFinalizedArtifactPaths(
    evidence: RtcBaselineDenoEvidence,
    baselineId: string
) {
    const results = await evidence.store.listArtifacts(baselineId, 'results');
    if (!results.ok) {
        return results;
    }
    const artifacts = await evidence.store.listArtifacts(baselineId, 'artifacts');
    if (!artifacts.ok) {
        return artifacts;
    }
    const unsupported = results.value.find(
        (entry) => classifyRtcBaselineArtifactPath(entry.relativePath) === null
    );
    if (unsupported) {
        return unsupportedArtifactPath(unsupported.relativePath);
    }
    return {
        ok: true as const,
        value: [
            'environment.json',
            'manifest.json',
            ...results.value.map((entry) => entry.relativePath),
            ...artifacts.value
                .map((entry) => entry.relativePath)
                .filter((path) => classifyRtcBaselineArtifactPath(path) !== null),
            'summary.json'
        ]
    };
}

function toRtcBaselineFinalizationWriter(
    writer: RtcBaselineLockedWriter
): RtcBaselineFinalizationLockedWriter {
    return {
        publishSummary: writer.publishSummary,
        async writeFinalizationFailure(baselineId, artifact) {
            const path = resolveRtcBaselineAcceptedArtifactPath(artifact);
            return path.ok ? writer.writeJsonCreateNew(baselineId, path.value, artifact) : path;
        }
    };
}

async function withRtcBaselineFinalizationLock<T>(
    evidence: RtcBaselineDenoEvidence,
    baselineId: string,
    operation: (writer: RtcBaselineFinalizationLockedWriter) => Promise<RtcBaselineResult<T>>
) {
    return evidence.store.withFinalizationLock(
        baselineId,
        (writer) => operation(toRtcBaselineFinalizationWriter(writer))
    );
}

export function createRtcBaselineDenoFinalization(
    evidence: RtcBaselineDenoEvidence,
    sha256: (bytes: Uint8Array) => Promise<string>
): RtcBaselineDenoFinalization {
    const finalizedReader = createRtcBaselineFinalizedReader({
        readJson: evidence.store.readJson,
        readBytes: evidence.store.readBytes,
        listArtifactPaths: (baselineId) => listRtcBaselineFinalizedArtifactPaths(evidence, baselineId),
        sha256
    });
    const finalizedEvidence = createRtcBaselineFinalizedEvidence({
        withFinalizationLock: (baselineId, operation) =>
            withRtcBaselineFinalizationLock(evidence, baselineId, operation),
        collectArtifacts: (baselineId) => collectRtcBaselineArtifacts(evidence, sha256, baselineId),
        partitionMetricObservations: partitionRtcBaselineMetricObservations,
        summarizeMetricValues: computeRtcBaselineMetricSummary,
        readBytes: evidence.store.readBytes,
        sha256
    });
    return { finalizedEvidence, finalizedReader };
}
