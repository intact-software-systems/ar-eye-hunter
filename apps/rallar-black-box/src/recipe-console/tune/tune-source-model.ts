import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    DistributedRunAnalysis,
    DistributedRunPerformanceAnalysis
} from '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import type {
    DistributedRunTuningDecisionResult
} from '@shared-test/rallar-bb-test/distributed-run-tuning-decisions.ts';
import { deriveDistributedRunTuningDecisions } from '@shared-test/rallar-bb-test/distributed-run-tuning-decisions.ts';
import {
    inventoryDistributedRunTuningKnobs,
    type DistributedRunTuningInventory
} from '@shared-test/rallar-bb-test/distributed-run-tuning.ts';
import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { AnalyzeArtifactModel } from '../analyze/analyze-artifact-model.ts';
import type { AnalyzeArtifactProjection } from '../analyze/analyze-worker-contract.ts';
import type { ControlQuerySnapshot } from '../control/control-query.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { retainedTuneArtifactIdentityMatches } from './tune-artifact-identity.ts';
import { validateTuneCatalogSelections } from './tune-catalog-selection-validation.ts';
import { projectTuneIdentitySurfaces, type TuneIdentitySurfaces } from './tune-identity.ts';
import { hasTunePerformanceEvidence } from './tune-performance-evidence.ts';
import { tunePerformanceRunIds } from './tune-performance-run-ids.ts';
import { buildTuneRunCatalog, type TuneQuarantineCode, type TuneRunCatalog } from './tune-run-catalog.ts';

export { deriveTuneSourceModelFromFacade } from './tune-facade-source-model.ts';

export type TuneSourceIssueCode =
    | 'missing-focus'
    | 'focus-unavailable'
    | 'retained-mismatch'
    | 'retained-context-error'
    | 'unsupported-artifact'
    | 'partial-control'
    | 'stale-control'
    | 'reference-only'
    | 'missing-performance'
    | 'unsafe-identity'
    | 'ambiguous-focus'
    | 'ambiguous-control'
    | 'invalid-manifest';

export type TuneSourceIssue = Readonly<{
    code: TuneSourceIssueCode;
    message: string;
}>;

export type TuneSourceModel = Readonly<{
    focusRunId?: string;
    provenance: Readonly<{
        source: 'artifact' | 'control' | 'none';
        detail: 'detailed' | 'inspectable' | 'bounded' | 'unavailable';
        controlStatus?: ControlQuerySnapshot<ControlServerSnapshot>['status'];
        generatedAtEpochMs?: number;
        limitations: readonly string[];
    }>;
    retained: Readonly<{
        relation: 'none' | 'matching' | 'mismatched' | 'context-error';
        support?: AnalyzeArtifactModel['workspace']['support'];
        inspection?:
            | AnalyzeArtifactModel['analysis']
            | AnalyzeArtifactProjection['analysis'];
    }>;
    distributedRun?: ControlDistributedRunSnapshot;
    controlRun?: ControlRunSnapshot;
    manifest?: RallarBlackBoxDistributedRunManifest;
    analysis?: DistributedRunAnalysis | AnalyzeArtifactProjection['analysis'];
    performance?: DistributedRunPerformanceAnalysis;
    inventory?: DistributedRunTuningInventory;
    decisions?: DistributedRunTuningDecisionResult;
    identity: TuneIdentitySurfaces;
    legacyRunsHref?: string;
    candidate: Readonly<{ allowed: boolean; reasons: readonly string[]; }>;
    issues: readonly TuneSourceIssue[];
}>;

