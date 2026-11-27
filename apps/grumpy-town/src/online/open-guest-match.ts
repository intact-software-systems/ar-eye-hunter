import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { findStateGroup } from '@shared-web/browser/state-read/state-snapshot-http-api.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import { clearSession, configureAuthSessionStorage, resetAuthSessionStorage, writeSession } from '@shared/api/auth.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { GuestConnectionDiagnostics } from './guest-connection-diagnostics.ts';
import { OnlineMatch } from './online-match.ts';
import { forgetGuestVisit, type AdmittedGuestVisit } from './guest-visit.ts';
import { TemporaryTownManagement } from './temporary-town-management.ts';
import { watchTownClockLoss } from './watch-town-clock-loss.ts';
import { GRUMPY_TOWN_SCOPE, townApiBaseUrl, townGroupPresence } from './town-server.ts';
import './online.css';

interface OpenGuestMatchInput {
    readonly root: HTMLElement;
    readonly visit: AdmittedGuestVisit;
    readonly snapshot: GroupSnapshot;
    readonly pageSignal: AbortSignal;
}

export function openGuestMatch({ root, visit, snapshot, pageSignal }: OpenGuestMatchInput): void {
    const lifetime = new AbortController();
    const signal = AbortSignal.any([pageSignal, lifetime.signal]);
    const roomRef = { ...GRUMPY_TOWN_SCOPE, groupId: visit.room };
    root.innerHTML = `<main class="online"><header><h1>Your town lobby</h1><a>Play solo</a></header>
        <p id="town-name"></p><div id="lobby-sharing"><div id="sharing"></div></div><p>You are <output aria-label="Your nickname"></output>.</p>
        <p id="guest-connection" role="status">Connecting to the match…</p><div id="match-controls"></div>
        <button type="button" hidden>Reconnect to match</button></main>
        <button id="manage-town" type="button" hidden>Manage town</button>
        <dialog id="town-management" aria-label="Manage town"><form method="dialog"><button>Back to match</button></form></dialog>`;
    const status = root.querySelector<HTMLElement>('#guest-connection')!;
    const retry = root.querySelector('button')!;
    let stopRoomAccess: (() => void) | undefined;
    root.querySelector('a')!.href = import.meta.env.BASE_URL;
    root.querySelector('output')!.value = visit.nickname;
    const management = new TemporaryTownManagement({
        root: root.querySelector<HTMLElement>('#sharing')!, opener: root.querySelector<HTMLButtonElement>('#manage-town')!,
        dialog: root.querySelector<HTMLDialogElement>('#town-management')!, browser: rallar, visit, signal
    }, snapshot);
    const occupants = root.querySelector<HTMLElement>('#town-name')!;
    const renderOccupants = (room: GroupSnapshot) => {
        const count = room.members.filter(member => member.status === 'active').length;
        occupants.textContent = `${room.group.displayName} · ${count} ${count === 1 ? 'player' : 'players'}`;
    };
    renderOccupants(snapshot);
    configureAuthSessionStorage('memory');
    writeSession({ ...visit.access, username: visit.nickname, guestRoom: roomRef });
    const leave = () => location.assign(import.meta.env.BASE_URL);
    const diagnostics = new URLSearchParams(location.search).get('diagnostics') === '1'
        ? new GuestConnectionDiagnostics(root, signal) : undefined;
    const match = new OnlineMatch({ root, browser: rallar, onLeave: leave, onSolo: leave, diagnostics });
    const unsubscribe = rallar.rooms.onChange(state => {
        if (state.currentRoom?.group.groupId === visit.room) {
            renderOccupants(state.currentRoom);
            management.observe(state.currentRoom);
        }
        match.reconcile();
    });
    const stopSocket = rallar.ws.onLifecycle(event => {
        if (event.kind === 'close') diagnostics?.closed(event.code);
        if (event.kind === 'disconnected') showRetry();
        if (event.kind === 'close' && event.code === 1008) {
            void recheckAccess();
        }
    }, { emitCurrent: false });
    const cancelRecovery = watchTownClockLoss(rallar, signal, async attempt => {
        await rallar.connect({ signal: attempt });
        await enterVerifiedRoom(attempt);
    }, error => {
        if (error instanceof ApiHttpError && [401, 403, 404].includes(error.status)) endAccess();
        else showRetry();
    });
    const stopAuth = rallar.auth.onChange(state => {
        if (!state.authenticated && (state.reason === 'expired' || state.reason === 'unauthorized')) {
            endAccess();
        }
    }, { emitCurrent: false });
    signal.addEventListener('abort', () => {
        unsubscribe();
        stopSocket();
        stopRoomAccess?.();
        stopAuth();
        match.stop();
        void rallar.disconnect().finally(() => {
            clearSession();
            resetAuthSessionStorage();
        });
    }, { once: true });
    retry.addEventListener('click', () => {
        cancelRecovery();
        void connect();
    }, { signal });
    void connect();

    async function recheckAccess(): Promise<void> {
        try {
            await findStateGroup(visit.room, GRUMPY_TOWN_SCOPE, {
                signal, authSession: { ...visit.access, username: visit.nickname }
            });
        }
        catch (error) {
            if (!signal.aborted && error instanceof ApiHttpError && [401, 403, 404].includes(error.status)) {
                endAccess();
            }
        }
    }

    function endAccess(): void {
        if (signal.aborted) return;
        const results = match.lastConfirmedResults;
        lifetime.abort();
        void forgetGuestVisit(visit.room).catch(() => {
            root.querySelector('[role=alert]')!.textContent += ' Clear site data to remove the saved visit from this device.';
        });
        root.innerHTML = `<main class="loading"><h1></h1><ul></ul><p role="alert">Guest access has ended. Ask the owner for a fresh invitation.</p><a>Play solo</a></main>`;
        root.querySelector('h1')!.textContent = results ? 'Round complete' : 'Town invitation';
        root.querySelector('a')!.href = import.meta.env.BASE_URL;
        const scores = root.querySelector('ul')!;
        diagnostics?.show(root.querySelector('main'));
        for (const result of results ?? []) {
            const row = document.createElement('li');
            row.textContent = `${result.displayName}: ${result.score}${result.qualified ? ' — WINNER!' : ''}`;
            scores.append(row);
        }
    }

    async function connect(): Promise<void> {
        retry.hidden = true;
        status.textContent = 'Connecting to the match…';
        try {
            await rallar.setup({
                apiBaseUrl: townApiBaseUrl, ...GRUMPY_TOWN_SCOPE,
                groupPresence: townGroupPresence,
                start: { connect: true, refreshRooms: false, refreshPeople: false, signal }
            });
            await enterVerifiedRoom(signal);
        }
        catch {
            await recheckAccess();
            showRetry();
        }
    }

    async function enterVerifiedRoom(attempt: AbortSignal): Promise<void> {
        await rallar.rooms.join(roomRef, { presenceOnly: true, signal: attempt });
        attempt.throwIfAborted();
        status.textContent = '';
        retry.hidden = true;
        match.reconcile();
        stopRoomAccess ??= rallar.rooms.watchAccess(roomRef, access => {
            if (access.status === 'denied') endAccess();
        }, { signal });
    }

    function showRetry(): void {
        if (!signal.aborted) {
            status.textContent = 'Your seat is saved. Reconnect to play.';
            retry.hidden = false;
        }
    }
}
