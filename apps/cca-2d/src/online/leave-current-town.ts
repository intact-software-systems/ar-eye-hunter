import type { RallarFacade } from '@shared-web/browser/rallar.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { CCA_SCOPE } from './town-server.ts';

export async function leaveCurrentTown(browser: RallarFacade, signal: AbortSignal): Promise<void> {
    const current = browser.rooms.selected() ?? browser.rooms.state().currentRoomRef;
    if (!current) {
        return;
    }
    const options = { signal };
    await browser.rooms.session(current).refresh(options);
    const snapshot = browser.rooms.session(current).snapshot();
    const principalId = browser.session()?.clientId;
    if (!snapshot || !isSameGroupRef(snapshot.group, current)) {
        return;
    }
    const roomRef = { ...CCA_SCOPE, groupId: current.groupId };
    if (snapshot.group.ownerPrincipalId === principalId) {
        const successor = snapshot.members.filter((member) =>
            member.status === 'active' && !member.guestLease && member.principalId !== principalId
        ).sort((left, right) => left.principalId.localeCompare(right.principalId))[0];
        if (!successor) {
            await browser.rooms.archive(roomRef, options);
            return;
        }
        await browser.rooms.transferOwnership(roomRef, successor.principalId, options);
    }
    await browser.rooms.leave({ roomRef, ...options });
}