export function deriveTuneSourceModel(
    input: Readonly<{
        urlState: RecipeConsoleUrlState;
        query: ControlQuerySnapshot<ControlServerSnapshot>;
        retained?: Readonly<{
            status: 'idle' | 'pending' | 'ready' | 'error';
            model?: AnalyzeArtifactModel;
            error?: string;
        }>;
        catalog?: TuneRunCatalog;
        sourceSearch?: string;
    }>
): TuneSourceModel {
    const focusRunId = input.urlState.compareRight ?? input.urlState.distributedRunId;
    const retainedModel = input.retained?.model;
    const unvalidatedCatalog = input.catalog ?? buildTuneRunCatalog({
        distributedRuns: input.query.snapshot?.distributedRuns ?? [],
        controlRuns: input.query.snapshot?.runs ?? [],
        retainedArtifact: retainedModel,
        retainedArtifactStatus: input.retained?.status,
        retainedArtifactFocusRunId: focusRunId,
        performanceRunIds: tunePerformanceRunIds(input.urlState)
    });
    const catalog = validateTuneCatalogSelections(
        unvalidatedCatalog,
        tunePerformanceRunIds(input.urlState)
    );
    const option = focusRunId
        ? catalog.optionsByDistributedRunId.get(focusRunId)
        : undefined;
    const quarantined = focusRunId
        ? catalog.quarantined.find((row) => row.distributedRunId === focusRunId)
        : undefined;
    const expectedControlRunId = option?.controlEvidence?.distributedRun.controlRunId ??
        option?.controlRunId;
    const artifactMatches = Boolean(
        focusRunId && retainedModel && option?.artifactEvidence &&
            retainedTuneArtifactIdentityMatches(retainedModel, focusRunId, expectedControlRunId)
    );
    const contextError = Boolean(retainedModel && input.retained?.status === 'error');
    const retainedRelation: TuneSourceModel['retained']['relation'] = !retainedModel
        ? 'none'
        : contextError
        ? 'context-error'
        : artifactMatches
        ? 'matching'
        : 'mismatched';
    const artifactCurrent = artifactMatches && !contextError &&
        input.retained?.status === 'ready';
    const supportedArtifact = artifactCurrent &&
        retainedModel?.workspace.support === 'supported';
    const inspectableArtifact = artifactCurrent && !supportedArtifact;
    const evidence = artifactCurrent ? option?.artifactEvidence : option?.controlEvidence;
    const distributedRun = evidence?.distributedRun;
    const selectedControlRun = evidence?.controlRun;
    const manifest = distributedRun?.manifest;
    const analysis = artifactCurrent ? option?.artifactEvidence?.analysis : undefined;
    const performance = evidence?.performance;
    const inventory = manifest
        ? inventoryDistributedRunTuningKnobs(manifest)
        : undefined;
    const decisions = inventory
        ? deriveDistributedRunTuningDecisions({
            analysis: supportedArtifact ? analysis : undefined,
            inventory,
            completeness: supportedArtifact ? 'complete' : 'partial'
        })
        : undefined;
    const identity = distributedRun
        ? projectTuneIdentitySurfaces({
            distributedRunId: distributedRun.distributedRunId,
            controlRunId: distributedRun.controlRunId
        }, input.sourceSearch)
        : { quarantined: false, issues: [] };
    const issues = sourceIssues({
        focusRunId,
        hasCurrent: distributedRun !== undefined,
        retainedModel,
        retainedRelation,
        support: retainedModel?.workspace.support,
        queryStatus: input.query.status,
        inventory,
        performance,
        identity,
        contextErrorMessage: input.retained?.error,
        usesControl: !artifactCurrent,
        pairStatus: evidence?.pairStatus,
        quarantineCodes: quarantined?.codes
    });
    const reasons = candidateBlockReasons({
        distributedRun,
        selectedControlRun,
        performance,
        identity,
        queryStatus: input.query.status,
        artifactCurrent,
        supportedArtifact,
        retainedModel
    });
    const source = artifactCurrent ? 'artifact' : distributedRun ? 'control' : 'none';
    const detail = supportedArtifact
        ? 'detailed'
        : inspectableArtifact
        ? 'inspectable'
        : distributedRun
        ? 'bounded'
        : 'unavailable';
    return {
        focusRunId,
        provenance: {
            source,
            detail,
            controlStatus: source === 'control' ? input.query.status : undefined,
            generatedAtEpochMs: artifactCurrent
                ? retainedModel?.provenance.generatedAtEpochMs
                : input.query.receivedAtEpochMs,
            limitations: issues.map((issue) => issue.message)
        },
        retained: {
            relation: retainedRelation,
            support: retainedModel?.workspace.support,
            inspection: retainedModel?.analysis
        },
        distributedRun,
        controlRun: selectedControlRun,
        manifest,
        analysis,
        performance,
        inventory,
        decisions,
        identity,
        legacyRunsHref: identity.legacyRunsHref,
        candidate: { allowed: reasons.length === 0, reasons },
        issues
    };
}

type SourceIssueInput = Readonly<{
    focusRunId?: string;
    hasCurrent: boolean;
    retainedModel?: AnalyzeArtifactModel;
    retainedRelation: TuneSourceModel['retained']['relation'];
    support?: AnalyzeArtifactModel['workspace']['support'];
    queryStatus: ControlQuerySnapshot<ControlServerSnapshot>['status'];
    inventory?: DistributedRunTuningInventory;
    performance?: DistributedRunPerformanceAnalysis;
    identity: TuneIdentitySurfaces;
    contextErrorMessage?: string;
    usesControl: boolean;
    pairStatus?: 'paired' | 'missing' | 'ambiguous';
    quarantineCodes?: readonly TuneQuarantineCode[];
}>;

