import type { DistributedRunAnalysis } from
    '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import { deriveDistributedRunTuningDecisions } from
    '@shared-test/rallar-bb-test/distributed-run-tuning-decisions.ts';
import type { DistributedRunTuningInventory } from
    '@shared-test/rallar-bb-test/distributed-run-tuning.ts';
import type { AnalyzeTuneArtifactFacade } from
    '../analyze/analyze-worker-contract.ts';
import {
    resolveTuneFacadeManifestValidation,
    type TuneFacadeManifestValidation,
} from './tune-facade-manifest-validation.ts';
import { projectTuneIdentitySurfaces } from './tune-identity.ts';
import { hasTunePerformanceEvidence } from './tune-performance-evidence.ts';
import { tuneOmittedInventoryMessage } from './tune-source-issue.ts';
import type {
    TuneSourceIssue,
    TuneSourceIssueCode,
    TuneSourceModel,
} from './tune-source-model.ts';

export function deriveTuneSourceModelFromFacade(input: Readonly<{
    facade: AnalyzeTuneArtifactFacade;
    focusRunId?: string;
    manifestValidation?: TuneFacadeManifestValidation;
    sourceSearch?: string;
}>): TuneSourceModel {
    const facade = input.facade;
    const inventory: DistributedRunTuningInventory = {
        knobs: facade.tuningInventory.knobs,
        limitations: facade.tuningInventory.limitations,
    };
    const complete = facade.tuningInventory.omittedKnobs === 0 &&
        facade.tuningInventory.omittedLimitations === 0;
    const decisions = deriveDistributedRunTuningDecisions({
        analysis: facade.support === 'supported'
            ? facade.analysis as DistributedRunAnalysis
            : undefined,
        inventory,
        completeness: complete ? 'complete' : 'partial',
    });
    const identity = projectTuneIdentitySurfaces(facade.identity, input.sourceSearch);
    const issues: TuneSourceIssue[] = [];
    const manifestValidation = resolveTuneFacadeManifestValidation(
        facade, input.manifestValidation,
    );
    const candidateManifestValid = manifestValidation.status === 'valid';
    const supportIssueMessage = facade.supportIssues?.entries.find(
        issue => issue.severity === 'error',
    )?.message ?? facade.supportIssues?.entries[0]?.message;
    const matchingRole = facade.selection.artifactRole === 'focus' ||
        facade.selection.artifactRole === 'compare-right';
    if (!matchingRole) {
        addIssue(issues, 'retained-mismatch',
            'The retained artifact is stale context for another run.');
    }
    if (facade.support !== 'supported') {
        addIssue(issues, 'unsupported-artifact',
            supportIssueMessage ??
            'The retained artifact is not supported for candidate output.');
    }
    if (!complete) {
        addIssue(issues, 'reference-only',
            tuneOmittedInventoryMessage(
                facade.tuningInventory.omittedKnobs,
                facade.tuningInventory.omittedLimitations,
            ));
    }
    if (!hasTunePerformanceEvidence(facade.analysis.performance)) {
        addIssue(issues, 'missing-performance',
            'No command or RTC stream performance samples are available.');
    }
    if (!facade.candidateManifest) {
        addIssue(issues, 'reference-only',
            'Candidate preview requires a bounded authoritative manifest window.');
    } else if (manifestValidation.status === 'invalid') {
        const first = manifestValidation.firstError;
        addIssue(
            issues,
            'invalid-manifest',
            first
                ? `The candidate manifest is invalid at ${first.path}: ${first.message}`
                : 'The candidate manifest is invalid.',
        );
    }
    const reasons = [
        !matchingRole
            ? 'The retained artifact does not match the focused run.'
            : undefined,
        facade.support !== 'supported'
            ? supportIssueMessage ?? 'The retained artifact is not supported.'
            : undefined,
        !facade.candidateManifest
            ? 'The candidate manifest exceeds the active bounded window.'
            : undefined,
        !complete
            ? 'The bounded tuning inventory is incomplete.'
            : undefined,
        facade.candidateManifest && !candidateManifestValid
            ? 'The candidate manifest is invalid.'
            : undefined,
        !hasTunePerformanceEvidence(facade.analysis.performance)
            ? 'Performance evidence is required before creating a candidate.'
            : undefined,
        identity.quarantined ? 'The run identity is unsafe.' : undefined,
    ].filter((reason): reason is string => reason !== undefined);
    return {
        focusRunId: input.focusRunId ?? facade.selection.focusRunId ??
            facade.selection.compareRight ?? facade.identity.distributedRunId,
        provenance: {
            source: 'artifact',
            detail: facade.support === 'supported' ? 'detailed' : 'inspectable',
            generatedAtEpochMs: facade.generatedAtEpochMs,
            limitations: issues.map(issue => issue.message),
        },
        retained: {
            relation: matchingRole ? 'matching' : 'mismatched',
            support: facade.support,
            inspection: facade.analysis,
        },
        manifest: candidateManifestValid ? facade.candidateManifest : undefined,
        analysis: facade.analysis,
        performance: facade.analysis.performance,
        inventory,
        decisions,
        identity,
        legacyRunsHref: identity.legacyRunsHref,
        candidate: { allowed: reasons.length === 0, reasons },
        issues,
    };
}

export function tuneFacadeIsCurrentFocus(
    facade: AnalyzeTuneArtifactFacade,
    focusRunId: string | undefined,
    expectedControlRunIds: readonly string[] = [],
): boolean {
    if (!focusRunId || !facadeIdentityIsConsistent(facade, focusRunId)) return false;
    const facadeControlRunId = facade.identity.controlRunId ??
        facade.distributedRun.controlRunId;
    if (expectedControlRunIds.some(controlRunId =>
        controlRunId !== facadeControlRunId
    )) return false;
    if (facade.selection.artifactRole === 'focus') {
        return facade.selection.focusRunId === focusRunId;
    }
    if (facade.selection.artifactRole === 'compare-right') {
        return facade.selection.compareRight === focusRunId;
    }
    return false;
}

function facadeIdentityIsConsistent(
    facade: AnalyzeTuneArtifactFacade,
    focusRunId: string,
): boolean {
    const distributedIds = [
        facade.identity.distributedRunId,
        facade.manifestSummary.distributedRunId,
        facade.distributedRun.distributedRunId,
        facade.analysis.distributedRunId,
        facade.candidateManifest?.distributedRunId,
    ].filter((value): value is string => value !== undefined);
    const controlIds = [
        facade.identity.controlRunId,
        facade.manifestSummary.controlRunId,
        facade.distributedRun.controlRunId,
        facade.analysis.controlRunId,
        facade.candidateManifest?.controlRunId,
    ].filter((value): value is string => value !== undefined);
    return distributedIds.every(value => value === focusRunId) &&
        controlIds.length > 0 && controlIds.every(value => value === controlIds[0]);
}

function addIssue(
    issues: TuneSourceIssue[],
    code: TuneSourceIssueCode,
    message: string,
): void {
    if (!issues.some(issue => issue.code === code && issue.message === message)) {
        issues.push({ code, message });
    }
}
