import {
    DISTRIBUTED_RECIPE_PROMPT_TEMPLATES,
    type DistributedRecipePromptTemplateId,
    type DistributedRecipePromptVariables
} from '../../../../distributed-recipe-authoring-prompts.ts';
import type { SchemaAuthoringValidation } from '../../../../schema-authoring.ts';
import { recordValue } from '../../../shared/record-value.ts';
import { SchemaAuthoringPanel } from '../../../shared/schema/SchemaAuthoringPanel.tsx';
import { DistributedRecipePreflightPanel } from '../DistributedRecipePreflightPanel.tsx';
import type {
    DistributedAuthoringDraftPreflightEntry,
    DistributedAuthoringDraftTarget
} from './distributed-recipe-authoring.ts';

export function DistributedRecipeAuthoringPanel({
    selectedTemplateId,
    promptText,
    schemaContextText,
    promptVariables,
    draftTarget,
    draftText,
    draftValidation,
    draftPreflights,
    validationFeedbackText,
    canUseManifestPreview,
    onTemplateChange,
    onDraftTargetChange,
    onDraftTextChange,
    onCopyPrompt,
    onCopySchemaContext,
    onCopyValidationFeedback,
    onUseManifestPreview
}: {
    selectedTemplateId: DistributedRecipePromptTemplateId;
    promptText: string;
    schemaContextText: string;
    promptVariables: DistributedRecipePromptVariables;
    draftTarget: DistributedAuthoringDraftTarget;
    draftText: string;
    draftValidation?: SchemaAuthoringValidation;
    draftPreflights: readonly DistributedAuthoringDraftPreflightEntry[];
    validationFeedbackText: string;
    canUseManifestPreview: boolean;
    onTemplateChange(id: DistributedRecipePromptTemplateId): void;
    onDraftTargetChange(target: DistributedAuthoringDraftTarget): void;
    onDraftTextChange(text: string): void;
    onCopyPrompt(): void;
    onCopySchemaContext(): void;
    onCopyValidationFeedback(): void;
    onUseManifestPreview(): void;
}) {
    const selectedTemplate = DISTRIBUTED_RECIPE_PROMPT_TEMPLATES.find(
        (template) => template.id === selectedTemplateId
    ) ?? DISTRIBUTED_RECIPE_PROMPT_TEMPLATES[0];
    const visibleVariables = Object.entries(promptVariables).filter(
        ([, value]) => promptVariableVisible(value)
    );
    const preflightErrors = draftPreflights.reduce(
        (sum, entry) => sum + entry.preflight.errors.length,
        0
    );
    const preflightWarnings = draftPreflights.reduce(
        (sum, entry) => sum + entry.preflight.warnings.length,
        0
    );

    return (
        <section
            className="distributed-subpanel distributed-ai-authoring-panel"
            aria-label="Generate With AI"
        >
            <div className="section-heading">
                <h3>Generate With AI</h3>
                <span>
                    {DISTRIBUTED_RECIPE_PROMPT_TEMPLATES.length} templates
                </span>
            </div>
            <div className="distributed-ai-authoring-grid">
                <div className="distributed-ai-controls">
                    <label className="field">
                        <span>Prompt Template</span>
                        <select
                            aria-label="Prompt Template"
                            value={selectedTemplateId}
                            onChange={(event) =>
                                onTemplateChange(
                                    event.target
                                        .value as DistributedRecipePromptTemplateId
                                )}
                        >
                            {DISTRIBUTED_RECIPE_PROMPT_TEMPLATES.map(
                                (template) => (
                                    <option
                                        key={template.id}
                                        value={template.id}
                                    >
                                        {template.title}
                                    </option>
                                )
                            )}
                        </select>
                        <small>{selectedTemplate.description}</small>
                    </label>
                    <label className="field">
                        <span>Validate As</span>
                        <select
                            aria-label="Validate Generated JSON As"
                            value={draftTarget}
                            onChange={(event) =>
                                onDraftTargetChange(
                                    event.target
                                        .value as DistributedAuthoringDraftTarget
                                )}
                        >
                            <option value="distributed-run-manifest">
                                Distributed manifest
                            </option>
                            <option value="recipe">Browser-agent recipe</option>
                        </select>
                    </label>
                    <button type="button" onClick={onCopyPrompt}>
                        Copy Prompt
                    </button>
                    <button type="button" onClick={onCopySchemaContext}>
                        Copy Schema Context
                    </button>
                    <button
                        type="button"
                        disabled={!draftValidation}
                        onClick={onCopyValidationFeedback}
                    >
                        Copy Validation Feedback
                    </button>
                    <button
                        type="button"
                        disabled={!canUseManifestPreview}
                        onClick={onUseManifestPreview}
                    >
                        Use Manifest Preview
                    </button>
                </div>
                <div className="distributed-ai-guidance">
                    <strong>Required Inputs</strong>
                    <span>
                        Goal, target shape, group scope, agent roles, expected evidence, and live-service assumptions.
                    </span>
                    <strong>No Provider Dependency</strong>
                    <span>
                        Copy the prompt into any AI assistant, then paste JSON here for schema and preflight checks.
                    </span>
                </div>
                <div
                    className="distributed-ai-variable-grid"
                    aria-label="Prompt variables"
                >
                    {visibleVariables.map(([key, value]) => (
                        <div key={key}>
                            <strong>{key}</strong>
                            <span>{formatPromptVariableValue(value)}</span>
                        </div>
                    ))}
                </div>
                <details className="distributed-ai-preview" open>
                    <summary>Prompt Preview</summary>
                    <pre aria-label="Prompt template preview">{promptText}</pre>
                </details>
                <details className="distributed-ai-preview">
                    <summary>Schema Context</summary>
                    <pre aria-label="Schema context preview">
                        {schemaContextText}
                    </pre>
                </details>
                <label className="field distributed-ai-draft">
                    <span>Generated JSON</span>
                    <textarea
                        aria-label="Generated JSON"
                        value={draftText}
                        onChange={(event) => onDraftTextChange(event.target.value)}
                        placeholder="Paste a generated distributed manifest or browser-agent recipe JSON object."
                        spellCheck={false}
                    />
                </label>
                <section
                    className="distributed-ai-validation"
                    aria-label="Generated JSON validation"
                >
                    <div className="schema-authoring-heading">
                        <strong>Validation Feedback</strong>
                        <span
                            className={`pill ${
                                draftValidation
                                    ? (draftValidation.ok && preflightErrors === 0 ? 'good' : 'bad')
                                    : 'muted'
                            }`}
                        >
                            {draftValidation
                                ? draftValidation.ok && preflightErrors === 0
                                    ? preflightWarnings > 0
                                        ? 'valid with warnings'
                                        : 'valid'
                                    : 'needs changes'
                                : 'waiting'}
                        </span>
                    </div>
                    <pre aria-label="Validation feedback copy text">
                        {validationFeedbackText}
                    </pre>
                    {draftValidation
                        ? (
                            <SchemaAuthoringPanel
                                validation={draftValidation}
                                compact
                            />
                        )
                        : (
                            <div className="schema-capability-empty">
                                Paste generated JSON to validate it before running.
                            </div>
                        )}
                    {draftPreflights.length > 0 && (
                        <div className="distributed-ai-preflight-list">
                            {draftPreflights.map((entry) => (
                                <details
                                    key={entry.id}
                                    open={entry.preflight.errors.length > 0}
                                >
                                    <summary>{entry.title} preflight</summary>
                                    <DistributedRecipePreflightPanel
                                        preflight={entry.preflight}
                                        compact
                                    />
                                </details>
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </section>
    );
}

function promptVariableVisible(value: unknown): boolean {
    if (value === undefined || value === null || value === '') {
        return false;
    }
    if (Array.isArray(value)) {
        return value.length > 0;
    }
    if (typeof value === 'object') {
        return Object.keys(recordValue(value)).length > 0;
    }
    return true;
}

function formatPromptVariableValue(value: unknown): string {
    if (Array.isArray(value)) {
        return value
            .map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry))
            .join(', ');
    }
    if (value && typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}
