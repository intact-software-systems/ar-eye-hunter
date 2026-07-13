import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    DistributedRunAnalysis,
    DistributedRunPerformanceAnalysis,
} from '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import type { AnalyzeArtifactModel } from '../analyze/analyze-artifact-model.ts';
import type { AnalyzeTuneArtifactFacade } from
    '../analyze/analyze-worker-contract.ts';
import { deriveDistributedRunSnapshotPerformance } from
    '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import { validateDistributedRunManifest } from
    '@shared-test/rallar-bb-test/distributed-run-validation.ts';
import {
    projectTuneIdentitySurfaces,
    type TuneIdentitySurfaces,
} from './tune-identity.ts';
import { retainedTuneArtifactIdentityMatches } from './tune-artifact-identity.ts';
import { projectTuneFacadeCatalog } from './tune-facade-catalog.ts';

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
    quarantined: readonly TuneQuarantinedRun[];
}>;

export function buildTuneRunCatalog(_input: Readonly<{
    distributedRuns: readonly ControlDistributedRunSnapshot[];
    controlRuns: readonly ControlRunSnapshot[];
    includePerformanceEvidence?: boolean;
    retainedArtifact?: AnalyzeArtifactModel;
    retainedArtifactStatus?: 'idle' | 'pending' | 'ready' | 'error';
    retainedArtifactFocusRunId?: string;
    retainedFacade?: AnalyzeTuneArtifactFacade;
}>): TuneRunCatalog {
    const input = _input;
    const controlGroups = groupBy(input.controlRuns, run => run.runId);
    const distributedGroups = groupBy(input.distributedRuns, run => run.distributedRunId);
    const ambiguousDistributedIds = new Set(
        [...distributedGroups].filter(([, rows]) => rows.length !== 1).map(([id]) => id),
    );
    const options = new Map<string, TuneRunOption>();
    const quarantined = new Map<string, Omit<TuneQuarantinedRun, 'key'>>();
    const quarantine = (
        distributedRunId: string,
        controlRunId: string | undefined,
        codes: readonly TuneQuarantineCode[],
        issues: readonly string[],
    ): void => {
        const identityKey = JSON.stringify([distributedRunId, controlRunId ?? null]);
        quarantined.set(identityKey, { distributedRunId, controlRunId, codes, issues });
    };

    for (const [distributedRunId, rows] of [...distributedGroups].sort(([left], [right]) =>
        left.localeCompare(right)
    )) {
        if (rows.length !== 1) {
            quarantine(distributedRunId, undefined, ['ambiguous-run'],
                ['Duplicate distributed run identity is ambiguous.']);
            continue;
        }
        const distributedRun = rows[0];
        const identity = projectTuneIdentitySurfaces(distributedRun);
        const manifestIssues = distributedRunManifestSafetyIssues(distributedRun);
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
        const controlRows = controlGroups.get(distributedRun.controlRunId) ?? [];
        const pairStatus = controlRows.length === 1
            ? 'paired' as const
            : controlRows.length === 0 ? 'missing' as const : 'ambiguous' as const;
        const controlRun = pairStatus === 'paired' ? controlRows[0] : undefined;
        const performance = controlRun && input.includePerformanceEvidence !== false
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
            controlEvidence,
        });
    }

    const artifact = input.retainedArtifact;
    if (artifact) {
        const distributedRun = artifact.snapshots.distributedRun;
        const controlRun = artifact.snapshots.controlRun;
        const artifactAuthoritative = input.retainedArtifactStatus === 'ready' &&
            artifact.workspace.support === 'supported' &&
            input.retainedArtifactFocusRunId !== undefined &&
            retainedTuneArtifactIdentityMatches(
                artifact,
                input.retainedArtifactFocusRunId,
                distributedRun.controlRunId,
            );
        const identity = projectTuneIdentitySurfaces({
            distributedRunId: artifact.identity.distributedRunId,
            controlRunId: artifact.identity.controlRunId ?? distributedRun.controlRunId,
        });
        const manifestIssues = distributedRunManifestSafetyIssues(distributedRun);
        if (
            ambiguousDistributedIds.has(distributedRun.distributedRunId) ||
            identity.quarantined || !identity.controlRunId || !identity.reactKey ||
            manifestIssues.length > 0 ||
            controlRun.runId !== distributedRun.controlRunId
        ) {
            quarantine(
                artifact.identity.distributedRunId,
                artifact.identity.controlRunId,
                ambiguousDistributedIds.has(distributedRun.distributedRunId)
                    ? ['ambiguous-run']
                    : manifestIssues.length > 0
                    ? ['invalid-manifest']
                    : identity.quarantined || !identity.controlRunId || !identity.reactKey
                    ? ['unsafe-identity']
                    : ['identity-conflict'],
                identity.quarantined
                    ? identity.issues
                    : manifestIssues.length > 0
                    ? manifestIssues
                    : ['Retained artifact identity or manifest is ambiguous.'],
            );
        } else {
            const current = options.get(distributedRun.distributedRunId);
            if (current && current.controlRunId !== distributedRun.controlRunId) {
                quarantine(
                    distributedRun.distributedRunId,
                    distributedRun.controlRunId,
                    ['identity-conflict'],
                    ['Retained artifact control identity conflicts with control evidence.'],
                );
            } else {
                const artifactEvidence = {
                    distributedRun,
                    controlRun,
                    analysis: artifact.analysis,
                    performance: artifact.analysis.performance,
                    pairStatus: 'paired' as const,
                };
                const artifactOption: TuneRunOption = {
                    key: identity.reactKey,
                    distributedRunId: distributedRun.distributedRunId,
                    controlRunId: distributedRun.controlRunId,
                    source: current ? 'artifact+control' : 'artifact',
                    distributedRun,
                    controlRun,
                    analysis: artifact.analysis,
                    performance: artifact.analysis.performance,
                    identity,
                    pairStatus: 'paired',
                    controlEvidence: current?.controlEvidence,
                    artifactEvidence,
                };
                if (artifactAuthoritative) {
                    options.set(distributedRun.distributedRunId, artifactOption);
                } else if (current) {
                    options.set(distributedRun.distributedRunId, {
                        ...current,
                        artifactEvidence,
                    });
                } else {
                    options.set(distributedRun.distributedRunId, {
                        ...artifactOption,
                        controlRun: undefined,
                        analysis: undefined,
                        performance: undefined,
                        pairStatus: 'missing',
                    });
                }
            }
        }
    }

    if (input.retainedFacade) {
        const facade = input.retainedFacade;
        const projection = projectTuneFacadeCatalog({
            facade,
            current: options.get(facade.identity.distributedRunId),
            distributedIdentityIsAmbiguous:
                ambiguousDistributedIds.has(facade.identity.distributedRunId),
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
        quarantined: [...quarantined.values()]
            .sort((left, right) =>
                left.distributedRunId.localeCompare(right.distributedRunId) ||
                (left.controlRunId ?? '').localeCompare(right.controlRunId ?? '')
            )
            .map((row, index) => ({ key: `tune-quarantined:${index}`, ...row })),
    };
}

function distributedRunManifestSafetyIssues(
    run: ControlDistributedRunSnapshot,
): string[] {
    try {
        const identityIssues = [
            run.manifest.distributedRunId === run.distributedRunId
                ? undefined
                : 'Manifest distributed-run identity conflicts with its snapshot.',
            run.manifest.controlRunId === run.controlRunId
                ? undefined
                : 'Manifest control-run identity conflicts with its snapshot.',
        ].filter((value): value is string => value !== undefined);
        const validation = validateDistributedRunManifest(run.manifest);
        if (!validation.ok) {
            const first = validation.errors[0];
            identityIssues.push(first
                ? `Distributed run manifest is invalid at ${first.path}: ${first.message}`
                : 'Distributed run manifest is invalid.');
        }
        return identityIssues;
    } catch {
        return ['Distributed run manifest could not be validated safely.'];
    }
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
    const groups = new Map<string, T[]>();
    for (const value of values) groups.set(key(value), [...(groups.get(key(value)) ?? []), value]);
    return groups;
}
