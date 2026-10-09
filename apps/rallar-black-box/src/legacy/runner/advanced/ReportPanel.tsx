import { decodeRallarBlackBoxConfigProviderMode } from '@shared-test/rallar-bb-test/client-defaults.ts';
import type {
    RallarBlackBoxTestResult,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { useMemo, useState } from 'react';
import { redactedJson } from '../../shared/redaction-presentation.ts';

/** The local run as the report shows it: its identity and outcome, every result and every event. */
interface LocalReportSnapshot {
    readonly reportId: string;
    readonly runId: string | undefined;
    readonly agentId: string | undefined;
    /** The provider mode, or the issue that kept the configuration from naming one. */
    readonly providerMode: string;
    readonly generatedAtEpochMs: number;
    readonly status: RallarBlackBoxTestState['status'];
    readonly config: RallarBlackBoxTestState['currentConfig'];
    readonly loadedRecipe: LocalReportRecipe | undefined;
    readonly summary: LocalReportSummary;
    readonly stats: RallarBlackBoxTestState['latestStats'];
    readonly results: readonly LocalReportResult[];
    readonly events: RallarBlackBoxTestState['events'];
}

interface LocalReportRecipe {
    readonly recipeId: string;
    /** Absent when the recipe carries no name. */
    readonly name: string | undefined;
    readonly commandCount: number;
}

interface LocalReportSummary {
    readonly providerMode: string;
    readonly commands: number;
    readonly failures: number;
    readonly events: number;
    readonly firstFailureCommandId: string | undefined;
}

interface LocalReportResult extends RallarBlackBoxTestResult {
    readonly providerMode: string;
}

function createReportSnapshot(state: RallarBlackBoxTestState): LocalReportSnapshot {
    const providerMode = decodeRallarBlackBoxConfigProviderMode(state.currentConfig).fold(
        (issue) => issue,
        (mode) => mode
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
            {visible && <ReportOutput state={state} authSession={authSession} />}
        </section>
    );
}

/** Mounted only while shown: the snapshot serialises every event and result, and the state changes with each event. */
function ReportOutput({
    state,
    authSession
}: {
    state: RallarBlackBoxTestState;
    authSession?: AuthSession;
}) {
    const reportText = useMemo(
        () => redactedJson(createReportSnapshot(state), state, authSession),
        [authSession, state]
    );

    return (
        <textarea
            className="report-output"
            value={reportText}
            readOnly
            spellCheck={false}
        />
    );
}
