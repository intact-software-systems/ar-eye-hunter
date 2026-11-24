import type { RallarFacade } from '@shared-web/browser/rallar.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';

import type { GuestConnectionDiagnostics } from './guest-connection-diagnostics.ts';
import { TownMatchGame } from '../match/presentation/town-match-game.ts';
import type { TownMatchState } from '../match/town-match.ts';
import { TownMatchSession } from '../match/town-match-session.ts';

/** Owns the current room's match lifetime independently of social-panel rerenders. */
export namespace OnlineMatch {
    export interface Input {
        readonly root: HTMLElement;
        readonly browser: RallarFacade;
        readonly onLeave: () => void;
        readonly onSolo: () => void;
        readonly diagnostics?: GuestConnectionDiagnostics;
    }
    export interface Button {
        readonly label: string;
        readonly action: () => void;
        readonly disabled: boolean;
    }
}

export class OnlineMatch {
    private renderKey = '';
    private completedRound: Pick<TownMatchState, 'matchId' | 'results'> | undefined;

    get lastConfirmedResults(): TownMatchState['results'] | undefined {
        return this.completedRound?.results;
    }
    private session: TownMatchSession | undefined;
    private unsubscribe: (() => void) | undefined;
    private game: TownMatchGame | undefined;

    private readonly root: HTMLElement;
    private readonly browser: RallarFacade;
    private readonly onLeave: () => void;
    private readonly onSolo: () => void;
    private readonly diagnostics: GuestConnectionDiagnostics | undefined;

    constructor(input: OnlineMatch.Input) {
        const { root, browser, onLeave, onSolo } = input;
        this.root = root;
        this.browser = browser;
        this.onLeave = onLeave;
        this.onSolo = onSolo;
        this.diagnostics = input.diagnostics;
    }

    reconcile(): void {
        const room = this.browser.rooms.selected();
        if (this.session && (!room || !isSameGroupRef(this.session.roomRef, room))) {
            this.stop();
        }
        if (room && !this.session) {
            this.session = new TownMatchSession({
                browser: this.browser,
                timers: createDefaultTimers(),
                subtle: crypto.subtle,
                newMatchId: () => crypto.randomUUID()
            }, { applicationId: room.applicationId, workspaceId: room.workspaceId, groupId: room.groupId });
            this.unsubscribe = this.session.onChange(() => this.render());
            this.session.start();
        }
        this.render();
    }

    stop(): void {
        this.unsubscribe?.();
        this.game?.stop();
        this.session?.stop();
        this.unsubscribe = undefined;
        this.game = undefined;
        this.session = undefined;
        this.renderKey = '';
        this.root.querySelector('#online-game')?.remove();
        const lobby = this.root.querySelector<HTMLElement>('.online');
        if (lobby) {
            lobby.hidden = false;
        }
    }

    private render(): void {
        const session = this.session;
        const controls = this.root.querySelector<HTMLElement>('#match-controls');
        if (!session || !controls) {
            return;
        }
        const view = session.getView();
        const match = view.match;
        if (match?.phase === 'finished') {
            this.completedRound = { matchId: match.matchId, results: match.results };
        }
        else if (match && this.completedRound?.matchId !== match.matchId) {
            this.completedRound = undefined;
        }
        this.renderGame(view);
        this.diagnostics?.display(view);
        const key = JSON.stringify([
            this.game?.isReady(),
            this.game?.getError(),
            view.available,
            view.isDirector,
            view.error,
            view.appointmentEligibility,
            view.appointing,
            match?.matchId,
            match?.phase,
            match?.members
        ]);
        if (key === this.renderKey && controls.childElementCount > 0) {
            return;
        }
        this.renderKey = key;
        this.renderControls(controls, session, view);
    }

    private renderControls(controls: HTMLElement, session: TownMatchSession, view: TownMatchSession.View): void {
        const match = view.match;
        const ready = match?.members.find((member) => member.id === view.localId)?.ready;
        controls.replaceChildren();
        const status = document.createElement('p');
        status.textContent = view.error || this.game?.getError() ||
            (match && !this.game?.isReady() ? 'Preparing the town…' : match
                ? `${match.members.filter((member) => member.ready).length}/${match.members.length} ready · ${
                    view.isDirector ? 'You direct this match' : 'Player-hosted match'
                }`
                : view.appointing
                ? 'Appointing your browser as host…'
                : view.appointmentEligibility.allowed
                ? 'Appoint a player to direct this match.'
                : view.appointmentEligibility.reason ?? 'Waiting for an eligible host.');
        controls.append(status);
        if (!match || !view.available) {
            this.addButton(controls, {
                label: 'Host match',
                action: () => {
                    void session.appoint();
                },
                disabled: view.appointing || !view.appointmentEligibility.allowed
            });
        }
        if (match?.phase === 'lobby') {
            this.addButton(controls, {
                label: ready ? 'Not ready' : 'Ready',
                action: () => {
                    void session.act({ kind: 'ready', ready: !ready });
                },
                disabled: !view.available || !this.game?.isReady()
            });
            if (view.isDirector) {
                this.addButton(controls, {
                    label: 'Start round',
                    action: () => {
                        void session.act({ kind: 'start' });
                    },
                    disabled: !this.game?.isReady() || match.members.length < 2 ||
                        !match.members.every((member) => member.ready)
                });
            }
        }
    }

    private renderGame(view: TownMatchSession.View): void {
        const playing = view.match && view.match.phase !== 'lobby';
        const lobby = this.root.querySelector<HTMLElement>('.online');
        if (lobby) {
            lobby.hidden = Boolean(playing);
        }
        if (view.match && !this.game && this.session) {
            const root = document.createElement('div');
            root.id = 'online-game';
            this.root.append(root);
            this.game = new TownMatchGame({
                root,
                session: this.session,
                onLeave: this.onLeave,
                onSolo: this.onSolo
            });
        }
        this.game?.setVisible(Boolean(playing));
    }

    private addButton(root: HTMLElement, definition: OnlineMatch.Button): void {
        const button = document.createElement('button');
        button.textContent = definition.label;
        button.disabled = definition.disabled;
        button.onclick = definition.action;
        root.append(button);
    }
}
