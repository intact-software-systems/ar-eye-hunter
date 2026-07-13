import type { ControlServerSnapshot } from
    '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { AnalyzeTuneArtifactFacade } from
    '../analyze/analyze-worker-contract.ts';
import type { ControlQuerySnapshot } from '../control/control-query.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import {
    deriveTuneSourceModelFromFacade,
    tuneFacadeIsCurrentFocus,
} from './tune-facade-source-model.ts';
import { buildTuneRunCatalog, type TuneRunCatalog } from './tune-run-catalog.ts';
import {
    deriveTuneSourceModel,
    type TuneSourceIssue,
    type TuneSourceModel,
} from './tune-source-model.ts';

export function deriveTuneWorkspaceSourceModel(input: Readonly<{
    urlState: RecipeConsoleUrlState;
    query: ControlQuerySnapshot<ControlServerSnapshot>;
    retained: Readonly<{
        status: 'idle' | 'pending' | 'ready' | 'error';
        model?: AnalyzeTuneArtifactFacade;
        error?: string;
    }>;
    catalog?: TuneRunCatalog;
    sourceSearch?: string;
}>): TuneSourceModel {
    const focusRunId = input.urlState.compareRight ?? input.urlState.distributedRunId;
    const facade = input.retained.model;
    const catalog = input.catalog ?? buildTuneRunCatalog({
        distributedRuns: input.query.snapshot?.distributedRuns ?? [],
        controlRuns: input.query.snapshot?.runs ?? [],
        retainedFacade: facade,
    });
    const current = focusRunId
        ? catalog.options.find(option => option.distributedRunId === focusRunId)
        : undefined;
    const expectedControlRunIds = [
        input.urlState.controlRunId,
        current?.controlEvidence?.distributedRun.controlRunId,
    ].filter((value): value is string => value !== undefined);
    const facadeAuthorityConflict = Boolean(facade && catalog.quarantined.some(row =>
        row.distributedRunId === facade.identity.distributedRunId &&
        row.codes.some(code => code === 'identity-conflict' || code === 'ambiguous-run')
    ));
    const errorHasControlFallback = input.retained.status === 'error' &&
        current?.controlEvidence !== undefined;
    const facadeCurrent = Boolean(
        facade && !facadeAuthorityConflict && !errorHasControlFallback &&
        tuneFacadeIsCurrentFocus(
            facade,
            focusRunId,
            expectedControlRunIds,
        ),
    );
    const source = facade && facadeCurrent
        ? deriveTuneSourceModelFromFacade({
            facade,
            focusRunId,
            sourceSearch: input.sourceSearch,
        })
        : deriveTuneSourceModel({
            catalog,
            query: input.query,
            retained: { status: input.retained.status },
            sourceSearch: input.sourceSearch,
            urlState: input.urlState,
        });
    if (!facade && input.retained.status !== 'error') return source;

    const relation = input.retained.status === 'error'
        ? 'context-error' as const
        : facadeCurrent
        ? 'matching' as const
        : 'mismatched' as const;
    const retainedIssue: TuneSourceIssue | undefined = relation === 'context-error'
        ? {
            code: 'retained-context-error',
            message: input.retained.error ?? 'The retained artifact context is invalid.',
        }
        : relation === 'mismatched'
        ? {
            code: 'retained-mismatch',
            message: 'The retained artifact is stale context for another run.',
        }
        : undefined;
    const issues = retainedIssue
        ? [
            ...source.issues.filter(issue =>
                issue.code !== 'retained-mismatch' &&
                issue.code !== 'retained-context-error'
            ),
            retainedIssue,
        ]
        : source.issues;
    const candidate = relation === 'context-error' &&
        source.provenance.source === 'artifact'
        ? {
              allowed: false,
              reasons: [...new Set([
                  ...source.candidate.reasons,
                  input.retained.error ?? 'The retained artifact context is invalid.',
              ])],
          }
        : source.candidate;
    return {
        ...source,
        provenance: {
            ...source.provenance,
            limitations: issues.map(issue => issue.message),
        },
        retained: {
            relation,
            support: facade?.support,
            inspection: facade?.analysis,
        },
        candidate,
        issues,
    };
}
