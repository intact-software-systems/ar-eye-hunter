import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarFacade } from '@shared-web/browser/rallar.ts';
import { watchTownClockLoss } from './watch-town-clock-loss.ts';

/** Keep the account’s explicit room choice across SDK retirement; presence-only reentry still requires its server seat. */
export function trackAccountTownRecovery(
    browser: RallarFacade, lifetime: AbortSignal, settled: (error?: Error) => void
): () => void {
    let visit: { readonly room: GroupRef; readonly sessionId: string } | undefined;
    const stop = browser.rooms.onChange(() => {
        const room = browser.rooms.selected();
        const sessionId = browser.session()?.sessionId;
        if (room && sessionId && (visit?.sessionId !== sessionId || !isSameGroupRef(room, visit.room))) {
            visit = { room, sessionId };
        }
    }, { emitCurrent: false });
    lifetime.addEventListener('abort', stop, { once: true });
    const cancel = watchTownClockLoss(browser, lifetime, async signal => {
        const selected = visit;
        if (!selected || browser.session()?.sessionId !== selected.sessionId) return;
        await browser.start({ connect: true, refreshRooms: false, refreshPeople: false, signal });
        if (signal.aborted || visit !== selected || browser.session()?.sessionId !== selected.sessionId) return;
        await browser.rooms.join(selected.room, { presenceOnly: true, signal });
        settled();
    }, settled);
    return () => {
        cancel();
        visit = undefined;
    };
}
