import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    DistributedRunAnalysis,
    DistributedRunPerformanceAnalysis,
} from '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import type { AnalyzeTuneArtifactFacade } from
    '../analyze/analyze-worker-contract.ts';
import { deriveDistributedRunSnapshotPerformance } from
    '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import {
    projectTuneIdentitySurfaces,
    type TuneIdentitySurfaces,
} from './tune-identity.ts';
import { projectTuneFacadeCatalog } from './tune-facade-catalog.ts';
import {
    projectTuneFacadeManifestValidation,
    type TuneFacadeManifestValidation,
} from './tune-facade-manifest-validation.ts';
import { projectTuneRetainedArtifactCatalog } from
    './tune-retained-artifact-catalog.ts';
import {
    boundedTunePerformanceRunIds,
    indexTuneRows,
} from './tune-run-catalog-index.ts';
import {
    distributedRunManifestContractIssues,
    distributedRunManifestIdentityIssues,
} from
    './tune-run-catalog-safety.ts';
import {
    createTuneRunCatalogWork,
    type TuneRunCatalogWork,
} from './tune-run-catalog-work.ts';

export type TuneRunOption = Readonly<{
    key: string;
    distributedRunId: string;
    controlRunId: string;
    source: 'control' | 'artifact' | 'artifact+control';
    distributedRun: ControlDistributedRunSnapshot;
    controlRun?: ControlRunSnapshot;
    analysis?: DistributedRunAnalysis;
    performance?: DistributedRunPerformanceAnalysis;
    identity: TuneIdentitySurfaces;
    pairStatus: 'paired' | 'missing' | 'ambiguous';
    manifestValidation: 'validated' | 'selection-required';
    manifestAuthority?: 'authoritative' | 'summary-projection';
    recipeIdentityComplete?: boolean;
    controlEvidence?: TuneRunEvidence;
    artifactEvidence?: TuneRunEvidence & Readonly<{ analysis: DistributedRunAnalysis }>;
}>;

export type TuneRunEvidence = Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    controlRun?: ControlRunSnapshot;
    performance?: DistributedRunPerformanceAnalysis;
    pairStatus: 'paired' | 'missing' | 'ambiguous';
}>;

export type TuneQuarantineCode =
    | 'ambiguous-run' | 'unsafe-identity' | 'invalid-manifest' | 'identity-conflict';

export type TuneQuarantinedRun = Readonly<{
    key: string;
    distributedRunId: string;
    controlRunId?: string;
    codes: readonly TuneQuarantineCode[];
    issues: readonly string[];
}>;

export type TuneRunCatalog = Readonly<{
    options: readonly TuneRunOption[];
    optionsByDistributedRunId: ReadonlyMap<string, TuneRunOption>;
    quarantined: readonly TuneQuarantinedRun[];
    includePerformanceEvidence: boolean;
    retainedFacadeManifestValidation?: TuneFacadeManifestValidation;
    work: TuneRunCatalogWork;
}>;

