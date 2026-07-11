import type { ReactNode } from 'react';
import { CommandBarItem } from '../ui/CommandBarItem.tsx';
import { IconButton } from '../ui/IconButton.tsx';
import { StatusMark } from '../ui/StatusMark.tsx';
import styles from './RecipeConsoleShell.module.css';

export function TopCommandBar({
    height,
    context,
    issueCount,
    onCopyLink,
}: Readonly<{
    height: 48 | 52;
    context: ReactNode;
    issueCount: number;
    onCopyLink(): void;
}>) {
    return (
        <header
            className={`${styles.commandBar} ${height === 48 ? styles.commandBar48 : styles.commandBar52}`}
            data-command-bar
        >
            <strong className={styles.productName}>Recipe Console</strong>
            <StatusMark label="Preview" status="partial" />
            <div className={styles.commandContext}>
                <CommandBarItem label="Context">{context}</CommandBarItem>
                <CommandBarItem label="URL">{issueCount ? `${issueCount} normalized` : 'Canonical'}</CommandBarItem>
            </div>
            <IconButton aria-label="Refresh preview" icon="refresh" />
            <IconButton aria-label="Copy canonical link" icon="copy" onClick={onCopyLink} />
        </header>
    );
}
