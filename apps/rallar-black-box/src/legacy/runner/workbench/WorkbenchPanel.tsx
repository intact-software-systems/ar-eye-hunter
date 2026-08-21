import { useMemo, useState } from 'react';
import {
    RALLAR_BLACK_BOX_MANUAL_COMMAND_EXAMPLE,
    RALLAR_BLACK_BOX_RECIPE_FIXTURES,
    recipeFixtureText
} from '../../../recipe-fixtures.ts';
import { rallarBlackBoxRuntimeStore } from '../../../runtime-store.ts';
import { validateSchemaAuthoringText } from '../../../schema-authoring.ts';
import { CollapsiblePanelSection } from '../../shared/CollapsiblePanelSection.tsx';
import { statusTone } from '../../shared/command-presentation.ts';
import { CommandExamplePicker } from '../../shared/schema/CommandExamplePicker.tsx';
import { SchemaAuthoringPanel } from '../../shared/schema/SchemaAuthoringPanel.tsx';

export function WorkbenchPanel({
    busy,
    runState,
    loadedFixtureId,
    lastError
}: {
    busy: boolean;
    runState: string;
    loadedFixtureId?: string;
    lastError?: string;
}) {
    const [fixtureId, setFixtureId] = useState(
        loadedFixtureId ?? RALLAR_BLACK_BOX_RECIPE_FIXTURES[0].fixtureId
    );
    const [recipeText, setRecipeText] = useState(() => recipeFixtureText(fixtureId));
    const [commandText, setCommandText] = useState(() =>
        JSON.stringify(RALLAR_BLACK_BOX_MANUAL_COMMAND_EXAMPLE, null, 2)
    );
    const [localError, setLocalError] = useState<string | undefined>();
    const recipeValidation = useMemo(
        () => validateSchemaAuthoringText('recipe', recipeText),
        [recipeText]
    );
    const commandValidation = useMemo(
        () => validateSchemaAuthoringText('command', commandText),
        [commandText]
    );

    const runAction = async (action: () => Promise<void>): Promise<void> => {
        setLocalError(undefined);
        try {
            await action();
        }
        catch (error) {
            setLocalError(
                error instanceof Error ? error.message : String(error)
            );
        }
    };

    const selectFixture = (nextFixtureId: string): void => {
        setFixtureId(nextFixtureId);
        setRecipeText(recipeFixtureText(nextFixtureId));
        setLocalError(undefined);
    };

    const fixture = RALLAR_BLACK_BOX_RECIPE_FIXTURES.find(
        (entry) => entry.fixtureId === fixtureId
    ) ?? RALLAR_BLACK_BOX_RECIPE_FIXTURES[0];

    return (
        <section className="panel workbench-panel">
            <div className="panel-heading">
                <h2>Local Workbench</h2>
                <span className={`pill ${statusTone(runState)}`}>
                    {runState}
                </span>
            </div>
            <CollapsiblePanelSection
                title="Workbench Inputs"
                meta={fixture.label}
            >
                <div className="workbench-controls">
                    <label className="field">
                        <span>Fixture</span>
                        <select
                            value={fixtureId}
                            onChange={(event) => selectFixture(event.target.value)}
                            disabled={busy}
                        >
                            {RALLAR_BLACK_BOX_RECIPE_FIXTURES.map((entry) => (
                                <option
                                    key={entry.fixtureId}
                                    value={entry.fixtureId}
                                >
                                    {entry.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <p className="fixture-description">{fixture.description}</p>
                    <div className="workbench-actions">
                        <button
                            type="button"
                            onClick={() =>
                                runAction(() =>
                                    rallarBlackBoxRuntimeStore.loadRecipeFromJson(
                                        recipeText,
                                        fixtureId
                                    )
                                )}
                            disabled={busy || !recipeValidation.ok}
                        >
                            Load
                        </button>
                        <button
                            type="button"
                            onClick={() => runAction(() => rallarBlackBoxRuntimeStore.runLoadedRecipe())}
                            disabled={busy}
                        >
                            Run
                        </button>
                        <button
                            type="button"
                            onClick={() => runAction(() => rallarBlackBoxRuntimeStore.cancelRecipe())}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={() => runAction(() => rallarBlackBoxRuntimeStore.resetWorkbench())}
                            disabled={busy}
                        >
                            Reset
                        </button>
                    </div>
                </div>
                <label className="json-editor">
                    <span>Recipe JSON</span>
                    <textarea
                        value={recipeText}
                        onChange={(event) => setRecipeText(event.target.value)}
                        spellCheck={false}
                        disabled={busy}
                    />
                </label>
                <SchemaAuthoringPanel validation={recipeValidation} />
                <div className="manual-command">
                    <label className="json-editor">
                        <span>Manual Command JSON</span>
                        <textarea
                            value={commandText}
                            onChange={(event) => setCommandText(event.target.value)}
                            spellCheck={false}
                            disabled={busy}
                        />
                    </label>
                    <SchemaAuthoringPanel validation={commandValidation} />
                    <CommandExamplePicker
                        onInsert={setCommandText}
                        onCopy={(text) => void navigator.clipboard?.writeText(text)}
                    />
                    <button
                        type="button"
                        onClick={() =>
                            runAction(() =>
                                rallarBlackBoxRuntimeStore.executeCommandFromJson(
                                    commandText
                                )
                            )}
                        disabled={busy || !commandValidation.ok}
                    >
                        Execute Command
                    </button>
                </div>
            </CollapsiblePanelSection>
            {(localError || lastError) && (
                <div className="workbench-error" role="status">
                    {localError ?? lastError}
                </div>
            )}
        </section>
    );
}
