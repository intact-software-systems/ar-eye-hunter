import type { AnalyzeArtifactModel } from '../analyze/analyze-artifact-model.ts';
import { retainedTuneArtifactIdentityMatches } from './tune-artifact-identity.ts';
import { projectTuneIdentitySurfaces } from './tune-identity.ts';
import {
    distributedRunManifestContractIssues,
    distributedRunManifestIdentityIssues
} from './tune-run-catalog-safety.ts';
import type { TuneQuarantineCode, TuneRunOption } from './tune-run-catalog.ts';

export type TuneRetainedArtifactCatalogProjection =
    | Readonly<{ kind: 'option'; option: TuneRunOption; }>
    | Readonly<{
        kind: 'quarantine';
        distributedRunId: string;
        controlRunId?: string;
        codes: readonly TuneQuarantineCode[];
        issues: readonly string[];
    }>;

export function projectTuneRetainedArtifactCatalog(
    input: Readonly<{
        artifact: AnalyzeArtifactModel;
        artifactStatus?: 'idle' | 'pending' | 'ready' | 'error';
        artifactFocusRunId?: string;
        current?: TuneRunOption;
        distributedIdentityIsAmbiguous: boolean;
    }>
): TuneRetainedArtifactCatalogProjection {
    const artifact = input.artifact;
    const distributedRun = artifact.snapshots.distributedRun;
    const controlRun = artifact.snapshots.controlRun;
    const authoritative = input.artifactStatus === 'ready' &&
        artifact.workspace.support === 'supported' &&
        input.artifactFocusRunId !== undefined &&
        retainedTuneArtifactIdentityMatches(
            artifact,
            input.artifactFocusRunId,
            distributedRun.controlRunId
        );
    const identity = projectTuneIdentitySurfaces({
        distributedRunId: artifact.identity.distributedRunId,
        controlRunId: artifact.identity.controlRunId ?? distributedRun.controlRunId
    });
    const manifestIssues = [
        ...distributedRunManifestIdentityIssues(distributedRun),
        ...distributedRunManifestContractIssues(distributedRun)
    ];
    if (
        input.distributedIdentityIsAmbiguous ||
        identity.quarantined || !identity.controlRunId || !identity.reactKey ||
        manifestIssues.length > 0 ||
        controlRun.runId !== distributedRun.controlRunId
    ) {
        return {
            kind: 'quarantine',
            distributedRunId: artifact.identity.distributedRunId,
            ...(artifact.identity.controlRunId === undefined
                ? {}
                : { controlRunId: artifact.identity.controlRunId }),
            codes: quarantineCodes(input.distributedIdentityIsAmbiguous, identity, manifestIssues),
            issues: identity.quarantined
                ? identity.issues
                : manifestIssues.length > 0
                ? manifestIssues
                : ['Retained artifact identity or manifest is ambiguous.']
        };
    }
    if (input.current && input.current.controlRunId !== distributedRun.controlRunId) {
        return {
            kind: 'quarantine',
            distributedRunId: distributedRun.distributedRunId,
            controlRunId: distributedRun.controlRunId,
            codes: ['identity-conflict'],
            issues: [
                'Retained artifact control identity conflicts with control evidence.'
            ]
        };
    }
    const artifactEvidence = {
        distributedRun,
        controlRun,
        analysis: artifact.analysis,
        performance: artifact.analysis.performance,
        pairStatus: 'paired' as const
    };
    const artifactOption: TuneRunOption = {
        key: identity.reactKey,
        distributedRunId: distributedRun.distributedRunId,
        controlRunId: distributedRun.controlRunId,
        source: input.current ? 'artifact+control' : 'artifact',
        distributedRun,
        controlRun,
        analysis: artifact.analysis,
        performance: artifact.analysis.performance,
        identity,
        pairStatus: 'paired',
        manifestValidation: 'validated',
        controlEvidence: input.current?.controlEvidence,
        artifactEvidence
    };
    if (authoritative) {
        return { kind: 'option', option: artifactOption };
    }
    if (input.current) {
        return {
            kind: 'option',
            option: { ...input.current, artifactEvidence }
        };
    }
    return {
        kind: 'option',
        option: {
            ...artifactOption,
            controlRun: undefined,
            analysis: undefined,
            performance: undefined,
            pairStatus: 'missing'
        }
    };
}

function quarantineCodes(
    ambiguous: boolean,
    identity: ReturnType<typeof projectTuneIdentitySurfaces>,
    manifestIssues: readonly string[]
): readonly TuneQuarantineCode[] {
    if (ambiguous) {
        return ['ambiguous-run'];
    }
    if (manifestIssues.length > 0) {
        return ['invalid-manifest'];
    }
    if (identity.quarantined || !identity.controlRunId || !identity.reactKey) {
        return ['unsafe-identity'];
    }
    return ['identity-conflict'];
}
