import type { AuthSession } from '@shared/api/api-config.ts';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { createRecipeConsoleSeedState } from '../data/seeded-console-state.ts';
import type { RecipeConsoleSeedState } from '../data/recipe-console-models.ts';
import { ExecutePreview } from '../execute/ExecutePreview.tsx';
import { FailureInspector } from '../monitor/FailureInspector.tsx';
import { MonitorPreview } from '../monitor/MonitorPreview.tsx';
import type { RecipeConsoleView } from '../routing/url-state-contract.ts';
import { useRecipeConsoleUrlState } from '../routing/use-recipe-console-url-state.ts';
import '../design/tokens.css';
import '../design/reset.css';
import { RecipeConsoleShell } from '../shell/RecipeConsoleShell.tsx';
import { useRecipeConsolePresentation } from '../shell/use-responsive-presentation.ts';
import { StatePanel } from '../ui/StatePanel.tsx';

export type RecipeConsoleAppProps = Readonly<{
    authSession?: AuthSession;
    authBusy: boolean;
    authError?: string;
    onLogout(): Promise<void>;
}>;

function activeWork(
    view: RecipeConsoleView,
    seedState: RecipeConsoleSeedState,
    onInspectorChange: (content: ReactNode | undefined) => void,
    monitorWork: ReactNode,
) {
    switch (view) {
        case 'execute':
            return <ExecutePreview model={seedState.execute} onInspectorChange={onInspectorChange} />;
        case 'monitor':
            return monitorWork;
        case 'analyze':
            return <StatePanel kind="empty" title="Analyze"><p>Artifact analysis remains available without a live service.</p></StatePanel>;
        case 'tune':
            return (
                <div data-landscape-split>
                    <div data-landscape-matrix>
                        <StatePanel kind="stale" title="Agent × phase"><p>Three seeded agent timing lanes.</p></StatePanel>
                    </div>
                    <div aria-hidden="true" data-landscape-divider />
                    <div data-landscape-timing>
                        <StatePanel kind="empty" title="Timing"><p>Command-duration only; RTC timeline unavailable.</p></StatePanel>
                    </div>
                </div>
            );
        case 'fleet':
            return <StatePanel kind="empty" title="Fleet"><p>Fleet migration remains behind its documented cutover proof.</p></StatePanel>;
        case 'advanced':
            return <StatePanel kind="empty" title="Advanced"><p>Legacy diagnostics remain available through the explicit legacy experience.</p></StatePanel>;
    }
}

function provisionalInspector(view: RecipeConsoleView): ReactNode | undefined {
    if (view === 'execute' || view === 'monitor') return undefined;
    return (
        <section>
            <h2>{view[0].toUpperCase()}{view.slice(1)} preview</h2>
            <p>Contextual evidence remains seeded until this view's documented cutover.</p>
        </section>
    );
}

export default function RecipeConsoleApp({ authBusy, authError }: RecipeConsoleAppProps) {
    const urlState = useRecipeConsoleUrlState();
    const presentation = useRecipeConsolePresentation();
    const [seedState] = useState(createRecipeConsoleSeedState);
    const [inspectorOpen, setInspectorOpen] = useState(
        () => urlState.state.view !== 'monitor' || presentation.inspector === 'rail',
    );
    const [inspectorContent, setInspectorContent] = useState<ReactNode>();
    const [selectedFailureKey, setSelectedFailureKey] = useState(
        seedState.monitor.selectedCommandFailure.key,
    );
    const [stale, setStale] = useState(false);
    const [inspectorTrigger, setInspectorTrigger] = useState<HTMLButtonElement | null>(null);
    const restoreFocusRef = useRef<HTMLButtonElement>(null);
    const selectedFailure = seedState.monitor.failureLedger.find(
        failure => failure.key === selectedFailureKey,
    ) ?? seedState.monitor.selectedCommandFailure;

    function selectFailure(key: string, trigger: HTMLButtonElement): void {
        setSelectedFailureKey(key);
        setInspectorTrigger(trigger);
        setInspectorOpen(true);
    }

    const monitorWork = (
        <MonitorPreview
            model={seedState.monitor}
            onCloseInspector={() => setInspectorOpen(false)}
            onSelectFailure={selectFailure}
            onToggleStale={() => setStale(value => !value)}
            selectedFailureKey={selectedFailureKey}
            stale={stale}
        />
    );
    const work = activeWork(
        urlState.state.view,
        seedState,
        setInspectorContent,
        monitorWork,
    );

    useEffect(() => {
        if (urlState.state.view === 'monitor') {
            setInspectorOpen(presentation.inspector === 'rail');
        }
    }, [presentation.inspector, urlState.state.view]);

    function navigate(view: RecipeConsoleView): void {
        urlState.navigate({ view });
        setInspectorContent(undefined);
        setInspectorTrigger(null);
        setInspectorOpen(view !== 'monitor' || presentation.inspector === 'rail');
    }

    function copyLink(): void {
        void navigator.clipboard?.writeText(urlState.copyHref);
    }

    const monitorActive = urlState.state.view === 'monitor';
    const resolvedInspectorContent = monitorActive
        ? <FailureInspector failureKey={selectedFailureKey} model={seedState.monitor} />
        : inspectorContent ?? provisionalInspector(urlState.state.view);

    return (
        <div className="recipe-console" data-view={urlState.state.view}>
            <RecipeConsoleShell
                commandBarContext={`${authBusy ? 'Connecting' : 'Seeded'} · ${seedState.execute.defaultTargetIds.length} targets`}
                currentView={urlState.state.view}
                inspectorContent={resolvedInspectorContent}
                inspectorOpen={inspectorOpen}
                inspectorRestoreFocus={inspectorTrigger}
                onCopyLink={copyLink}
                onInspectorClose={() => setInspectorOpen(false)}
                onNavigate={navigate}
                onSelectionDockInspect={monitorActive
                    ? trigger => selectFailure(selectedFailureKey, trigger)
                    : undefined}
                restoreFocusRef={restoreFocusRef}
                selectionDockContent={monitorActive
                    ? `Failure · ${selectedFailure.agentId ?? selectedFailure.recipeId ?? selectedFailure.key}`
                    : undefined}
                urlIssues={urlState.issues}
                workContent={(
                    <section aria-labelledby="recipe-console-view-heading">
                        <h1 id="recipe-console-view-heading">{urlState.state.view[0].toUpperCase()}{urlState.state.view.slice(1)}</h1>
                        {work}
                    </section>
                )}
            />
        </div>
    );
}
