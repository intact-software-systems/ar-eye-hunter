import { useMemo, useState } from 'react';
import {
    commandExampleSnippets,
    validateSchemaAuthoringText,
    type CommandExampleSnippet,
} from '../../../schema-authoring.ts';
import { SchemaAuthoringPanel } from './SchemaAuthoringPanel.tsx';

export function CommandExamplePicker({
    onInsert,
    onCopy,
}: {
    onInsert(text: string): void;
    onCopy(text: string): void;
}) {
    const snippets = useMemo(() => commandExampleSnippets(), []);
    const [selectedKind, setSelectedKind] = useState(
        snippets[0]?.kind ?? 'health',
    );
    const selected =
        snippets.find((snippet) => snippet.kind === selectedKind) ??
        snippets[0];
    if (!selected) {
        return null;
    }
    const selectedValidation = validateSchemaAuthoringText(
        'command',
        selected.commandText,
    );

    return (
        <section className="command-example-picker">
            <div className="section-heading compact">
                <h3>Command Examples</h3>
                <span>{snippets.length} generated</span>
            </div>
            <div className="command-example-controls">
                <label className="field">
                    <span>Kind</span>
                    <select
                        value={selected.kind}
                        onChange={(event) =>
                            setSelectedKind(
                                event.target
                                    .value as CommandExampleSnippet['kind'],
                            )
                        }
                    >
                        {snippets.map((snippet) => (
                            <option key={snippet.kind} value={snippet.kind}>
                                {snippet.kind} - {snippet.title}
                            </option>
                        ))}
                    </select>
                </label>
                <button
                    type="button"
                    onClick={() => onInsert(selected.commandText)}
                >
                    Insert
                </button>
                <button
                    type="button"
                    onClick={() => onCopy(selected.commandText)}
                >
                    Copy
                </button>
            </div>
            <pre className="mini-json">{selected.commandText}</pre>
            <SchemaAuthoringPanel validation={selectedValidation} compact />
        </section>
    );
}
