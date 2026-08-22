import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import { SchemaAuthoringPanel } from '../../shared/schema/SchemaAuthoringPanel.tsx';
import { formatTime } from '../../shared/time-format.ts';
import { actionLabel } from './manual-workbench-defaults.ts';
import type { ManualRallarWorkbenchModel } from './use-manual-rallar-workbench.ts';

export function ManualRallarExecutionPanel({
    state,
    authSession,
    busy,
    onSelectCommand,
    model
}: {
    state: RallarBlackBoxTestState;
    authSession?: AuthSession;
    busy: boolean;
    onSelectCommand(commandId: string): void;
    model: ManualRallarWorkbenchModel;
}) {
    const {
        values,
        events,
        payloadResult,
        previewCommands,
        previewRecipeValidation,
        negativeRecipeValidation,
        history,
        recipeVisible,
        recipeText,
        manualRecipeValidation,
        runManualAction,
        runRtcMatrix,
        runRtcNackProbe,
        copyRtcMatrixRecipe,
        copyNegativeRecipe,
        setRecipeVisible,
        copyRecipeSnippet
    } = model;

    return (
        <>
            <div className="manual-preview">
                <div className="section-heading">
                    <h3>Command Preview</h3>
                    <span>{previewCommands.length} command</span>
                </div>
                <pre className="json-block">
                    {payloadResult.ok
                        ? redactedJson(
                              previewCommands.length === 1
                                  ? previewCommands[0]
                                  : previewCommands,
                              state,
                              authSession,
                              [values.rallarPassword],
                          )
                        : payloadResult.error}
                </pre>
                {previewRecipeValidation && (
                    <SchemaAuthoringPanel
                        validation={previewRecipeValidation}
                        compact
                    />
                )}
            </div>
            <div className="manual-action-grid">
                {(
                    [
                        'configure',
                        'join',
                        'connect',
                        'send',
                        'health',
                        'close',
                        'reset'
                    ] as const
                ).map((action) => (
                    <button
                        key={action}
                        type="button"
                        disabled={busy || (action === 'send' && !payloadResult.ok)}
                        onClick={() => void runManualAction(action)}
                    >
                        {actionLabel(action)}
                    </button>
                ))}
            </div>
            <div className="manual-matrix-card">
                <div className="section-heading">
                    <h3>RTC Delivery Matrix</h3>
                    <span>direct, multicast, broadcast</span>
                </div>
                <div className="manual-action-grid">
                    <button
                        type="button"
                        disabled={busy || !payloadResult.ok}
                        onClick={() => void runRtcMatrix('realtime')}
                    >
                        Run Realtime Matrix
                    </button>
                    <button
                        type="button"
                        disabled={busy || !payloadResult.ok}
                        onClick={() => void runRtcMatrix('messages.rtc')}
                    >
                        Run Messages Matrix
                    </button>
                    <button
                        type="button"
                        disabled={busy || !payloadResult.ok}
                        onClick={() => void runRtcNackProbe()}
                    >
                        NACK Probe
                    </button>
                    <button
                        type="button"
                        onClick={copyRtcMatrixRecipe}
                        disabled={!payloadResult.ok}
                    >
                        Copy Matrix Recipe
                    </button>
                    <button
                        type="button"
                        onClick={copyNegativeRecipe}
                        disabled={!payloadResult.ok}
                    >
                        Copy Negative Recipe
                    </button>
                </div>
                {negativeRecipeValidation && (
                    <SchemaAuthoringPanel
                        validation={negativeRecipeValidation}
                        compact
                    />
                )}
            </div>
            <div className="manual-history">
                <div className="section-heading">
                    <h3>Manual Actions</h3>
                    <div className="heading-actions">
                        <button
                            type="button"
                            onClick={() => setRecipeVisible((current) => !current)}
                        >
                            {recipeVisible ? 'Hide Recipe' : 'Show Recipe'}
                        </button>
                        <button
                            type="button"
                            onClick={copyRecipeSnippet}
                            disabled={history.length === 0}
                        >
                            Copy Recipe
                        </button>
                    </div>
                </div>
                <div className="manual-action-list">
                    {history.length === 0 && <div className="empty-state">No manual actions</div>}
                    {history
                        .slice()
                        .reverse()
                        .map((entry) => {
                            const relatedEvents = events.filter(
                                (event) =>
                                    event.commandId &&
                                    entry.commandIds.includes(event.commandId)
                            ).length;
                            return (
                                <article
                                    className="manual-action-row"
                                    key={entry.actionId}
                                >
                                    <div>
                                        <strong>{entry.label}</strong>
                                        <small>
                                            {formatTime(entry.atEpochMs)} - {relatedEvents} events
                                        </small>
                                    </div>
                                    <div className="manual-command-links">
                                        {entry.commandIds.map((commandId) => (
                                            <button
                                                type="button"
                                                key={commandId}
                                                onClick={() => onSelectCommand(commandId)}
                                            >
                                                {commandId}
                                            </button>
                                        ))}
                                    </div>
                                </article>
                            );
                        })}
                </div>
                {recipeVisible && (
                    <>
                        <textarea
                            className="report-output manual-recipe-output"
                            value={recipeText}
                            readOnly
                            spellCheck={false}
                        />
                        {manualRecipeValidation && (
                            <SchemaAuthoringPanel
                                validation={manualRecipeValidation}
                                compact
                            />
                        )}
                    </>
                )}
            </div>
        </>
    );
}
