import { useCallback, useRef, type ReactNode, type RefObject } from 'react';
import type {
    RecipeConsoleUrlIssue,
    RecipeConsoleView,
} from '../routing/url-state-contract.ts';
import type { OperationalStatus } from '../ui/StatusMark.tsx';
import { InspectorHost } from './InspectorHost.tsx';
import { PrimaryNavigation } from './PrimaryNavigation.tsx';
import { TopCommandBar } from './TopCommandBar.tsx';
import { useRecipeConsolePresentation } from './use-responsive-presentation.ts';
import styles from './RecipeConsoleShell.module.css';

export type RecipeConsoleShellProps = Readonly<{
    currentView: RecipeConsoleView;
    urlIssues: readonly RecipeConsoleUrlIssue[];
    commandBarContext: ReactNode;
    commandBarStatus: OperationalStatus;
    commandBarStatusLabel: string;
    onNavigate(view: RecipeConsoleView): void;
    onCopyLink(): void;
    onRefresh(): void;
    workContent: ReactNode;
    inspectorContent?: ReactNode;
    inspectorOpen: boolean;
    onInspectorClose(): void;
    inspectorRestoreFocus?: HTMLElement | null;
    inspectorRestoreFocusFallback?: HTMLElement | null;
    selectionDockContent?: ReactNode;
    onSelectionDockInspect?(trigger: HTMLButtonElement): void;
    restoreFocusRef: RefObject<HTMLButtonElement | null>;
}>;

export function RecipeConsoleShell({
    currentView,
    urlIssues,
    commandBarContext,
    commandBarStatus,
    commandBarStatusLabel,
    onNavigate,
    onCopyLink,
    onRefresh,
    workContent,
    inspectorContent,
    inspectorOpen,
    onInspectorClose,
    inspectorRestoreFocus,
    inspectorRestoreFocusFallback,
    selectionDockContent,
    onSelectionDockInspect,
    restoreFocusRef,
}: RecipeConsoleShellProps) {
    const presentation = useRecipeConsolePresentation();
    const workSurfaceRef = useRef<HTMLElement>(null);
    const showInspector = Boolean(inspectorContent) && inspectorOpen;
    const showSelectionDock = selectionDockContent !== undefined &&
        onSelectionDockInspect !== undefined;
    const restoreInspectorFallbacks = useCallback(() => [
        inspectorRestoreFocusFallback,
        restoreFocusRef.current,
        workSurfaceRef.current,
    ], [inspectorRestoreFocusFallback, restoreFocusRef]);
    return (
        <div
            className={`${styles.shell} ${showInspector ? '' : styles.withoutInspector} ${showSelectionDock ? '' : styles.withoutSelectionDock} ${urlIssues.length > 0 ? styles.withUrlIssues : ''} ${showInspector && currentView === 'monitor' ? styles.monitorInspector : ''}`}
            data-command-height={presentation.commandBarHeight}
            data-inspector-mode={presentation.inspector}
            data-navigation={presentation.navigation}
            data-recipe-console-shell
        >
            <TopCommandBar
                context={commandBarContext}
                height={presentation.commandBarHeight}
                issues={urlIssues}
                onCopyLink={onCopyLink}
                onRefresh={onRefresh}
                status={commandBarStatus}
                statusLabel={commandBarStatusLabel}
            />
            <PrimaryNavigation
                currentView={currentView}
                onNavigate={onNavigate}
                presentation={presentation.navigation}
            />
            <main
                aria-label="Recipe console work surface"
                className={styles.workSurface}
                data-work-surface
                ref={workSurfaceRef}
                tabIndex={-1}
            >
                {workContent}
            </main>
            {showInspector ? (
                <InspectorHost
                    mode={presentation.inspector}
                    onClose={onInspectorClose}
                    open
                    restoreFocusFallbacks={restoreInspectorFallbacks}
                    restoreFocusTo={inspectorRestoreFocus}
                >
                    {inspectorContent}
                </InspectorHost>
            ) : null}
            {showSelectionDock ? (
                <div className={styles.selectionDock} data-selection-dock>
                    <span>{selectionDockContent}</span>
                    <button
                        onClick={event => onSelectionDockInspect?.(event.currentTarget)}
                        ref={restoreFocusRef}
                        type="button"
                    >Inspect</button>
                </div>
            ) : null}
        </div>
    );
}
