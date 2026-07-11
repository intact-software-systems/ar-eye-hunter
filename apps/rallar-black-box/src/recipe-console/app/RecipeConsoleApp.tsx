import type { AuthSession } from '@shared/api/api-config.ts';
import type { ReactNode } from 'react';
import { useRef, useState } from 'react';
import { createRecipeConsoleSeedState } from '../data/seeded-console-state.ts';
import type { RecipeConsoleSeedState } from '../data/recipe-console-models.ts';
import { ExecutePreview } from '../execute/ExecutePreview.tsx';
import type { RecipeConsoleView } from '../routing/url-state-contract.ts';
import { useRecipeConsoleUrlState } from '../routing/use-recipe-console-url-state.ts';
import '../design/tokens.css';
import '../design/reset.css';
import { RecipeConsoleShell } from '../shell/RecipeConsoleShell.tsx';
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
) {
    switch (view) {
        case 'execute':
            return <ExecutePreview model={seedState.execute} onInspectorChange={onInspectorChange} />;
        case 'monitor':
            return <StatePanel kind="error" title="Monitor"><p>Failure-first seeded evidence will appear in this continuous ledger.</p></StatePanel>;
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
    if (view === 'execute') return undefined;
    return (
        <section>
            <h2>{view[0].toUpperCase()}{view.slice(1)} preview</h2>
            <p>Contextual evidence remains seeded until this view's documented cutover.</p>
        </section>
    );
}

export default function RecipeConsoleApp({ authBusy, authError }: RecipeConsoleAppProps) {
    const urlState = useRecipeConsoleUrlState();
    const [seedState] = useState(createRecipeConsoleSeedState);
    const [inspectorOpen, setInspectorOpen] = useState(true);
    const [inspectorContent, setInspectorContent] = useState<ReactNode>();
    const restoreFocusRef = useRef<HTMLButtonElement>(null);
    const work = activeWork(urlState.state.view, seedState, setInspectorContent);

    function navigate(view: RecipeConsoleView): void {
        urlState.navigate({ view });
        setInspectorContent(undefined);
        setInspectorOpen(true);
    }

    function copyLink(): void {
        void navigator.clipboard?.writeText(urlState.copyHref);
    }

    return (
        <div className="recipe-console" data-view={urlState.state.view}>
            <RecipeConsoleShell
                commandBarContext={`${authBusy ? 'Connecting' : 'Seeded'} · ${seedState.execute.defaultTargetIds.length} targets`}
                currentView={urlState.state.view}
                inspectorContent={inspectorContent ?? provisionalInspector(urlState.state.view)}
                inspectorOpen={inspectorOpen}
                onCopyLink={copyLink}
                onInspectorClose={() => setInspectorOpen(false)}
                onNavigate={navigate}
                restoreFocusRef={restoreFocusRef}
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
