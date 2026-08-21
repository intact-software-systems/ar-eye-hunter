import { createExecuteWindowRevision } from './execute-window-revision.ts';
import styles from './ExecutePreflight.module.css';
import { ExecuteWindowedList } from './ExecuteWindowedList.tsx';

export function ExecutePreflightIssueList({
    contextKey,
    id,
    label,
    tone,
    values
}: Readonly<{
    contextKey: string;
    id: string;
    label: string;
    tone: 'error' | 'warning';
    values: readonly string[];
}>) {
    if (values.length === 0) {
        return null;
    }
    const itemLabel = tone === 'error' ? 'errors' : 'warnings';
    return (
        <div
            className={styles.issues}
            data-tone={tone}
        >
            <h3>{label}</h3>
            <small
                data-execute-preflight-live-summary
                role={tone === 'error' ? 'alert' : 'status'}
            >
                {values.length.toLocaleString('en-US')} {itemLabel} total
            </small>
            <ExecuteWindowedList
                contentId={`execute-preflight-${id}-window`}
                contextKey={JSON.stringify([contextKey, label])}
                itemKey={(_value, index) => String(index)}
                itemLabel={itemLabel}
                items={values}
                label={label}
                renderItem={(value) => <li data-execute-preflight-issue>{value}</li>}
                revisionKey={createExecuteWindowRevision(values, (value) => value)}
                section="preflightIssues"
            />
        </div>
    );
}
