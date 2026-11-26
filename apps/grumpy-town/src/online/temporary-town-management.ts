import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarFacade } from '@shared-web/browser/rallar.ts';
import { guestInvitationUrl, saveGuestVisit, type AdmittedGuestVisit } from './guest-visit.ts';
import { issueTownInvitation } from './issue-town-invitation.ts';
import { renderGuestSharing } from './render-guest-sharing.ts';

export namespace TemporaryTownManagement {
    export interface Input {
        readonly root: HTMLElement;
        readonly opener: HTMLButtonElement;
        readonly dialog: HTMLDialogElement;
        readonly browser: RallarFacade;
        readonly visit: AdmittedGuestVisit;
        readonly signal: AbortSignal;
    }
}

/** Controls management using the current room owner, independent of who directs the game. */
export class TemporaryTownManagement {
    private readonly input: TemporaryTownManagement.Input;
    private current: GroupSnapshot;
    private secret: string | undefined;
    private busy = false;
    private error = '';

    constructor(input: TemporaryTownManagement.Input, snapshot: GroupSnapshot) {
        this.input = input;
        this.current = snapshot;
        this.secret = input.visit.invitationSecret;
        const { root, opener, dialog, signal } = input;
        const lobbySharing = root.parentElement!;
        opener.addEventListener('click', () => {
            dialog.append(root);
            dialog.showModal();
        }, { signal });
        dialog.addEventListener('close', () => lobbySharing.append(root), { signal });
        input.root.addEventListener('click', event => {
            const button = event.target instanceof Element ? event.target.closest('button') : null;
            if (button && !button.disabled) void this.act(button);
        }, { signal: input.signal });
        this.observe(snapshot);
    }

    observe(snapshot: GroupSnapshot): void {
        this.current = snapshot;
        const { root, visit, opener, dialog } = this.input;
        const managesRoom = Boolean(snapshot.group.temporaryPlayerRoom && snapshot.group.ownerPrincipalId === visit.access.clientId);
        opener.hidden = !managesRoom;
        if (!managesRoom) {
            if (dialog.open) dialog.close();
            this.dropSecret();
            root.replaceChildren();
            return;
        }
        if (!snapshot.group.guestInvitation) this.dropSecret();
        if (!root.firstElementChild) root.innerHTML = '<div class="invitation"></div><ul></ul><p role="alert"></p>';
        const link = this.secret ? guestInvitationUrl(visit.room, this.secret) : null;
        renderGuestSharing(root.querySelector('.invitation')!, link, this.busy);
        root.querySelector('[role=alert]')!.textContent = this.error;
        const roster = root.querySelector('ul')!;
        roster.replaceChildren();
        for (const player of snapshot.members) {
            if (player.status !== 'active' || player.principalId === visit.access.clientId) continue;
            const row = document.createElement('li');
            row.textContent = player.guestLease?.displayName ?? player.principalId;
            row.append(this.button('Remove guest', 'remove', player.principalId));
            if (snapshot.activeSessions.some(session => session.principalId === player.principalId)) {
                row.append(this.button('Hand over management', 'handover', player.principalId));
            }
            roster.append(row);
        }
    }

    private button(label: string, action: string, principal: string): HTMLButtonElement {
        const button = document.createElement('button');
        button.textContent = label;
        button.dataset.action = action;
        button.dataset.principal = principal;
        button.disabled = this.busy;
        return button;
    }

    private dropSecret(): void {
        if (!this.secret) return;
        this.secret = undefined;
        const { invitationSecret: _removed, ...seat } = this.input.visit;
        void saveGuestVisit(seat).catch(() => {
            this.error = 'The revoked invitation could not be removed from this device.';
        });
    }

    private async act(button: HTMLButtonElement): Promise<void> {
        const { browser, visit, signal } = this.input;
        const room = this.current.group;
        if (this.busy || room.ownerPrincipalId !== visit.access.clientId) return;
        this.busy = true;
        this.error = '';
        this.observe(this.current);
        try {
            const principal = button.dataset.principal;
            if (button.dataset.action === 'invite-guests') {
                const { secret, snapshot } = await issueTownInvitation(browser, room, signal);
                signal.throwIfAborted();
                this.secret = secret;
                await saveGuestVisit({ ...visit, invitationSecret: secret });
                this.observe(snapshot);
            } else if (button.dataset.action === 'remove' && principal) {
                this.observe(await browser.rooms.removeMember(room, principal, { signal }));
            } else if (button.dataset.action === 'handover' && principal) {
                this.observe(await browser.rooms.transferOwnership(room, principal, { signal }));
            }
        } catch {
            this.error = 'Room management could not be updated. Try again.';
        } finally {
            this.busy = false;
            if (!signal.aborted) this.observe(this.current);
        }
    }
}
