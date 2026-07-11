import type { AuthSession } from '@shared/api/api-config.ts';
import { useRef, useState } from 'react';
import { createRecipeConsoleSeedState } from '../data/seeded-console-state.ts';
import type { RecipeConsoleView } from '../routing/url-state-contract.ts';
import { useRecipeConsoleUrlState } from '../routing/use-recipe-console-url-state.ts';
import '../design/tokens.css';
import '../design/reset.css';
import { RecipeConsoleShell } from '../shell/RecipeConsoleShell.tsx';
import { MetricStrip } from '../ui/MetricStrip.tsx';
import { StatePanel } from '../ui/StatePanel.tsx';

export type RecipeConsoleAppProps = Readonly<{
    authSession?: AuthSession;
    authBusy: boolean;
    authError?: string;
    onLogout(): Promise<void>;
}>;

function provisionalWork(view: RecipeConsoleView) {
    switch (view) {
        case 'execute':
            return <StatePanel kind="empty" title="Execute"><p>Repository-backed recipe preview is ready for the Execute workspace.</p></StatePanel>;
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

export default function RecipeConsoleApp({ authBusy, authError }: RecipeConsoleAppProps) {
    const urlState = useRecipeConsoleUrlState();
    const [seedState] = useState(createRecipeConsoleSeedState);
    const [inspectorOpen, setInspectorOpen] = useState(true);
    const restoreFocusRef = useRef<HTMLButtonElement>(null);
    const work = provisionalWork(urlState.state.view);

    function navigate(view: RecipeConsoleView): void {
        urlState.navigate({ view });
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
                inspectorContent={(
                    <section>
                        <h2>{urlState.state.view} preview</h2>
                        <MetricStrip items={[
                            { label: 'Targets', value: seedState.execute.defaultTargetIds.length },
                            { label: 'Failures', value: seedState.monitor.failureLedger.length },
                            { label: 'P95', value: `${seedState.tune.percentiles.p95Ms} ms` },
                        ]} />
                        <p>{authError ?? 'Deterministic repository evidence; no service required.'}</p>
                    </section>
                )}
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
