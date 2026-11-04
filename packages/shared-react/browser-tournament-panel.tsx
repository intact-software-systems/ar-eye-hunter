import type { SubscribeViewInvalidations } from '@shared-web/browser/api/subscribe-view-invalidations.ts';
import type { RallarConnectionOperations } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarRoomEntry } from '@shared-web/browser/rooms/entry/rallar-room-entry.ts';
import { RallarTournamentCatalog } from '@shared-web/browser/tournaments/rallar-tournament-catalog.ts';
import { RallarTournament } from '@shared-web/browser/tournaments/rallar-tournament.ts';
import { useCallback, useState } from 'react';
import { TournamentPanel } from './tournament-panel.tsx';

export interface BrowserTournamentPanelProps {
    readonly browser:
        & SubscribeViewInvalidations.Browser
        & Pick<RallarRoomEntry.Browser, 'auth'>
        & Pick<RallarConnectionOperations, 'connect'>;
    readonly entry: RallarRoomEntry;
    readonly catalogConfig: RallarTournamentCatalog.Config;
}

/** Composes the browser owners once per mounted game/workspace; the panel owns their subscriptions. */
export function BrowserTournamentPanel(
    { browser, entry, catalogConfig }: BrowserTournamentPanelProps
) {
    const [catalog] = useState(() => RallarTournamentCatalog.createBrowser(browser, catalogConfig));
    const scope = catalogConfig.scope;
    const createOwner = useCallback((tournamentId: string) =>
        RallarTournament.createBrowser(browser, entry, {
            scope,
            tournamentId
        }), [browser, entry, scope]);
    return <TournamentPanel catalog={catalog} scope={scope} createOwner={createOwner} />;
}
