import { renderSVG } from 'uqr';
import type { OnlineSession } from './online-session.ts';

export function renderGuestSharing(root: HTMLElement, state: OnlineSession.State): void {
    if (!state.ownsTown) {
        root.replaceChildren();
        return;
    }
    let button = root.querySelector<HTMLButtonElement>('button');
    if (!button) {
        button = document.createElement('button');
        button.dataset.action = 'invite-guests';
        root.append(button);
    }
    button.disabled = state.busy;
    button.textContent = state.invitation ? 'Replace invitation' : 'Invite guests';
    let details = root.querySelector('section');
    if (!state.invitation) {
        details?.remove();
        return;
    }
    if (details?.querySelector('input')?.value === state.invitation.href) {
        return;
    }
    if (!details) {
        details = document.createElement('section');
        root.append(details);
    }
    details.innerHTML = `<label>Guest invitation link<input readonly></label><img alt="Scan to join this town" width="200" height="200"><p>Friends can scan this code or open the link for 15 minutes.</p>`;
    const link = details.querySelector('input')!;
    link.value = state.invitation.href;
    link.addEventListener('focus', () => link.select());
    const qr = renderSVG(state.invitation.href, { border: 4 });
    details.querySelector('img')!.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr)}`;
}
