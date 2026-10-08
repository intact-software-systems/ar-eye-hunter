import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import type { ManualActionHistoryEntry } from '../../../manual-workbench.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import { SchemaAuthoringPanel } from '../../shared/schema/SchemaAuthoringPanel.tsx';
import { formatTime } from '../../shared/time-format.ts';
import { toManualActionLabel } from './to-manual-action-label.ts';
import type { ManualRallarWorkbenchModel } from './use-manual-rallar-workbench.ts';

export interface ManualRallarExecutionPanelProps {
    readonly state: RallarBlackBoxTestState;
    /** Absent while signed out; redaction then has no session secrets to hide. */
    readonly authSession: AuthSession | undefined;
    readonly busy: boolean;
    onSelectCommand(commandId: string): void;
    readonly model: ManualRallarWorkbenchModel;
}

interface ManualHistoryEntryProps {
    readonly entry: ManualActionHistoryEntry;
    readonly events: ManualRallarWorkbenchModel['events'];
    onSelectCommand(commandId: string): void;
}

export function ManualRallarExecutionPanel(props: ManualRallarExecutionPanelProps) {
    return (
        <>
            <ManualCommandPreview {...props} />
            <ManualActionButtons {...props} />
            <ManualRtcMatrix {...props} />
            <ManualSubmittedHistory {...props} />
        </>
    );
}

function ManualCommandPreview({ state, authSession, model }: ManualRallarExecutionPanelProps) {
    return (
        <div className="manual-preview">
            <div className="section-heading">
                <h3>Command Preview</h3>
                <span>{model.previewCommands.length} command</span>
            </div>
            <pre className="json-block">
                {model.payloadResult.fold(
                    (error) => error,
                    () => redactedJson(
                        model.previewCommands.length === 1 ? model.previewCommands[0] : model.previewCommands,
                        state,
                        authSession,
                        [model.values.rallarPassword]
                    )
                )}
            </pre>
            {model.previewRecipeValidation && (
                <SchemaAuthoringPanel validation={model.previewRecipeValidation} compact />
            )}
        </div>
    );
}

function ManualActionButtons({ busy, model }: ManualRallarExecutionPanelProps) {
    const payloadValid = model.payloadResult.right !== undefined;
    const rtcRefused = model.values.transport !== 'ws' && model.rtcReadinessResult.left !== undefined;
    return (
        <div className="manual-action-grid">
            {(['configure', 'join', 'connect', 'send', 'health', 'close', 'reset'] as const).map((action) => (
                <button
                    key={action}
                    type="button"
                    disabled={busy || (action === 'send' && !payloadValid) ||
                        ((action === 'connect' || action === 'join') && rtcRefused)}
                    onClick={() => void model.runManualAction(action)}
                >
                    {toManualActionLabel(action)}
                </button>
            ))}
        </div>
    );
}

function ManualRtcMatrix(props: ManualRallarExecutionPanelProps) {
    return (
        <div className="manual-matrix-card">
            <div className="section-heading">
                <h3>RTC Delivery Matrix</h3>
                <span>direct, multicast, broadcast</span>
            </div>
            <div className="manual-action-grid">
                <ManualRtcRunButtons {...props} />
                <ManualRtcCopyButtons {...props} />
            </div>
            {props.model.negativeRecipeValidation && (
                <SchemaAuthoringPanel validation={props.model.negativeRecipeValidation} compact />
            )}
        </div>
    );
}

function ManualRtcRunButtons({ busy, model }: ManualRallarExecutionPanelProps) {
    const payloadValid = model.payloadResult.right !== undefined;
    const rtcRefused = model.rtcReadinessResult.left !== undefined;
    return (
        <>
            <button
                type="button"
                disabled={busy || !payloadValid || rtcRefused}
                onClick={() => void model.runRtcMatrix('realtime')}
            >
                Run Realtime Matrix
            </button>
            <button
                type="button"
                disabled={busy || !payloadValid || rtcRefused}
                onClick={() => void model.runRtcMatrix('messages.rtc')}
            >
                Run Messages Matrix
            </button>
            <button type="button" disabled={busy || !payloadValid} onClick={() => void model.runRtcNackProbe()}>
                NACK Probe
            </button>
        </>
    );
}

function ManualRtcCopyButtons({ model }: ManualRallarExecutionPanelProps) {
    const payloadValid = model.payloadResult.right !== undefined;
    const rtcRefused = model.rtcReadinessResult.left !== undefined;
    return (
        <>
            <button type="button" onClick={model.copyRtcMatrixRecipe} disabled={!payloadValid || rtcRefused}>
                Copy Matrix Recipe
            </button>
            <button type="button" onClick={model.copyNegativeRecipe} disabled={!payloadValid || rtcRefused}>
                Copy Negative Recipe
            </button>
        </>
    );
}

function ManualSubmittedHistory({ model, onSelectCommand }: ManualRallarExecutionPanelProps) {
    return (
        <div className="manual-history">
            <div className="section-heading">
                <h3>Manual Actions</h3>
                <div className="heading-actions">
                    <button type="button" onClick={() => model.setRecipeVisible((current) => !current)}>
                        {model.recipeVisible ? 'Hide Recipe' : 'Show Recipe'}
                    </button>
                    <button type="button" onClick={model.copyRecipeSnippet} disabled={model.history.length === 0}>
                        Copy Recipe
                    </button>
                </div>
            </div>
            <div className="manual-action-list">
                {model.history.length === 0 && <div className="empty-state">No manual actions</div>}
                {model.history.slice().reverse().map((entry) => (
                    <ManualHistoryEntry
                        key={entry.actionId}
                        entry={entry}
                        events={model.events}
                        onSelectCommand={onSelectCommand}
                    />
                ))}
            </div>
            <ManualRecipeOutput model={model} />
        </div>
    );
}

function ManualHistoryEntry({ entry, events, onSelectCommand }: ManualHistoryEntryProps) {
    const relatedEvents =
        events.filter((event) => event.commandId && entry.commandIds.includes(event.commandId)).length;
    return (
        <article className="manual-action-row">
            <div>
                <strong>{entry.label}</strong>
                <small>{formatTime(entry.atEpochMs)} - {relatedEvents} events</small>
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
}

function ManualRecipeOutput({ model }: Pick<ManualRallarExecutionPanelProps, 'model'>) {
    if (!model.recipeVisible) {
        return null;
    }
    return (
        <>
            <textarea
                className="report-output manual-recipe-output"
                value={model.recipeText}
                readOnly
                spellCheck={false}
            />
            {model.manualRecipeValidation && <SchemaAuthoringPanel validation={model.manualRecipeValidation} compact />}
        </>
    );
}