function sourceIssues(input: SourceIssueInput): TuneSourceIssue[] {
    const issues: TuneSourceIssue[] = [];
    if (!input.focusRunId) {
        addIssue(issues, 'missing-focus', 'Select a distributed run explicitly.');
    }
    else if (input.quarantineCodes?.includes('ambiguous-run')) {
        addIssue(issues, 'ambiguous-focus', 'The selected distributed run identity is ambiguous.');
    }
    else if (input.quarantineCodes?.includes('invalid-manifest')) {
        addIssue(issues, 'invalid-manifest', 'The selected distributed run manifest is malformed.');
    }
    else if (input.quarantineCodes?.some((code) => code === 'unsafe-identity' || code === 'identity-conflict')) {
        addIssue(
            issues,
            'unsafe-identity',
            'The selected run identity is quarantined from navigation and reusable output.'
        );
    }
    else if (!input.hasCurrent) {
        addIssue(issues, 'focus-unavailable', `Run ${input.focusRunId} is unavailable.`);
    }
    if (input.retainedRelation === 'mismatched') {
        addIssue(issues, 'retained-mismatch', 'The retained artifact is stale context for another run.');
    }
    else if (input.retainedRelation === 'context-error') {
        addIssue(
            issues,
            'retained-context-error',
            input.contextErrorMessage ?? 'The retained artifact context is invalid.'
        );
    }
    else if (input.retainedRelation === 'matching' && input.support !== 'supported') {
        addIssue(
            issues,
            'unsupported-artifact',
            input.retainedModel?.workspace.issues[0]?.message ?? 'The retained artifact is not supported.'
        );
    }
    if (input.pairStatus === 'ambiguous') {
        addIssue(issues, 'ambiguous-control', 'Multiple control runs share the selected control identity.');
    }
    if (input.usesControl && input.queryStatus === 'partial') {
        addIssue(issues, 'partial-control', 'Control evidence is partial and bounded.');
    }
    else if (input.usesControl && input.queryStatus === 'stale') {
        addIssue(issues, 'stale-control', 'Control evidence is last-known and stale.');
    }
    if (input.inventory?.limitations.some((row) => row.code === 'reference-only-recipe')) {
        addIssue(
            issues,
            'reference-only',
            'A selected recipe is reference-only and has no authoritative inline knobs.'
        );
    }
    if (input.hasCurrent && !hasTunePerformanceEvidence(input.performance)) {
        addIssue(issues, 'missing-performance', 'No command or RTC stream performance samples are available.');
    }
    if (input.identity.quarantined) {
        addIssue(
            issues,
            'unsafe-identity',
            'The selected run identity is quarantined from navigation and reusable output.'
        );
    }
    return issues;
}

function candidateBlockReasons(
    input: Readonly<{
        distributedRun?: ControlDistributedRunSnapshot;
        selectedControlRun?: ControlRunSnapshot;
        performance?: DistributedRunPerformanceAnalysis;
        identity: TuneIdentitySurfaces;
        queryStatus: ControlQuerySnapshot<ControlServerSnapshot>['status'];
        artifactCurrent: boolean;
        supportedArtifact: boolean;
        retainedModel?: AnalyzeArtifactModel;
    }>
): string[] {
    const reasons: string[] = [];
    if (!input.distributedRun || !input.selectedControlRun) {
        reasons.push('A paired distributed and control run is required.');
    }
    if (!hasTunePerformanceEvidence(input.performance)) {
        reasons.push('Performance evidence is required before creating a candidate.');
    }
    if (input.identity.quarantined) {
        reasons.push('The run identity is unsafe.');
    }
    if (input.artifactCurrent && !input.supportedArtifact) {
        reasons.push(
            input.retainedModel?.workspace.issues[0]?.message ??
                'The retained artifact is not supported.'
        );
    }
    if (!input.artifactCurrent && !['live', 'partial'].includes(input.queryStatus)) {
        reasons.push('Current live or partial control truth is required.');
    }
    return [...new Set(reasons)];
}

function addIssue(
    issues: TuneSourceIssue[],
    code: TuneSourceIssueCode,
    message: string
): void {
    issues.push({ code, message });
}
