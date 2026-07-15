type BrowserAgentPopup = Readonly<{
    closed: boolean;
    document?: {
        title: string;
        body: { textContent: string };
    };
    location: Readonly<{ replace(url: string): void }>;
    close(): void;
}> & { opener: unknown };

type BrowserAgentPopupOpen = (
    url?: string | URL,
    target?: string,
    features?: string,
) => BrowserAgentPopup | null;

export type BrowserAgentPopupReservation = Readonly<{
    reservedAgentIds: readonly string[];
    blockedAgentIds: readonly string[];
    reserved: readonly Readonly<{
        agentId: string;
        popup: BrowserAgentPopup;
    }>[];
}>;

export function reserveBrowserAgentPopups(
    agentIds: readonly string[],
    open: BrowserAgentPopupOpen = globalThis.open as BrowserAgentPopupOpen,
): BrowserAgentPopupReservation {
    const reserved: Array<{
        agentId: string;
        popup: BrowserAgentPopup;
    }> = [];
    const blockedAgentIds: string[] = [];
    for (const agentId of agentIds) {
        const popup = open?.('about:blank', '_blank');
        if (!popup) {
            blockedAgentIds.push(agentId);
            continue;
        }
        try {
            popup.opener = null;
            if (popup.document) {
                popup.document.title = 'Rallar browser agent';
                popup.document.body.textContent =
                    `Preparing browser agent ${agentId}…`;
            }
        } catch {
            // The reserved page may become cross-origin before presentation updates.
        }
        reserved.push({ agentId, popup });
    }
    return {
        reservedAgentIds: reserved.map(item => item.agentId),
        blockedAgentIds,
        reserved,
    };
}

export function navigateReservedBrowserAgentPopups(
    reservation: BrowserAgentPopupReservation,
    agents: readonly Readonly<{ agentId: string; launchUrl: string }>[],
): void {
    const byAgentId = new Map(agents.map(agent => [agent.agentId, agent]));
    if (
        byAgentId.size !== reservation.reserved.length ||
        reservation.reserved.some(item => !byAgentId.has(item.agentId))
    ) {
        throw new Error('Prepared browser-agent links do not match reserved popup identities.');
    }
    for (const item of reservation.reserved) {
        if (!item.popup.closed) {
            item.popup.location.replace(byAgentId.get(item.agentId)!.launchUrl);
        }
    }
}

export function releaseReservedBrowserAgentPopups(
    reservation: BrowserAgentPopupReservation,
    message = 'Browser-agent launch was cancelled.',
): void {
    for (const item of reservation.reserved) {
        try {
            if (item.popup.document) {
                item.popup.document.body.textContent = message;
            }
            if (!item.popup.closed) item.popup.close();
        } catch {
            // Ignore a window that navigated or closed during cleanup.
        }
    }
}
