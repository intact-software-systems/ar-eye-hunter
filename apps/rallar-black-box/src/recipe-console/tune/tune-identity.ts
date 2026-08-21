import type { AnalyzeImportedArtifactIdentity } from '../analyze/analyze-identity-policy.ts';
import { analyzeArtifactIdentityIssues, safeAnalyzeArtifactIdentity } from '../analyze/analyze-identity-policy.ts';
import { createAnalyzeLegacyRunsHref } from '../analyze/analyze-legacy-links.ts';
import { createDistributedRunArtifactDownload } from '../control/distributed-run-artifact-download.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';

export type TuneIdentitySurfaces = Readonly<{
    quarantined: boolean;
    issues: readonly string[];
    distributedRunId?: string;
    controlRunId?: string;
    compareValue?: string;
    reactKey?: string;
    candidateFilename?: string;
    legacyRunsHref?: string;
}>;

export function projectTuneIdentitySurfaces(
    identity: AnalyzeImportedArtifactIdentity,
    sourceSearch = ''
): TuneIdentitySurfaces {
    const safe = safeAnalyzeArtifactIdentity(identity);
    const issues = analyzeArtifactIdentityIssues(identity);
    const complete = safe.distributedRunId !== undefined && (
        identity.controlRunId === undefined || safe.controlRunId !== undefined
    );
    if (!complete || issues.length > 0) {
        return { quarantined: true, issues };
    }

    const distributedRunId = safe.distributedRunId as string;
    const candidateFilename = createDistributedRunArtifactDownload(
        {},
        distributedRunId
    ).filename.replace(/-artifact\.json$/, '-tuning-candidate.json');
    const legacyState: RecipeConsoleUrlState = {
        v: 1,
        experience: 'recipe-console',
        view: 'tune',
        distributedRunId,
        controlRunId: safe.controlRunId
    };
    return {
        quarantined: false,
        issues,
        distributedRunId,
        controlRunId: safe.controlRunId,
        compareValue: distributedRunId,
        reactKey: `tune-run:${distributedRunId}`,
        candidateFilename,
        legacyRunsHref: createAnalyzeLegacyRunsHref(legacyState, sourceSearch)
    };
}
