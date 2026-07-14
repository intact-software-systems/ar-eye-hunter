import { CrdtHealthPanel } from '../../diagnostics/crdt/CrdtHealthPanel.tsx';
import { MediaConsolePanel } from '../../diagnostics/media/MediaConsolePanel.tsx';
import { RallarDataPanel } from '../../diagnostics/rallar-data/RallarDataPanel.tsx';
import type {
    LegacyShellAuth,
    LegacyShellGlobalContext,
    LegacyShellNavigation,
    LegacyShellRuntime,
} from '../legacy-shell-contracts.ts';

export function DirectResourceTabPanels({
    runtime,
    auth,
    navigation,
    globalContext,
}: Readonly<{
    runtime: LegacyShellRuntime;
    auth: LegacyShellAuth;
    navigation: LegacyShellNavigation;
    globalContext: LegacyShellGlobalContext;
}>) {
    const { state, bootstrap } = runtime;
    const { authSession } = auth;
    const { activeTab } = navigation;
    const { globalValues } = globalContext;

    return (
        <>
            <section
                id="panel-rallar-data"
                className="workspace-grid tab-workspace rallar-data-tab-grid"
                role="tabpanel"
                aria-labelledby="tab-rallar-data"
                hidden={activeTab !== 'rallar-data'}
            >
                <RallarDataPanel
                    state={state}
                    bootstrap={bootstrap}
                    authSession={authSession}
                    globalValues={globalValues}
                />
            </section>
            <section
                id="panel-crdt-health"
                className="workspace-grid tab-workspace crdt-health-tab-grid"
                role="tabpanel"
                aria-labelledby="tab-crdt-health"
                hidden={activeTab !== 'crdt-health'}
            >
                <CrdtHealthPanel
                    state={state}
                    bootstrap={bootstrap}
                    authSession={authSession}
                    globalValues={globalValues}
                />
            </section>
            <section
                id="panel-media"
                className="workspace-grid tab-workspace media-tab-grid"
                role="tabpanel"
                aria-labelledby="tab-media"
                hidden={activeTab !== 'media'}
            >
                <MediaConsolePanel
                    state={state}
                    bootstrap={bootstrap}
                    authSession={authSession}
                    globalValues={globalValues}
                />
            </section>
        </>
    );
}
