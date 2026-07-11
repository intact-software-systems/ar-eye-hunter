import type { ReactNode, RefObject } from 'react';
import type {
    RecipeConsoleUrlIssue,
    RecipeConsoleView,
} from '../routing/url-state-contract.ts';
import { InspectorHost } from './InspectorHost.tsx';
import { PrimaryNavigation } from './PrimaryNavigation.tsx';
import { TopCommandBar } from './TopCommandBar.tsx';
import { useRecipeConsolePresentation } from './use-responsive-presentation.ts';
import styles from './RecipeConsoleShell.module.css';

export type RecipeConsoleShellProps = Readonly<{
    currentView: RecipeConsoleView;
    urlIssues: readonly RecipeConsoleUrlIssue[];
    commandBarContext: ReactNode;
    onNavigate(view: RecipeConsoleView): void;
    onCopyLink(): void;
    workContent: ReactNode;
    inspectorContent?: ReactNode;
    inspectorOpen: boolean;
    onInspectorClose(): void;
    restoreFocusRef: RefObject<HTMLButtonElement | null>;
}>;

export function RecipeConsoleShell({
    currentView,
    urlIssues,
    commandBarContext,
    onNavigate,
    onCopyLink,
    workContent,
    inspectorContent,
    inspectorOpen,
    onInspectorClose,
    restoreFocusRef,
}: RecipeConsoleShellProps) {
    const presentation = useRecipeConsolePresentation();
    const showInspector = Boolean(inspectorContent) && inspectorOpen;
    return (
        <div
            className={`${styles.shell} ${showInspector ? '' : styles.withoutInspector}`}
            data-command-height={presentation.commandBarHeight}
            data-inspector-mode={presentation.inspector}
            data-navigation={presentation.navigation}
            data-recipe-console-shell
        >
            <TopCommandBar
                context={commandBarContext}
                height={presentation.commandBarHeight}
                issueCount={urlIssues.length}
                onCopyLink={onCopyLink}
            />
            <PrimaryNavigation
                currentView={currentView}
                onNavigate={onNavigate}
                presentation={presentation.navigation}
            />
            <main className={styles.workSurface} data-work-surface tabIndex={-1}>
                {workContent}
            </main>
            {showInspector ? (
                <InspectorHost
                    mode={presentation.inspector}
                    onClose={onInspectorClose}
                    open
                >
                    {inspectorContent}
                </InspectorHost>
            ) : null}
            <div className={styles.selectionDock} data-selection-dock>
                <span>Preview inspector selected</span>
                <button onClick={() => undefined} ref={restoreFocusRef} type="button">Inspect</button>
            </div>
        </div>
    );
}
