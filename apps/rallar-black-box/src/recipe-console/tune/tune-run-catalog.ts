import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    DistributedRunAnalysis,
    DistributedRunPerformanceAnalysis
} from '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import { computeDistributedRunSnapshotPerformance } from '@shared-test/rallar-bb-test/distributed-run-performance/compute-distributed-run-snapshot-performance.ts';
import type { AnalyzeArtifactModel } from '../analyze/analyze-artifact-model.ts';
import type {
    AnalyzeTuneArtifactFacade,
    AnalyzeWorkerAnalysisProjection
} from '../analyze/analyze-worker-projection-contract.ts';
import { projectTuneFacadeCatalog } from './tune-facade-catalog.ts';
import {
    projectTuneFacadeManifestValidation,
    type TuneFacadeManifestValidation
} from './tune-facade-manifest-validation.ts';
import { projectTuneIdentitySurfaces, type TuneIdentitySurfaces } from './tune-identity.ts';
import { projectTuneRetainedArtifactCatalog } from './tune-retained-artifact-catalog.ts';
import { boundedTunePerformanceRunIds, indexTuneRows } from './tune-run-catalog-index.ts';
import {
    distributedRunManifestContractIssues,
    distributedRunManifestIdentityIssues
} from './tune-run-catalog-safety.ts';
import { createTuneRunCatalogWork, type TuneRunCatalogWork } from './tune-run-catalog-work.ts';

/**
 * The analysis an option carries: the analyzer's own value when the option was built from a loaded
 * artifact model, and the Analyze worker's bounded projection of one when it was built from the
 * retained facade the worker transferred.
 */
export type TuneRunAnalysisEvidence = DistributedRunAnalysis | AnalyzeWorkerAnalysisProjection;

export type TuneRunOption = Readonly<{
    key: string;
    distributedRunId: string;
    controlRunId: string;
    source: 'control' | 'artifact' | 'artifact+control';
    distributedRun: ControlDistributedRunSnapshot;
    /** Absent when no control run pairs with this distributed run, or more than one does. */
    controlRun?: ControlRunSnapshot;
    /** Absent for a control-only option, which carries no analysed artifact. */
    analysis?: TuneRunAnalysisEvidence;
    /** Absent when the option derives no performance evidence for this poll. */
    performance?: DistributedRunPerformanceAnalysis;
    identity: TuneIdentitySurfaces;
    pairStatus: 'paired' | 'missing' | 'ambiguous';
    manifestValidation: 'validated' | 'selection-required';
    /** Absent for a control-only option, whose manifest comes from the control snapshot itself. */
    manifestAuthority?: 'authoritative' | 'summary-projection';
    /** Absent for a control-only option, which carries no bounded recipe-identity window. */
    recipeIdentityComplete?: boolean;
    /** Absent until a control snapshot row backs this option. */
    controlEvidence?: TuneRunEvidence;
    /** Absent until an analysed artifact or retained facade backs this option. */
    artifactEvidence?: TuneRunEvidence & Readonly<{ analysis: TuneRunAnalysisEvidence; }>;
}>;

export type TuneRunEvidence = Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    /** Absent when no control run pairs with this distributed run, or more than one does. */
    controlRun?: ControlRunSnapshot;
    /** Absent when this evidence derives no performance for the selected run. */
    performance?: DistributedRunPerformanceAnalysis;
    pairStatus: 'paired' | 'missing' | 'ambiguous';
}>;

export type TuneQuarantineCode = 'ambiguous-run' | 'unsafe-identity' | 'invalid-manifest' | 'identity-conflict';

export type TuneQuarantinedRun = Readonly<{
    key: string;
    distributedRunId: string;
    /** Absent when the quarantined identity names no control run at all. */
    controlRunId?: string;
    codes: readonly TuneQuarantineCode[];
    issues: readonly string[];
}>;

