import type { RallarRoomEntry } from '@shared-web/browser/rooms/entry/rallar-room-entry.ts';
import { RallarTournamentCatalog } from '@shared-web/browser/tournaments/rallar-tournament-catalog.ts';
import { RallarTournament } from '@shared-web/browser/tournaments/rallar-tournament.ts';
import { useCallback, useState } from 'react';
import { TournamentPanel } from './tournament-panel.tsx';

export interface BrowserTournamentPanelProps {
    readonly browser: Pick<RallarRoomEntry.Browser, 'auth' | 'session'>;
    readonly entry: RallarRoomEntry;
    readonly catalogConfig: RallarTournamentCatalog.Config;
    readonly bracketRefreshIntervalMs: number;
}

/** Composes the browser owners once per mounted game/workspace; the panel owns their subscriptions. */
export function BrowserTournamentPanel(
    { browser, entry, catalogConfig, bracketRefreshIntervalMs }: BrowserTournamentPanelProps
) {
    const [catalog] = useState(() => RallarTournamentCatalog.createBrowser(browser, catalogConfig));
    const scope = catalogConfig.scope;
    const createOwner = useCallback((tournamentId: string) =>
        RallarTournament.createBrowser(browser, entry, {
            scope,
            tournamentId,
            refreshIntervalMs: bracketRefreshIntervalMs
        }), [browser, entry, scope, bracketRefreshIntervalMs]);
    return <TournamentPanel catalog={catalog} scope={scope} createOwner={createOwner} />;
}
