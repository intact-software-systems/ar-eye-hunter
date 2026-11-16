import './online.css';

import { rallar } from '@shared-web/browser/rallar.ts';

import { requirePracticeElement } from '../practice-controls.ts';
import { OnlineMatch } from './online-match.ts';
import { renderFriends, renderMatchmaking, renderRoom } from './online-panels.ts';
import { OnlineSession } from './online-session.ts';

export class OnlineLobby {
    private readonly root: HTMLElement;
    private readonly session = new OnlineSession(
        rallar,
        import.meta.env.VITE_RALLAR_API_BASE_URL || (import.meta.env.DEV ? 'http://localhost:8084' : location.origin)
    );
    private readonly lifetime = new AbortController();
    private readonly unsubscribe: () => void;
    private signedIn = false;
    private readonly match: OnlineMatch;

    constructor(root: HTMLElement, onSolo: () => void) {
        this.root = root;
        root.innerHTML =
            `<main class="online"><header><p class="eyebrow">GRUMPY TOWN / PLAY TOGETHER</p><h1>Partners in mischief</h1><button id="solo">Back to solo</button></header><p id="connection" role="status">Connecting to Rallar…</p><p id="online-error" role="alert"></p><div id="account"></div><div id="lobby-panels" hidden><section id="room-panel"></section><section id="matchmaking-panel"></section><section id="friends-panel"></section></div></main>`;
        requirePracticeElement(root, '#solo').addEventListener('click', onSolo, { signal: this.lifetime.signal });
        root.addEventListener('submit', (event) => this.submit(event), { signal: this.lifetime.signal });
        root.addEventListener('click', (event) => this.click(event), { signal: this.lifetime.signal });
        this.match = new OnlineMatch({
            root,
            browser: rallar,
            onLeave: () => {
                void this.session.leaveTown();
            },
            onSolo
        });
        this.unsubscribe = this.session.onChange(() => this.render());
        void this.session.start();
    }

    async stop(): Promise<void> {
        this.match.stop();
        this.lifetime.abort();
        this.unsubscribe();
        await this.session.stop();
    }

    private render(): void {
        const state = this.session.getState();
        const signedIn = state.connected && Boolean(state.username);
        requirePracticeElement(this.root, '#connection').textContent = signedIn
            ? `Connected as ${state.username}`
            : state.busy
            ? 'Connecting to Rallar…'
            : 'Solo needs no account. Sign in here to play together.';
        requirePracticeElement(this.root, '#online-error').textContent = state.error || state.entry.failure?.message ||
            '';
        const account = requirePracticeElement(this.root, '#account');
        if (signedIn !== this.signedIn || !account.childElementCount) {
            this.signedIn = signedIn;
            account.innerHTML = signedIn
                ? '<button data-action="logout">Sign out</button>'
                : `<form id="sign-in"><label>Username<input name="username" autocomplete="username" required maxlength="64"></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><div class="button-row"><button class="primary" name="intent" value="login">Sign in</button><button name="intent" value="register">Create account</button></div></form>`;
        }
        for (const button of account.querySelectorAll('button')) {
            button.disabled = state.busy;
        }
        requirePracticeElement(this.root, '#lobby-panels').hidden = !signedIn;
        if (signedIn) {
            renderRoom(requirePracticeElement(this.root, '#room-panel'), state);
            renderMatchmaking(requirePracticeElement(this.root, '#matchmaking-panel'), state.matchmaking);
            renderFriends(requirePracticeElement(this.root, '#friends-panel'), state);
            this.match.reconcile();
        }
        else {
            this.match.stop();
        }
    }

    private submit(event: SubmitEvent): void {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) {
            return;
        }
        event.preventDefault();
        const fields = new FormData(form);
        if (form.id === 'sign-in') {
            const register = event.submitter instanceof HTMLButtonElement && event.submitter.value === 'register';
            void this.session.authenticate({
                username: String(fields.get('username')).trim(),
                password: String(fields.get('password'))
            }, register);
        }
        if (form.id === 'join-town') {
            void this.session.joinTown(String(fields.get('room')).trim());
        }
        if (form.id === 'add-friend') {
            void this.session.friends.act({ action: 'request', username: String(fields.get('friend')).trim() });
            form.reset();
        }
    }

    private click(event: MouseEvent): void {
        const button = event.target instanceof Element
            ? event.target.closest<HTMLButtonElement>('button[data-action]')
            : null;
        if (!button || button.disabled) {
            return;
        }
        const principalId = button.dataset.principal ?? '';
        const invitationId = button.dataset.invitation ?? '';
        switch (button.dataset.action) {
            case 'logout':
                void this.session.logout();
                break;
            case 'create':
                void this.session.createTown();
                break;
            case 'leave':
                void this.session.leaveTown();
                break;
            case 'find':
                void this.session.actMatchmaking('find');
                break;
            case 'confirm':
                void this.session.actMatchmaking('confirm');
                break;
            case 'cancel-search':
                void this.session.actMatchmaking('cancel');
                break;
            case 'enter-match':
                void this.session.enterMatchmaking();
                break;
            case 'refresh-social':
                void this.session.friends.refresh();
                break;
            case 'retry-search':
                void this.session.matchmaking.refresh();
                break;
            case 'retry-matchmaking-action':
                void this.session.actMatchmaking('retry');
                break;
            case 'retry-friend-action':
                void this.session.friends.retry();
                break;
            case 'accept':
                void this.session.friends.act({ action: 'accept', principalId });
                break;
            case 'decline':
                void this.session.friends.act({ action: 'decline', principalId });
                break;
            case 'block':
                void this.session.friends.act({ action: 'block', principalId });
                break;
            case 'unblock':
                void this.session.friends.act({ action: 'unblock', principalId });
                break;
            case 'remove':
                void this.session.friends.act({ action: 'remove', principalId });
                break;
            case 'cancel-friend':
                void this.session.friends.act({ action: 'cancel', principalId });
                break;
            case 'invite':
                this.invite(principalId);
                break;
            case 'open-invitation':
                void this.session.enterInvitation(invitationId);
                break;
            case 'dismiss':
                void this.session.friends.act({ action: 'dismiss', invitationId });
                break;
            case 'visibility':
                void this.session.friends.act({
                    action: 'visibility',
                    shareOnline: !this.session.friends.getState().view?.shareOnline
                });
                break;
        }
    }

    private invite(principalId: string): void {
        const roomRef = this.session.getState().rooms.currentRoomRef;
        if (roomRef) {
            void this.session.friends.act({
                action: 'invite',
                principalId,
                roomRef: {
                    applicationId: roomRef.applicationId,
                    workspaceId: roomRef.workspaceId,
                    groupId: roomRef.groupId
                },
                kind: 'room'
            });
        }
    }
}