export type TuneRunCatalog = Readonly<{
    options: readonly TuneRunOption[];
    optionsByDistributedRunId: ReadonlyMap<string, TuneRunOption>;
    quarantined: readonly TuneQuarantinedRun[];
    includePerformanceEvidence: boolean;
    /** Absent when no retained facade was offered to this build. */
    retainedFacadeManifestValidation?: TuneFacadeManifestValidation;
    work: TuneRunCatalogWork;
}>;

export function computeTuneRunCatalog(
    input: Readonly<{
        distributedRuns: readonly ControlDistributedRunSnapshot[];
        controlRuns: readonly ControlRunSnapshot[];
        /** Absent when the caller accepts the default, which derives performance evidence. */
        includePerformanceEvidence?: boolean;
        /** Absent when no analysed artifact is retained for this workspace. */
        retainedArtifact?: AnalyzeArtifactModel;
        /** Absent with `retainedArtifact`. */
        retainedArtifactStatus?: 'idle' | 'pending' | 'ready' | 'error';
        /** Absent when the Tune URL names no focus run. */
        retainedArtifactFocusRunId?: string;
        /** Absent when the Analyze worker transferred no retained facade. */
        retainedFacade?: AnalyzeTuneArtifactFacade;
        /** Absent when every run validates its manifest instead of only the selected ones. */
        performanceRunIds?: readonly string[];
    }>
): TuneRunCatalog {
    const work = createTuneRunCatalogWork();
    const includePerformanceEvidence = input.includePerformanceEvidence !== false;
    const performanceRunIds = boundedTunePerformanceRunIds(input.performanceRunIds);
    const controlGroups = indexTuneRows(
        input.controlRuns,
        (run) => run.runId,
        () => {
            work.controlRowsIndexed += 1;
        }
    );
    const distributedGroups = indexTuneRows(
        input.distributedRuns,
        (run) => run.distributedRunId,
        () => {
            work.distributedRowsIndexed += 1;
        }
    );
    const ambiguousDistributedIds = new Set(
        [...distributedGroups].filter(([, rows]) => rows.length !== 1).map(([id]) => id)
    );
    const options = new Map<string, TuneRunOption>();
    const quarantined = new Map<string, Omit<TuneQuarantinedRun, 'key'>>();
    let retainedFacadeManifestValidation: TuneFacadeManifestValidation | undefined;
    const quarantine = (
        distributedRunId: string,
        controlRunId: string | undefined,
        codes: readonly TuneQuarantineCode[],
        issues: readonly string[]
    ): void => {
        const identityKey = JSON.stringify([distributedRunId, controlRunId ?? null]);
        quarantined.set(identityKey, { distributedRunId, controlRunId, codes, issues });
    };

    for (const [distributedRunId, rows] of distributedGroups) {
        work.distributedIdentitiesVisited += 1;
        if (rows.length !== 1) {
            quarantine(distributedRunId, undefined, ['ambiguous-run'], [
                'Duplicate distributed run identity is ambiguous.'
            ]);
            continue;
        }
        const distributedRun = rows[0];
        work.identityProjections += 1;
        const identity = projectTuneIdentitySurfaces(distributedRun);
        work.manifestIdentityChecks += 1;
        const identityIssues = distributedRunManifestIdentityIssues(distributedRun);
        const validatesManifest = performanceRunIds === undefined ||
            performanceRunIds.has(distributedRunId);
        if (validatesManifest) {
            work.manifestValidations += 1;
        }
        const manifestIssues = [
            ...identityIssues,
            ...(validatesManifest
                ? distributedRunManifestContractIssues(distributedRun)
                : [])
        ];
        if (
            identity.quarantined || !identity.controlRunId || !identity.reactKey ||
            manifestIssues.length > 0
        ) {
            quarantine(
                distributedRun.distributedRunId,
                distributedRun.controlRunId,
                manifestIssues.length > 0
                    ? ['invalid-manifest']
                    : ['unsafe-identity'],
                identity.quarantined
                    ? identity.issues
                    : manifestIssues
            );
            continue;
        }
        work.controlPairLookups += 1;
        const controlRows = controlGroups.get(distributedRun.controlRunId) ?? [];
        const pairStatus = controlRows.length === 1
            ? 'paired' as const
            : controlRows.length === 0
            ? 'missing' as const
            : 'ambiguous' as const;
        const controlRun = pairStatus === 'paired' ? controlRows[0] : undefined;
        const derivesPerformance = Boolean(
            controlRun && includePerformanceEvidence &&
                (performanceRunIds === undefined || performanceRunIds.has(distributedRunId))
        );
        if (derivesPerformance) {
            work.performanceDerivations += 1;
        }
        const performance = controlRun && derivesPerformance
            ? computeDistributedRunSnapshotPerformance({ distributedRun, controlRun })
            : undefined;
        const controlEvidence: TuneRunEvidence = {
            distributedRun,
            controlRun,
            performance,
            pairStatus
        };
        options.set(distributedRun.distributedRunId, {
            key: identity.reactKey,
            distributedRunId: distributedRun.distributedRunId,
            controlRunId: distributedRun.controlRunId,
            source: 'control',
            distributedRun,
            controlRun,
            performance,
            identity,
            pairStatus,
            manifestValidation: validatesManifest
                ? 'validated'
                : 'selection-required',
            controlEvidence
        });
    }

    const artifact = input.retainedArtifact;
    if (artifact) {
        work.retainedArtifactProjections += 1;
        work.manifestIdentityChecks += 1;
        work.retainedArtifactManifestValidations += 1;
        const projection = projectTuneRetainedArtifactCatalog({
            artifact,
            artifactStatus: input.retainedArtifactStatus,
            artifactFocusRunId: input.retainedArtifactFocusRunId,
            current: options.get(artifact.snapshots.distributedRun.distributedRunId),
            distributedIdentityIsAmbiguous: ambiguousDistributedIds.has(
                artifact.snapshots.distributedRun.distributedRunId
            )
        });
        if (projection.kind === 'quarantine') {
            quarantine(
                projection.distributedRunId,
                projection.controlRunId,
                projection.codes,
                projection.issues
            );
        }
        else {
            options.set(projection.option.distributedRunId, projection.option);
        }
    }

    if (input.retainedFacade) {
        work.retainedFacadeProjections += 1;
        const facade = input.retainedFacade;
        retainedFacadeManifestValidation = projectTuneFacadeManifestValidation(facade);
        work.retainedFacadeManifestValidations += retainedFacadeManifestValidation.validationCount;
        const projection = projectTuneFacadeCatalog({
            facade,
            current: options.get(facade.identity.distributedRunId),
            distributedIdentityIsAmbiguous: ambiguousDistributedIds.has(facade.identity.distributedRunId),
            manifestValidation: retainedFacadeManifestValidation
        });
        if (projection.kind === 'quarantine') {
            quarantine(
                projection.distributedRunId,
                projection.controlRunId,
                projection.codes,
                projection.issues
            );
        }
        else {
            options.set(projection.option.distributedRunId, projection.option);
        }
    }

    return {
        options: [...options.values()].sort((left, right) =>
            right.distributedRun.updatedAtEpochMs - left.distributedRun.updatedAtEpochMs ||
            left.distributedRunId.localeCompare(right.distributedRunId)
        ),
        optionsByDistributedRunId: options,
        quarantined: [...quarantined.values()]
            .sort((left, right) =>
                left.distributedRunId.localeCompare(right.distributedRunId) ||
                (left.controlRunId ?? '').localeCompare(right.controlRunId ?? '')
            )
            .map((row, index) => ({ key: `tune-quarantined:${index}`, ...row })),
        includePerformanceEvidence,
        ...(retainedFacadeManifestValidation === undefined
            ? {}
            : { retainedFacadeManifestValidation }),
        work
    };
}
