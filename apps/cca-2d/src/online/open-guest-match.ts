import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { findStateGroup } from '@shared-web/browser/state-read/state-snapshot-http-api.ts';
import { roomGuestCredentialExpiresAt } from '@shared/api/room-guests/access.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import { clearSession, configureAuthSessionStorage, resetAuthSessionStorage, writeSession } from '@shared/api/auth.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { OnlineMatch } from './online-match.ts';
import { saveGuestVisit, type AdmittedGuestVisit } from './guest-visit.ts';
import { CCA_SCOPE, townApiBaseUrl, townGroupPresence } from './town-server.ts';
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
    const roomRef = { ...CCA_SCOPE, groupId: visit.room };
    root.innerHTML = `<main class="online"><header><h1>Your town lobby</h1><a>Play solo</a></header>
        <p id="town-name"></p><p>You are <output aria-label="Your nickname"></output>.</p>
        <p id="guest-connection" role="status">Connecting to the match…</p><div id="match-controls"></div>
        <button type="button" hidden>Reconnect to match</button></main>`;
    const status = root.querySelector<HTMLElement>('#guest-connection')!;
    const retry = root.querySelector('button')!;
    root.querySelector('a')!.href = import.meta.env.BASE_URL;
    root.querySelector('output')!.value = visit.nickname;
    const occupants = root.querySelector<HTMLElement>('#town-name')!;
    const renderOccupants = (room: GroupSnapshot) => {
        occupants.textContent = `${room.group.displayName} · ${room.members.filter(member => member.status === 'active').length} players`;
    };
    renderOccupants(snapshot);
    configureAuthSessionStorage('session');
    let transportDeadline: number | undefined;
    function syncTransportDeadline(room: GroupSnapshot): void {
        const member = room.members.find(row => row.principalId === visit.access.clientId && row.status === 'active');
        if (!member?.guestLease) {
            return;
        }
        const deadline = roomGuestCredentialExpiresAt(room.group, member);
        if (deadline !== transportDeadline) {
            writeSession({ ...visit.access, username: visit.nickname, guestRoom: roomRef, expiresAtEpochMs: deadline });
            transportDeadline = deadline;
            rallar.auth.restore();
        }
    }
    syncTransportDeadline(snapshot);
    const leave = () => location.assign(import.meta.env.BASE_URL);
    const match = new OnlineMatch({ root, browser: rallar, onLeave: leave, onSolo: leave });
    const unsubscribe = rallar.rooms.onChange(state => {
        if (state.currentRoom?.group.groupId === visit.room) {
            renderOccupants(state.currentRoom);
            syncTransportDeadline(state.currentRoom);
        }
        match.reconcile();
    });
    const stopSocket = rallar.ws.onLifecycle(event => {
        if (event.kind === 'close' && event.code === 1008) {
            void recheckAccess();
        }
    }, { emitCurrent: false });
    const stopAuth = rallar.auth.onChange(state => {
        if (!state.authenticated && (state.reason === 'expired' || state.reason === 'unauthorized')) {
            void recheckAccess();
        }
    }, { emitCurrent: false });
    signal.addEventListener('abort', () => {
        unsubscribe();
        stopSocket();
        stopAuth();
        match.stop();
        void rallar.disconnect().finally(() => {
            clearSession();
            resetAuthSessionStorage();
        });
    }, { once: true });
    retry.addEventListener('click', () => void connect(), { signal });
    void connect();

    async function recheckAccess(): Promise<void> {
        try {
            const current = await findStateGroup(visit.room, CCA_SCOPE, {
                signal, authSession: { ...visit.access, username: visit.nickname }
            });
            if (!signal.aborted) {
                syncTransportDeadline(current);
            }
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
        saveGuestVisit(undefined);
        root.innerHTML = `<main class="loading"><h1></h1><ul></ul><p role="alert">Guest access has ended. Ask the owner for a fresh invitation.</p><a>Play solo</a></main>`;
        root.querySelector('h1')!.textContent = results ? 'Round complete' : 'Town invitation';
        root.querySelector('a')!.href = import.meta.env.BASE_URL;
        const scores = root.querySelector('ul')!;
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
                apiBaseUrl: townApiBaseUrl, ...CCA_SCOPE,
                groupPresence: townGroupPresence,
                start: { connect: true, refreshRooms: false, refreshPeople: false, signal }
            });
            await rallar.rooms.join(roomRef, { presenceOnly: true, signal });
            if (!signal.aborted) {
                status.textContent = '';
                match.reconcile();
                rallar.rooms.watchAccess(roomRef, access => {
                    if (access.status === 'denied') {
                        endAccess();
                    }
                }, { signal });
            }
        }
        catch {
            if (!signal.aborted) {
                status.textContent = 'Your seat is saved. Reconnect to play.';
                retry.hidden = false;
            }
        }
    }
}
