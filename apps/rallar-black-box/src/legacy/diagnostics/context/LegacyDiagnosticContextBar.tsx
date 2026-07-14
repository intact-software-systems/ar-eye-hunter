import {
    createContext,
    type ReactNode,
    useContext,
} from 'react';
import {
    buildLegacyDiagnosticReturnHref,
    type LegacyDiagnosticContext,
    type ParsedLegacyDiagnosticContext,
} from './legacy-diagnostic-context.ts';
import styles from './LegacyDiagnosticContextBar.module.css';

type ContextField = Readonly<{
    key: Exclude<keyof LegacyDiagnosticContext, 'version'>;
    label: string;
}>;

const CONTEXT_FIELDS: readonly ContextField[] = [
    { key: 'provider', label: 'Provider' },
    { key: 'contextApplicationId', label: 'Application' },
    { key: 'contextWorkspaceId', label: 'Workspace' },
    { key: 'contextGroupId', label: 'Group' },
    { key: 'controlRunId', label: 'Control run' },
    { key: 'distributedRunId', label: 'Distributed run' },
    { key: 'agentId', label: 'Agent' },
    { key: 'recipeId', label: 'Recipe' },
    { key: 'commandId', label: 'Command' },
    { key: 'transport', label: 'Transport' },
    { key: 'view', label: 'Source view' },
] as const;

export type LegacyDiagnosticContextBarProps = Readonly<{
    parsed: ParsedLegacyDiagnosticContext;
}>;

const ABSENT_CONTEXT: ParsedLegacyDiagnosticContext = {
    status: 'absent',
    issues: [],
    omittedIssueCount: 0,
};

const LegacyDiagnosticContext = createContext<ParsedLegacyDiagnosticContext>(
    ABSENT_CONTEXT,
);

export function LegacyDiagnosticContextProvider({
    parsed,
    children,
}: LegacyDiagnosticContextBarProps & Readonly<{ children: ReactNode }>) {
    return (
        <LegacyDiagnosticContext.Provider value={parsed}>
            {children}
        </LegacyDiagnosticContext.Provider>
    );
}

export function useLegacyDiagnosticContext(): ParsedLegacyDiagnosticContext {
    return useContext(LegacyDiagnosticContext);
}

export function LegacyDiagnosticContextBar({
    parsed,
}: LegacyDiagnosticContextBarProps) {
    const context = parsed.context;
    const returnHref = buildLegacyDiagnosticReturnHref(context);
    const entries = context
        ? CONTEXT_FIELDS.flatMap(field => {
            const value = context[field.key];
            return typeof value === 'string' ? [{ ...field, value }] : [];
        })
        : [];

    return (
        <section
            className={styles.root}
            aria-label="Recipe Console diagnostic bridge"
            data-legacy-diagnostic-context
            data-context-status={parsed.status}
        >
            <div className={styles.heading}>
                <h2>{contextTitle(parsed.status)}</h2>
                <span className={styles.status}>{contextStatus(parsed.status)}</span>
            </div>
            <p className={styles.summary}>{contextSummary(parsed.status)}</p>

            {entries.length > 0
                ? <dl className={styles.values}>
                    {entries.map(entry => (
                        <div
                            className={styles.valueRow}
                            data-context-field={entry.key}
                            key={entry.key}
                        >
                            <dt>{entry.label}</dt>
                            <dd>
                                <ExactContextValue>{entry.value}</ExactContextValue>
                                {entry.key === 'agentId'
                                    ? <small className={styles.agentNote}>
                                        Context only; not a client identity.
                                    </small>
                                    : null}
                            </dd>
                        </div>
                    ))}
                </dl>
                : parsed.status === 'ready'
                    ? <p className={styles.notice}>
                        No safe diagnostic selections were supplied.
                    </p>
                    : null}

            <div className={styles.actions}>
                {returnHref && context?.view
                    ? <a
                        className={styles.returnLink}
                        data-legacy-diagnostic-return
                        href={returnHref}
                    >
                        Return to {viewLabel(context.view)}
                    </a>
                    : parsed.status === 'ready'
                        ? <span className={styles.notice}>
                            Return link unavailable because the source view is missing.
                        </span>
                        : null}
                {parsed.issues.length > 0 || parsed.omittedIssueCount > 0
                    ? <span className={styles.notice} role="status">
                        {parsed.issues.length + parsed.omittedIssueCount}{' '}
                        unsafe or unsupported context field(s) ignored.
                    </span>
                    : null}
            </div>
        </section>
    );
}

function ExactContextValue({ children }: { children: ReactNode }) {
    return (
        <bdi
            className={styles.identifier}
            data-legacy-diagnostic-context-value
            dir="ltr"
        >
            <code>{children}</code>
        </bdi>
    );
}

function contextTitle(
    status: ParsedLegacyDiagnosticContext['status'],
): string {
    if (status === 'absent') {
        return 'No Recipe Console diagnostic context';
    }
    if (status === 'ready') {
        return 'Recipe Console diagnostic context';
    }
    return 'Unsupported diagnostic context';
}

function contextStatus(
    status: ParsedLegacyDiagnosticContext['status'],
): string {
    switch (status) {
        case 'ready':
            return 'context accepted';
        case 'absent':
            return 'legacy defaults';
        case 'unsupported':
            return 'version unsupported';
        case 'invalid':
            return 'context rejected';
    }
}

function contextSummary(
    status: ParsedLegacyDiagnosticContext['status'],
): string {
    switch (status) {
        case 'ready':
            return 'Safe bridge values apply only to this legacy diagnostic visit.';
        case 'absent':
            return 'This legacy tool is using its existing context and defaults.';
        case 'unsupported':
            return 'The supplied bridge version is not supported; no values were applied.';
        case 'invalid':
            return 'The supplied bridge marker is invalid; no values were applied.';
    }
}

function viewLabel(view: NonNullable<LegacyDiagnosticContext['view']>): string {
    return `${view.slice(0, 1).toLocaleUpperCase('en-US')}${view.slice(1)}`;
}
