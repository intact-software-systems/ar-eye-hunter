import { useMemo, useState } from 'react';

import { decodeRallarBlackBoxConfigProviderMode } from '@shared-test/rallar-bb-test/client-defaults.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import { redactedJson } from '../../shared/redaction-presentation.ts';

interface ReportSnapshot {
    readonly reportId: string;
    readonly runId: string | undefined;
    readonly agentId: string | undefined;
    readonly providerMode: string;
    readonly generatedAtEpochMs: number;
    readonly status: RallarBlackBoxTestState['status'];
    readonly config: RallarBlackBoxTestState['currentConfig'];
    readonly loadedRecipe: {
        readonly recipeId: string;
        readonly name: string | undefined;
        readonly commandCount: number;
    } | undefined;
    readonly summary: {
        readonly providerMode: string;
        readonly commands: number;
        readonly failures: number;
        readonly events: number;
        readonly firstFailureCommandId: string | undefined;
    };
    readonly stats: RallarBlackBoxTestState['latestStats'];
    readonly results:
        readonly (RallarBlackBoxTestState['commandHistory'][number] & { readonly providerMode: string; })[];
    readonly events: RallarBlackBoxTestState['events'];
}

export function ReportPanel({
    state,
    authSession,
    active
}: {
    active: boolean;
    state: RallarBlackBoxTestState;
    authSession?: AuthSession;
}) {
    const [visible, setVisible] = useState(false);
    const reportText = useMemo(
        () => active && visible ? redactedJson(toReportSnapshot(state, Date.now()), state, authSession) : '',
        [active, authSession, state, visible]
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
            {active && visible && (
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

function toReportSnapshot(state: RallarBlackBoxTestState, generatedAtEpochMs: number): ReportSnapshot {
    const providerMode = decodeRallarBlackBoxConfigProviderMode(state.currentConfig).fold(
        (issue) => issue,
        (mode) => mode
    );
    return {
        reportId: `local-report-${state.currentConfig?.runId ?? 'unconfigured'}`,
        runId: state.currentConfig?.runId,
        agentId: state.currentConfig?.agentId,
        providerMode,
        generatedAtEpochMs,
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
