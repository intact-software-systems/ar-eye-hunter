import {
    schemaAuthoringSummary,
    schemaAuthoringTone,
    type SchemaAuthoringValidation,
} from '../../../schema-authoring.ts';

export function SchemaAuthoringPanel({
    validation,
    compact = false,
}: {
    validation: SchemaAuthoringValidation;
    compact?: boolean;
}) {
    return (
        <section
            className={`schema-authoring-panel ${compact ? 'compact' : ''} ${schemaAuthoringTone(validation)}`}
        >
            <div className="schema-authoring-heading">
                <strong>{validation.title}</strong>
                <span className={`pill ${schemaAuthoringTone(validation)}`}>
                    {schemaAuthoringSummary(validation)}
                </span>
            </div>
            {!validation.ok && (
                <div className="schema-error-list">
                    {validation.errors.slice(0, 8).map((issue, index) => (
                        <div
                            className="schema-error-row"
                            key={`${issue.path}-${index}`}
                        >
                            <strong>{issue.path}</strong>
                            <span>{issue.message}</span>
                        </div>
                    ))}
                </div>
            )}
            {validation.ok && validation.capabilities.length > 0 && (
                <SchemaCapabilitySummary validation={validation} />
            )}
            {validation.ok &&
                validation.capabilities.length === 0 &&
                validation.target === 'runner-scenario' && (
                    <div className="schema-capability-empty">
                        Provider-neutral runner scenario schema valid.
                    </div>
                )}
        </section>
    );
}

export function SchemaCapabilitySummary({
    validation,
}: {
    validation: SchemaAuthoringValidation;
}) {
    if (validation.capabilities.length === 0) {
        return (
            <div className="schema-capability-empty">
                No browser-agent command capabilities detected.
            </div>
        );
    }

    return (
        <div className="schema-capability-summary">
            <div className="schema-chip-row">
                {validation.commandKinds.map((kind) => (
                    <span className="pill muted" key={kind}>
                        {kind}
                    </span>
                ))}
                <span
                    className={`pill ${validation.distributedCompatible ? 'good' : 'warn'}`}
                >
                    {validation.distributedCompatible
                        ? 'distributed-ready'
                        : 'local-only command'}
                </span>
            </div>
            <div className="schema-capability-grid">
                <SchemaCapabilityList
                    title="Provider modes"
                    values={validation.providerModes}
                />
                <SchemaCapabilityList
                    title="Runtime surfaces"
                    values={validation.runtimeSurfaces}
                />
                <SchemaCapabilityList
                    title="Live requirements"
                    values={validation.liveServiceRequirements}
                />
                <SchemaCapabilityList
                    title="Artifacts"
                    values={validation.artifactExpectations}
                />
            </div>
            <div className="schema-command-capabilities">
                {validation.capabilities.map((capability) => (
                    <article
                        className="schema-command-capability"
                        key={capability.kind}
                    >
                        <strong>{capability.title}</strong>
                        <small>{capability.kind}</small>
                        <p>{capability.description}</p>
                    </article>
                ))}
            </div>
        </div>
    );
}

function SchemaCapabilityList({
    title,
    values,
}: {
    title: string;
    values: readonly string[];
}) {
    return (
        <div className="schema-capability-list">
            <strong>{title}</strong>
            <span>{values.length > 0 ? values.join(', ') : 'none'}</span>
        </div>
    );
}
