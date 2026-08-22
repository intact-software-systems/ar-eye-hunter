import type { AuthSession } from '@shared/api/api-config.ts';
import { useState } from 'react';
import type { CommandCenterGlobalValues } from './global-context-model.ts';

export function GlobalContextBar({
    values,
    authSession,
    onChange,
    onReset
}: {
    values: CommandCenterGlobalValues;
    authSession?: AuthSession;
    onChange<K extends keyof CommandCenterGlobalValues>(
        key: K,
        value: CommandCenterGlobalValues[K]
    ): void;
    onReset(): void;
}) {
    const [mobileExpanded, setMobileExpanded] = useState(false);

    return (
        <section
            className={`global-context-bar ${mobileExpanded ? 'expanded' : 'collapsed'}`}
            aria-label="Global command context"
        >
            <div className="global-context-heading">
                <h2>Global Context</h2>
                <span className={`pill ${authSession ? 'good' : 'muted'}`}>
                    {authSession ? 'login synced' : 'editable defaults'}
                </span>
                <button
                    type="button"
                    className="global-context-toggle"
                    aria-expanded={mobileExpanded}
                    aria-controls="global-context-fields"
                    onClick={() => setMobileExpanded((current) => !current)}
                >
                    {mobileExpanded ? 'Hide values' : 'Show values'}
                </button>
                <button
                    type="button"
                    className="global-context-reset"
                    onClick={onReset}
                >
                    Use login/context
                </button>
            </div>
            <div className="global-context-grid" id="global-context-fields">
                <label className="field">
                    <span>API Base URL</span>
                    <input
                        aria-label="Global Server URL"
                        value={values.apiBaseUrl}
                        onChange={(event) => onChange('apiBaseUrl', event.target.value)}
                    />
                </label>
                <label className="field">
                    <span>Application</span>
                    <input
                        aria-label="Global Application"
                        value={values.applicationId}
                        onChange={(event) => onChange('applicationId', event.target.value)}
                    />
                </label>
                <label className="field">
                    <span>Workspace</span>
                    <input
                        aria-label="Global Workspace"
                        value={values.workspaceId}
                        onChange={(event) => onChange('workspaceId', event.target.value)}
                    />
                </label>
                <label className="field">
                    <span>Room / Group</span>
                    <input
                        aria-label="Global Room"
                        value={values.roomId}
                        onChange={(event) => onChange('roomId', event.target.value)}
                    />
                </label>
                <label className="field">
                    <span>Client</span>
                    <input
                        aria-label="Global Client"
                        value={values.clientId}
                        onChange={(event) => onChange('clientId', event.target.value)}
                    />
                </label>
                <label className="field">
                    <span>Session</span>
                    <input
                        aria-label="Global Session"
                        value={values.sessionId}
                        onChange={(event) => onChange('sessionId', event.target.value)}
                    />
                </label>
            </div>
        </section>
    );
}
