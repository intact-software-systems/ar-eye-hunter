import { useState } from 'react';

import { ArenaOperations } from './arena-ui/arena-operations.tsx';
import { ArenaHud, ArenaPeers, ArenaScene, useArenaPresentation } from './arena-ui/arena-presentation.tsx';
import { DiagnosticsDrawer } from './arena-ui/diagnostics-drawer.tsx';
import { MatchWinnerOverlay } from './arena-ui/match-winner-overlay.tsx';
import { PresenceToastStack } from './arena-ui/squad-link-chip.tsx';
import { toArenaDiagnosticsAttributes } from './arena-ui/to-arena-labels.ts';
import { useRallarArena } from './game/arena-runtime/use-rallar-arena.ts';

export default function App() {
    const arena = useRallarArena();
    const presentation = useArenaPresentation(arena, Date.now);
    const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
    const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
    const diagnosticsAttributes = toArenaDiagnosticsAttributes(arena, diagnosticsOpen);
    const winnerMatch = presentation.winnerMatch;
    return (
        <main
            className={mobileDrawerOpen ? 'app-root app-root--mobile-drawer-open' : 'app-root'}
            data-mobile-drawer={mobileDrawerOpen ? 'open' : 'closed'}
            {...diagnosticsAttributes}
        >
            <ArenaScene arena={arena} presentation={presentation} diagnosticsAttributes={diagnosticsAttributes} />
            <ArenaHud
                arena={arena}
                presentation={presentation}
                diagnosticsOpen={diagnosticsOpen}
                onToggleDiagnostics={() => setDiagnosticsOpen((open) => !open)}
                onOpenDiagnostics={() => setDiagnosticsOpen(true)}
            />
            <PresenceToastStack notices={arena.presenceNotices} onDismiss={arena.dismissPresenceNotice} />
            <button
                type="button"
                className="mobile-drawer-toggle"
                aria-expanded={mobileDrawerOpen}
                onClick={() => setMobileDrawerOpen((open) => !open)}
            >
                {mobileDrawerOpen ? 'Close Ops' : 'Ops'}
            </button>
            <ArenaOperations
                arena={arena}
                localColor={presentation.localColor}
                matchRemainingMs={presentation.matchRemainingMs}
            />
            <ArenaPeers arena={arena} />
            {diagnosticsOpen && (
                <DiagnosticsDrawer
                    nowMs={Date.now}
                    arena={arena}
                    onClose={() => setDiagnosticsOpen(false)}
                />
            )}
            {winnerMatch && (
                <MatchWinnerOverlay
                    match={winnerMatch}
                    onClose={() => presentation.setDismissedMatchId(winnerMatch.matchId)}
                />
            )}
        </main>
    );
}
