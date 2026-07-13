import type {
    ControlDistributedRunSnapshot,
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { DistributedRunAnalysis } from
    '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import type { RallarBlackBoxDistributedRunManifest } from
    '@shared-test/rallar-bb-test/distributed-run.ts';
import { validateDistributedRunManifest } from
    '@shared-test/rallar-bb-test/distributed-run-validation.ts';
import type { AnalyzeTuneArtifactFacade } from
    '../analyze/analyze-worker-contract.ts';
import { projectTuneIdentitySurfaces } from './tune-identity.ts';
import type {
    TuneQuarantineCode,
    TuneRunOption,
} from './tune-run-catalog.ts';

export type TuneFacadeCatalogProjection =
    | Readonly<{ kind: 'option'; option: TuneRunOption }>
    | Readonly<{
        kind: 'quarantine';
        distributedRunId: string;
        controlRunId?: string;
        codes: readonly TuneQuarantineCode[];
        issues: readonly string[];
    }>;

export function projectTuneFacadeCatalog(input: Readonly<{
    facade: AnalyzeTuneArtifactFacade;
    current?: TuneRunOption;
    distributedIdentityIsAmbiguous: boolean;
}>): TuneFacadeCatalogProjection {
    const facade = input.facade;
    const distributedRunId = facade.identity.distributedRunId;
    const controlRunId = facade.identity.controlRunId ?? facade.distributedRun.controlRunId;
    if (input.distributedIdentityIsAmbiguous) {
        return quarantine(distributedRunId, controlRunId, 'ambiguous-run',
            'Duplicate distributed run identity is ambiguous.');
    }
    if (!facadeIdentityIsConsistent(facade, distributedRunId, controlRunId)) {
        return quarantine(distributedRunId, controlRunId, 'identity-conflict',
            'Retained facade identities conflict across its bounded projections.');
    }
    const identity = projectTuneIdentitySurfaces({ distributedRunId, controlRunId });
    if (identity.quarantined || !identity.reactKey || !identity.controlRunId) {
        return {
            kind: 'quarantine',
            distributedRunId,
            controlRunId,
            codes: ['unsafe-identity'],
            issues: identity.issues.length > 0
                ? identity.issues
                : ['Retained facade identity is unsafe.'],
        };
    }
    if (input.current && input.current.controlRunId !== controlRunId) {
        return quarantine(distributedRunId, controlRunId, 'identity-conflict',
            'Retained facade control identity conflicts with control evidence.');
    }

    const manifest = facade.candidateManifest ?? manifestSummaryProjection(facade);
    const validation = facade.candidateManifest
        ? validateDistributedRunManifest(manifest)
        : undefined;
    if (validation && !validation.ok) {
        const first = validation.errors[0];
        return quarantine(
            distributedRunId,
            controlRunId,
            'invalid-manifest',
            first
                ? `Retained facade manifest is invalid at ${first.path}: ${first.message}`
                : 'Retained facade manifest is invalid.',
        );
    }
    const distributedRun = facadeSnapshot(facade, manifest);
    const artifactEvidence = {
        distributedRun,
        analysis: facade.analysis as unknown as DistributedRunAnalysis,
        performance: facade.analysis.performance,
        pairStatus: 'missing' as const,
    };
    if (input.current) {
        return {
            kind: 'option',
            option: input.current.artifactEvidence
                ? input.current
                : { ...input.current, artifactEvidence },
        };
    }
    return {
        kind: 'option',
        option: {
            key: identity.reactKey,
            distributedRunId,
            controlRunId,
            source: 'artifact',
            distributedRun,
            analysis: facade.analysis as unknown as DistributedRunAnalysis,
            performance: facade.analysis.performance,
            identity,
            pairStatus: 'missing',
            manifestAuthority: facade.candidateManifest
                ? 'authoritative'
                : 'summary-projection',
            recipeIdentityComplete: facade.manifestSummary.recipeIds.omitted === 0,
            artifactEvidence,
        },
    };
}

function facadeIdentityIsConsistent(
    facade: AnalyzeTuneArtifactFacade,
    distributedRunId: string,
    controlRunId: string,
): boolean {
    const distributedIds = [
        facade.manifestSummary.distributedRunId,
        facade.distributedRun.distributedRunId,
        facade.analysis.distributedRunId,
        facade.candidateManifest?.distributedRunId,
    ].filter((value): value is string => value !== undefined);
    const controlIds = [
        facade.manifestSummary.controlRunId,
        facade.distributedRun.controlRunId,
        facade.analysis.controlRunId,
        facade.candidateManifest?.controlRunId,
    ].filter((value): value is string => value !== undefined);
    return distributedIds.every(value => value === distributedRunId) &&
        controlIds.every(value => value === controlRunId);
}

function manifestSummaryProjection(
    facade: AnalyzeTuneArtifactFacade,
): RallarBlackBoxDistributedRunManifest {
    const summary = facade.manifestSummary;
    return {
        schemaVersion: 1,
        distributedRunId: summary.distributedRunId,
        controlRunId: summary.controlRunId ?? facade.distributedRun.controlRunId,
        displayName: summary.displayName,
        group: summary.group,
        startMode: summary.startMode,
        recipes: summary.recipeIds.entries.map(recipeId => ({ recipeId })),
        targetPolicy: {
            mode: summary.targetPolicy.mode,
            expectedParticipantCount: summary.targetPolicy.expectedParticipantCount,
            agentIds: facade.distributedRun.targetAgentIds.entries,
        },
    };
}

function facadeSnapshot(
    facade: AnalyzeTuneArtifactFacade,
    manifest: RallarBlackBoxDistributedRunManifest,
): ControlDistributedRunSnapshot {
    const run = facade.distributedRun;
    return {
        distributedRunId: run.distributedRunId,
        controlRunId: run.controlRunId,
        manifest,
        state: run.state,
        createdAtEpochMs: run.startedAtEpochMs ?? run.updatedAtEpochMs,
        updatedAtEpochMs: run.updatedAtEpochMs,
        startedAtEpochMs: run.startedAtEpochMs,
        completedAtEpochMs: run.completedAtEpochMs,
        targetAgentIds: run.targetAgentIds.entries,
        commandLinks: [],
        rollup: run.rollup,
    };
}

function quarantine(
    distributedRunId: string,
    controlRunId: string | undefined,
    code: TuneQuarantineCode,
    issue: string,
): TuneFacadeCatalogProjection {
    return {
        kind: 'quarantine',
        distributedRunId,
        controlRunId,
        codes: [code],
        issues: [issue],
    };
}