export function buildTuneRunCatalog(_input: Readonly<{
    distributedRuns: readonly ControlDistributedRunSnapshot[];
    controlRuns: readonly ControlRunSnapshot[];
    includePerformanceEvidence?: boolean;
    retainedArtifact?: import('../analyze/analyze-artifact-model.ts').AnalyzeArtifactModel;
    retainedArtifactStatus?: 'idle' | 'pending' | 'ready' | 'error';
    retainedArtifactFocusRunId?: string;
    retainedFacade?: AnalyzeTuneArtifactFacade;
    performanceRunIds?: readonly string[];
}>): TuneRunCatalog {
    const input = _input;
    const work = createTuneRunCatalogWork();
    const includePerformanceEvidence = input.includePerformanceEvidence !== false;
    const performanceRunIds = boundedTunePerformanceRunIds(input.performanceRunIds);
    const controlGroups = indexTuneRows(
        input.controlRuns,
        run => run.runId,
        () => { work.controlRowsIndexed += 1; },
    );
    const distributedGroups = indexTuneRows(
        input.distributedRuns,
        run => run.distributedRunId,
        () => { work.distributedRowsIndexed += 1; },
    );
    const ambiguousDistributedIds = new Set(
        [...distributedGroups].filter(([, rows]) => rows.length !== 1).map(([id]) => id),
    );
    const options = new Map<string, TuneRunOption>();
    const quarantined = new Map<string, Omit<TuneQuarantinedRun, 'key'>>();
    let retainedFacadeManifestValidation: TuneFacadeManifestValidation | undefined;
    const quarantine = (
        distributedRunId: string,
        controlRunId: string | undefined,
        codes: readonly TuneQuarantineCode[],
        issues: readonly string[],
    ): void => {
        const identityKey = JSON.stringify([distributedRunId, controlRunId ?? null]);
        quarantined.set(identityKey, { distributedRunId, controlRunId, codes, issues });
    };

    for (const [distributedRunId, rows] of distributedGroups) {
        work.distributedIdentitiesVisited += 1;
        if (rows.length !== 1) {
            quarantine(distributedRunId, undefined, ['ambiguous-run'],
                ['Duplicate distributed run identity is ambiguous.']);
            continue;
        }
        const distributedRun = rows[0];
        work.identityProjections += 1;
        const identity = projectTuneIdentitySurfaces(distributedRun);
        work.manifestIdentityChecks += 1;
        const identityIssues = distributedRunManifestIdentityIssues(distributedRun);
        const validatesManifest = performanceRunIds === undefined ||
            performanceRunIds.has(distributedRunId);
        if (validatesManifest) work.manifestValidations += 1;
        const manifestIssues = [
            ...identityIssues,
            ...(validatesManifest
                ? distributedRunManifestContractIssues(distributedRun)
                : []),
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
                    : manifestIssues,
            );
            continue;
        }
        work.controlPairLookups += 1;
        const controlRows = controlGroups.get(distributedRun.controlRunId) ?? [];
        const pairStatus = controlRows.length === 1
            ? 'paired' as const
            : controlRows.length === 0 ? 'missing' as const : 'ambiguous' as const;
        const controlRun = pairStatus === 'paired' ? controlRows[0] : undefined;
        const derivesPerformance = Boolean(
            controlRun && includePerformanceEvidence &&
            (performanceRunIds === undefined || performanceRunIds.has(distributedRunId)),
        );
        if (derivesPerformance) work.performanceDerivations += 1;
        const performance = controlRun && derivesPerformance
            ? deriveDistributedRunSnapshotPerformance({ distributedRun, controlRun })
            : undefined;
        const controlEvidence: TuneRunEvidence = {
            distributedRun, controlRun, performance, pairStatus,
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
            controlEvidence,
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
                artifact.snapshots.distributedRun.distributedRunId,
            ),
        });
        if (projection.kind === 'quarantine') {
            quarantine(
                projection.distributedRunId,
                projection.controlRunId,
                projection.codes,
                projection.issues,
            );
        } else {
            options.set(projection.option.distributedRunId, projection.option);
        }
    }

    if (input.retainedFacade) {
        work.retainedFacadeProjections += 1;
        const facade = input.retainedFacade;
        retainedFacadeManifestValidation =
            projectTuneFacadeManifestValidation(facade);
        work.retainedFacadeManifestValidations +=
            retainedFacadeManifestValidation.validationCount;
        const projection = projectTuneFacadeCatalog({
            facade,
            current: options.get(facade.identity.distributedRunId),
            distributedIdentityIsAmbiguous:
                ambiguousDistributedIds.has(facade.identity.distributedRunId),
            manifestValidation: retainedFacadeManifestValidation,
        });
        if (projection.kind === 'quarantine') {
            quarantine(
                projection.distributedRunId,
                projection.controlRunId,
                projection.codes,
                projection.issues,
            );
        } else {
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
        work,
    };
}
