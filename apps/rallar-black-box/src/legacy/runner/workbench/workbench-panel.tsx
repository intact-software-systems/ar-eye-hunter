import { useMemo, useState } from 'react';

import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    RALLAR_BLACK_BOX_RECIPE_FIXTURES,
    toRecipeFixtureText,
    type RallarBlackBoxRecipeFixture
} from '@shared-test/rallar-bb-test/recipe-fixtures.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { parseRtcCaptureMode } from '@shared/webrtc/rtc-capture-configuration.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import { rallarBlackBoxRuntimeStore } from '../../../runtime-store.ts';
import { validateSchemaAuthoringText, type SchemaAuthoringValidation } from '../../../schema-authoring.ts';
import { CollapsiblePanelSection } from '../../shared/CollapsiblePanelSection.tsx';
import { statusTone } from '../../shared/command-presentation.ts';
import { CommandExamplePicker } from '../../shared/schema/CommandExamplePicker.tsx';
import { SchemaAuthoringPanel } from '../../shared/schema/SchemaAuthoringPanel.tsx';
import { RALLAR_BLACK_BOX_MANUAL_COMMAND_EXAMPLE } from './rallar-black-box-manual-command-example.ts';

interface WorkbenchDraft {
    readonly fixtureId: string;
    readonly fixture: RallarBlackBoxRecipeFixture;
    readonly recipeText: string;
    readonly commandText: string;
    readonly rtcCaptureMode: RtcSignalingDiagnostics.CaptureMode | undefined;
    readonly localError: string | undefined;
    readonly recipeValidation: SchemaAuthoringValidation;
    readonly commandValidation: SchemaAuthoringValidation;
    selectFixture(fixtureId: string): void;
    setRecipeText(text: string): void;
    setCommandText(text: string): void;
    setRtcCaptureMode(mode: RtcSignalingDiagnostics.CaptureMode | undefined): void;
    setLocalError(error: string | undefined): void;
}

interface WorkbenchDraftControls {
    readonly busy: boolean;
    readonly draft: WorkbenchDraft;
}

interface WorkbenchPanelProps {
    readonly busy: boolean;
    readonly runState: string;
    readonly loadedRecipe: RallarBlackBoxTestRecipe | undefined;
    /** Absent for a hand-authored recipe or after reset. */
    readonly loadedFixtureId?: string;
    /** Absent while the last runtime action carries no failure. */
    readonly lastError?: string;
}

export function WorkbenchPanel({ busy, runState, loadedRecipe, loadedFixtureId, lastError }: WorkbenchPanelProps) {
    const draft = useWorkbenchDraft(loadedRecipe, loadedFixtureId);
    return (
        <section className="panel workbench-panel">
            <div className="panel-heading">
                <h2>Local Workbench</h2>
                <span className={`pill ${statusTone(runState)}`}>{runState}</span>
            </div>
            <CollapsiblePanelSection title="Workbench Inputs" meta={draft.fixture.label}>
                <WorkbenchRecipeEditor busy={busy} draft={draft} />
                <WorkbenchManualCommandEditor busy={busy} draft={draft} />
            </CollapsiblePanelSection>
            {(draft.localError || lastError) && (
                <div className="workbench-error" role="status">{draft.localError ?? lastError}</div>
            )}
        </section>
    );
}

function useWorkbenchDraft(
    loadedRecipe: RallarBlackBoxTestRecipe | undefined,
    loadedFixtureId: string | undefined
): WorkbenchDraft {
    const [fixtureId, setFixtureId] = useState(loadedFixtureId ?? RALLAR_BLACK_BOX_RECIPE_FIXTURES[0].fixtureId);
    const [recipeText, setRecipeText] = useState(() =>
        loadedRecipe === undefined ? toRecipeFixtureText(fixtureId) : JSON.stringify(loadedRecipe, null, 2)
    );
    const [commandText, setCommandText] = useState(() =>
        JSON.stringify(RALLAR_BLACK_BOX_MANUAL_COMMAND_EXAMPLE, null, 2)
    );
    const [rtcCaptureMode, setRtcCaptureMode] = useState<RtcSignalingDiagnostics.CaptureMode | undefined>();
    const [localError, setLocalError] = useState<string | undefined>();
    const recipeValidation = useMemo(() => validateSchemaAuthoringText('recipe', recipeText), [recipeText]);
    const commandValidation = useMemo(() => validateSchemaAuthoringText('command', commandText), [commandText]);
    const fixture = RALLAR_BLACK_BOX_RECIPE_FIXTURES.find((entry) => entry.fixtureId === fixtureId) ??
        RALLAR_BLACK_BOX_RECIPE_FIXTURES[0];
    return {
        fixtureId,
        fixture,
        recipeText,
        commandText,
        rtcCaptureMode,
        localError,
        recipeValidation,
        commandValidation,
        setRecipeText,
        setCommandText,
        setRtcCaptureMode,
        setLocalError,
        selectFixture(nextFixtureId) {
            setFixtureId(nextFixtureId);
            setRecipeText(toRecipeFixtureText(nextFixtureId));
            setLocalError(undefined);
        }
    };
}

