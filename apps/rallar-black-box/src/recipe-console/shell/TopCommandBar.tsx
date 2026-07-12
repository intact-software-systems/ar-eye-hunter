import type { ReactNode } from 'react';
import type { RecipeConsoleUrlIssue } from '../routing/url-state-contract.ts';
import { CommandBarItem } from '../ui/CommandBarItem.tsx';
import { IconButton } from '../ui/IconButton.tsx';
import { StatusMark, type OperationalStatus } from '../ui/StatusMark.tsx';
import styles from './TopCommandBar.module.css';

export function TopCommandBar({
    height,
    context,
    issues,
    onCopyLink,
    onRefresh,
    status,
    statusLabel,
}: Readonly<{
    height: 48 | 52;
    context: ReactNode;
    issues: readonly RecipeConsoleUrlIssue[];
    onCopyLink(): void;
    onRefresh(): void;
    status: OperationalStatus;
    statusLabel: string;
}>) {
    return (
        <>
            <header
                className={`${styles.commandBar} ${height === 48 ? styles.commandBar48 : styles.commandBar52}`}
                data-command-bar
            >
                <strong className={styles.productName}>Recipe Console</strong>
                <StatusMark label={statusLabel} status={status} />
                <div className={styles.commandContext}>
                    {context}
                    <CommandBarItem label="URL">
                        {issues.length > 0 ? `${issues.length} normalized` : 'Canonical'}
                    </CommandBarItem>
                </div>
                <IconButton aria-label="Refresh control data" icon="refresh" onClick={onRefresh} />
                <IconButton aria-label="Copy canonical link" icon="copy" onClick={onCopyLink} />
            </header>
            {issues.length > 0 ? (
                <div
                    className={styles.urlIssueStrip}
                    data-url-issues
                    role="status"
                >
                    {issues.map((issue, index) => (
                        <span key={`${issue.field}:${issue.code}:${index}`}>
                            {index > 0 ? ' ' : null}{issue.message}
                        </span>
                    ))}
                </div>
            ) : null}
        </>
    );
}
