import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { useMemo, useState } from 'react';
import { rallarBlackBoxProviderModeFromConfig } from '../../../runtime-store.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';

function createReportSnapshot(state: RallarBlackBoxTestState): unknown {
    const providerMode = rallarBlackBoxProviderModeFromConfig(
        state.currentConfig
    );
    return {
        reportId: `local-report-${state.currentConfig?.runId ?? 'unconfigured'}`,
        runId: state.currentConfig?.runId,
        agentId: state.currentConfig?.agentId,
        providerMode,
        generatedAtEpochMs: Date.now(),
        status: state.status,
        config: state.currentConfig,
        loadedRecipe: state.loadedRecipe
            ? {
                recipeId: state.loadedRecipe.recipeId,
                name: state.loadedRecipe.name,
                commandCount: state.loadedRecipe.commands.length
            }
            : undefined,
        summary: {
            providerMode,
            commands: state.commandHistory.length,
            failures: state.failures.length,
            events: state.events.length,
            firstFailureCommandId: state.failures[0]?.commandId
        },
        stats: state.latestStats,
        results: state.commandHistory.map((result) => ({
            ...result,
            providerMode
        })),
        events: state.events
    };
}

export function ReportPanel({
    state,
    authSession
}: {
    state: RallarBlackBoxTestState;
    authSession?: AuthSession;
}) {
    const [visible, setVisible] = useState(false);
    const reportText = useMemo(
        () => redactedJson(createReportSnapshot(state), state, authSession),
        [authSession, state]
    );

    return (
        <section className="panel report-panel">
            <div className="panel-heading">
                <h2>Report Snapshot</h2>
                <button
                    type="button"
                    onClick={() => setVisible((current) => !current)}
                >
                    {visible ? 'Hide' : 'Show'}
                </button>
            </div>
            {visible && (
                <textarea
                    className="report-output"
                    value={reportText}
                    readOnly
                    spellCheck={false}
                />
            )}
        </section>
    );
}