async function runWorkbenchAction(
    action: () => Promise<void>,
    setError: WorkbenchDraft['setLocalError']
): Promise<void> {
    setError(undefined);
    try {
        await action();
    }
    catch (error) {
        setError(error instanceof Error ? error.message : String(error));
    }
}

async function runDecodedWorkbenchAction<T>(
    action: () => Promise<Either<string, T>>,
    setError: WorkbenchDraft['setLocalError']
): Promise<void> {
    setError(undefined);
    const outcome = await action();
    setError(outcome.left);
}

function WorkbenchRecipeEditor({ busy, draft }: WorkbenchDraftControls) {
    return (
        <>
            <div className="workbench-controls">
                <WorkbenchFixturePicker busy={busy} draft={draft} />
                <p className="fixture-description">{draft.fixture.description}</p>
                <WorkbenchRunCaptureChoice busy={busy} draft={draft} />
                <WorkbenchRecipeActions busy={busy} draft={draft} />
            </div>
            <label className="json-editor">
                <span>Recipe JSON</span>
                <textarea
                    value={draft.recipeText}
                    onChange={(event) => draft.setRecipeText(event.target.value)}
                    spellCheck={false}
                    disabled={busy}
                />
            </label>
            <SchemaAuthoringPanel validation={draft.recipeValidation} />
        </>
    );
}

function WorkbenchFixturePicker({ busy, draft }: WorkbenchDraftControls) {
    return (
        <label className="field">
            <span>Fixture</span>
            <select
                value={draft.fixtureId}
                onChange={(event) => draft.selectFixture(event.target.value)}
                disabled={busy}
            >
                {RALLAR_BLACK_BOX_RECIPE_FIXTURES.map((entry) => (
                    <option key={entry.fixtureId} value={entry.fixtureId}>{entry.label}</option>
                ))}
            </select>
        </label>
    );
}

function WorkbenchRunCaptureChoice({ busy, draft }: WorkbenchDraftControls) {
    return (
        <label className="field">
            <span>Run RTC capture</span>
            <select
                value={draft.rtcCaptureMode ?? ''}
                onChange={(event) => {
                    const value = event.target.value;
                    parseRtcCaptureMode(value === '' ? undefined : value).foldRight(({ mode }) =>
                        draft.setRtcCaptureMode(mode)
                    );
                }}
                disabled={busy}
            >
                <option value="">Inherit</option>
                <option value="off">Off</option>
                <option value="signaling">Signaling</option>
                <option value="native">Full native</option>
            </select>
        </label>
    );
}

function WorkbenchRecipeActions({ busy, draft }: WorkbenchDraftControls) {
    return (
        <div className="workbench-actions">
            <button
                type="button"
                onClick={() =>
                    runDecodedWorkbenchAction(
                        () =>
                            rallarBlackBoxRuntimeStore.loadRecipeFromJson(
                                draft.recipeText,
                                resolveWorkbenchFixtureId(draft)
                            ),
                        draft.setLocalError
                    )}
                disabled={busy || !draft.recipeValidation.ok}
            >
                Load
            </button>
            <button
                type="button"
                onClick={() =>
                    runWorkbenchAction(
                        () => rallarBlackBoxRuntimeStore.runLoadedRecipe(draft.rtcCaptureMode),
                        draft.setLocalError
                    )}
                disabled={busy}
            >
                Run
            </button>
            <button
                type="button"
                onClick={() => runWorkbenchAction(() => rallarBlackBoxRuntimeStore.cancelRecipe(), draft.setLocalError)}
            >
                Cancel
            </button>
            <button
                type="button"
                onClick={() =>
                    runWorkbenchAction(() => rallarBlackBoxRuntimeStore.resetWorkbench(), draft.setLocalError)}
                disabled={busy}
            >
                Reset
            </button>
        </div>
    );
}

function WorkbenchManualCommandEditor({ busy, draft }: WorkbenchDraftControls) {
    return (
        <div className="manual-command">
            <label className="json-editor">
                <span>Manual Command JSON</span>
                <textarea
                    value={draft.commandText}
                    onChange={(event) => draft.setCommandText(event.target.value)}
                    spellCheck={false}
                    disabled={busy}
                />
            </label>
            <SchemaAuthoringPanel validation={draft.commandValidation} />
            <CommandExamplePicker
                onInsert={draft.setCommandText}
                onCopy={(text) => void navigator.clipboard?.writeText(text)}
            />
            <button
                type="button"
                onClick={() =>
                    runDecodedWorkbenchAction(
                        () => rallarBlackBoxRuntimeStore.runCommandFromJsonText(draft.commandText),
                        draft.setLocalError
                    )}
                disabled={busy || !draft.commandValidation.ok}
            >
                Execute Command
            </button>
        </div>
    );
}

function resolveWorkbenchFixtureId(draft: WorkbenchDraft): string | undefined {
    return JSON.stringify(draft.recipeValidation.parsed) === JSON.stringify(draft.fixture.recipe)
        ? draft.fixtureId
        : undefined;
}
