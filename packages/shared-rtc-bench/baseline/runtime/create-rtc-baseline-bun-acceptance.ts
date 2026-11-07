import { createRtcBaselineEvidenceAcceptance } from '../acceptance/rtc-baseline-evidence-acceptance.ts';
import {
    resolveRtcBaselineAcceptedArtifactPath,
    RTC_BASELINE_ACCEPTED_ARTIFACT_DIRECTORIES,
    type RtcBaselineAcceptedArtifact
} from '../acceptance/rtc-baseline-failure-accounting.ts';
import { RTC_BASELINE_WORKLOAD_CATALOG } from '../catalog/rtc-baseline-workload-catalog.ts';
import { deriveRtcBaselineCaptureManifest } from '../catalog/rtc-baseline-workload-manifest.ts';
import { decodeRtcBaselineSample } from '../contracts/rtc-baseline-artifact-decoding.ts';
import { validateRtcBaselineSample } from '../contracts/rtc-baseline-artifact-validation.ts';
import {
    isRtcBaselineSampleDto,
    type RtcBaselineInitializeAcceptanceInputDto,
    type RtcBaselineOuterAttemptDto,
    type RtcBaselineRuntimeObservationDto,
    type RtcBaselineSampleDto
} from '../contracts/rtc-baseline-contracts.ts';
import { normalizeRtcBaselineJson } from '../contracts/rtc-baseline-decoding.ts';
import { createRtcBaselineWorkerCommand } from '../contracts/rtc-baseline-validation.ts';
import type { BunRtcBaselineAdapters } from './rtc-baseline-bun-adapters.ts';
import type { RtcBaselineBunEvidence } from './rtc-baseline-bun-evidence.ts';

interface RtcBaselineBunWorkerRequest {
    readonly baselineId: string;
    readonly outerAttempt: RtcBaselineOuterAttemptDto;
}

const encoder = new TextEncoder();

async function initializeRtcBaselineBunStore(
    evidence: RtcBaselineBunEvidence,
    baselineId: string,
    initialization: RtcBaselineInitializeAcceptanceInputDto
) {
    const environment = {
        schema: 'rallar.rtc-baseline.environment.v1',
        baselineId,
        workloadIds: initialization.request.workloadIds,
        environmentId: initialization.request.environmentId,
        repeatLink: initialization.request.repeatLink,
        conditionalEnvironmentDecisions: initialization.request.conditionalEnvironmentDecisions,
        observation: initialization.runtimeObservation
    };
    const manifest = deriveRtcBaselineCaptureManifest(initialization.request);
    return evidence.store.initializeBaseline(
        baselineId,
        {
            'environment.json': encoder.encode(`${JSON.stringify(environment)}\n`),
            'manifest.json': encoder.encode(`${JSON.stringify(manifest)}\n`)
        },
        [...RTC_BASELINE_ACCEPTED_ARTIFACT_DIRECTORIES, 'artifacts', 'artifacts/staging']
    );
}

async function writeRtcBaselineAcceptedArtifact(
    evidence: RtcBaselineBunEvidence,
    baselineId: string,
    artifact: RtcBaselineAcceptedArtifact
) {
    const path = resolveRtcBaselineAcceptedArtifactPath(artifact);
    return path.ok ? evidence.store.writeJsonCreateNew(baselineId, path.value, artifact) : path;
}

export function decodeRtcBaselineWorkerSamples(
    stdout: string,
    runtimeObservation: RtcBaselineRuntimeObservationDto
): RtcBaselineSampleDto[] {
    const normalized = normalizeRtcBaselineJson(JSON.parse(stdout));
    if (!normalized.ok) {
        throw new Error(JSON.stringify(normalized.issues));
    }
    if (!Array.isArray(normalized.value)) {
        throw new Error('Worker output must be a JSON array.');
    }
    return normalized.value.map((sampleJson) => {
        const decoded = decodeRtcBaselineSample(sampleJson);
        if (!decoded.ok) {
            throw new Error(JSON.stringify(decoded.issues));
        }
        if (!isRtcBaselineSampleDto(decoded.value)) {
            throw new Error('Decoded worker sample is untyped.');
        }
        const issues = validateRtcBaselineSample(decoded.value);
        if (issues.length > 0) {
            throw new Error(JSON.stringify(issues));
        }
        return { ...decoded.value, runtimeObservation };
    });
}

async function runRtcBaselineBunWorker(
    evidence: RtcBaselineBunEvidence,
    freshWorker: BunRtcBaselineAdapters['freshWorker'],
    workerRequest: RtcBaselineBunWorkerRequest
) {
    const workload = RTC_BASELINE_WORKLOAD_CATALOG.find(
        (entry) => entry.workloadId === workerRequest.outerAttempt.workloadId
    );
    const caseEntry = workload?.cases.find(
        (entry) =>
            entry.caseId === workerRequest.outerAttempt.caseId &&
            entry.inputKey === workerRequest.outerAttempt.inputKey
    );
    if (!caseEntry) {
        throw new Error('The manifest outer attempt is absent from the catalog.');
    }
    const environment = await evidence.readEnvironment(workerRequest.baselineId);
    if (!environment.ok) {
        throw new Error(JSON.stringify(environment.issues));
    }
    const runtimeObservation = environment.value.observation;
    if (!runtimeObservation) {
        throw new Error('The initialized runtime observation is absent.');
    }
    const command = createRtcBaselineWorkerCommand({
        baselineId: workerRequest.baselineId,
        caseEntry,
        outerAttempt: workerRequest.outerAttempt,
        resolvedConfiguration: runtimeObservation.resolvedConfiguration
    });
    if (!command.ok) {
        throw new Error(JSON.stringify(command.issues));
    }
    const result = await freshWorker.run(command.value.redactedArgv);
    if (!result.ok) {
        throw new Error(JSON.stringify(result.issues));
    }
    return { outcomes: decodeRtcBaselineWorkerSamples(result.value.stdout, runtimeObservation) };
}

export function createRtcBaselineBunAcceptance(
    evidence: RtcBaselineBunEvidence,
    freshWorker: BunRtcBaselineAdapters['freshWorker']
) {
    return createRtcBaselineEvidenceAcceptance({
        initializeStore: (baselineId, initialization) =>
            initializeRtcBaselineBunStore(evidence, baselineId, initialization),
        readManifest: evidence.readManifest,
        async readInitializedConfiguration(baselineId) {
            const environment = await evidence.readEnvironment(baselineId);
            return environment.ok
                ? { ok: true, value: environment.value.observation?.resolvedConfiguration ?? [] }
                : environment;
        },
        writeAcceptedArtifact: (baselineId, artifact) =>
            writeRtcBaselineAcceptedArtifact(evidence, baselineId, artifact),
        readStagedJson: evidence.store.readJson,
        runFreshWorker: (workerRequest) => runRtcBaselineBunWorker(evidence, freshWorker, workerRequest),
        reconcileAcceptedOperation: evidence.reconcileAcceptedOperation
    });
}
