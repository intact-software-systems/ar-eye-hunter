import { useEffect, useState, useSyncExternalStore } from 'react';

import type { RelicEvent, RelicPublicSnapshot, RelicRoundTransitionEvent } from '@relic-hunters/mod.ts';

import type { Lang } from './lang.ts';
import type { RelicHuntersRuntime } from './relic-hunters-runtime.ts';
import { playRelicEventSound } from './sound.ts';
import { toRelicPhaseBanner, type RelicPhaseBanner } from './to-relic-phase-banner.ts';
import { isPersonalEvent, isTurnResultEvent } from './turn-summary.ts';

interface RelicPersonalFlash {
    readonly tone: 'good' | 'bad';
    readonly key: string;
}

interface RelicRoomFlash {
    readonly room: string;
    readonly key: string;
}

export interface RelicPlayback {
    readonly events: readonly RelicEvent[];
    readonly lastEvent: RelicEvent | undefined;
    readonly personalFlash: RelicPersonalFlash | undefined;
    readonly tension: boolean;
    readonly phaseBanner: RelicPhaseBanner | undefined;
    readonly roomFlash: RelicRoomFlash | undefined;
    readonly focusRoomId: string | undefined;
    clearPersonalFlash(): void;
    clearRoomFlash(): void;
}

export function useRelicPlayback(game: RelicHuntersRuntime.Connection, lang: Lang): RelicPlayback {
    const [playback] = useState(() =>
        new RelicEventPlayback({
            schedule: (callback, delay) => window.setTimeout(callback, delay),
            cancel: (timer) => window.clearTimeout(timer),
            play: playRelicEventSound
        })
    );
    const state = useSyncExternalStore(playback.subscribe, playback.getState);
    useEffect(() => {
        playback.receive(game.snapshot, game.session?.sessionId);
    }, [playback, game.snapshot, game.session?.sessionId]);
    useEffect(() => () => playback.stop(), [playback]);
    const phaseBanner = useRelicPhaseBanner(game.roundTransition, lang);
    const [roomFlash, clearRoomFlash] = useRelicRoomFlash(game.snapshot, game.session?.sessionId);
    const lastEvent = state.events.at(-1);
    return {
        ...state,
        lastEvent,
        phaseBanner,
        roomFlash,
        focusRoomId: relicEventRoom(lastEvent, game.snapshot),
        clearPersonalFlash: () => playback.clearPersonalFlash(),
        clearRoomFlash
    };
}

namespace RelicEventPlayback {
    export interface Dependencies {
        schedule(callback: () => void, delay: number): number;
        cancel(timer: number): void;
        play(event: RelicEvent): void;
    }
    export interface State {
        readonly events: readonly RelicEvent[];
        readonly personalFlash: RelicPersonalFlash | undefined;
        readonly tension: boolean;
    }
}

class RelicEventPlayback {
    private readonly dependencies: RelicEventPlayback.Dependencies;
    private state: RelicEventPlayback.State = { events: [], personalFlash: undefined, tension: false };
    private readonly listeners = new Set<() => void>();
    private readonly seen = new Set<string>();
    private readonly queue: RelicEvent[] = [];
    private timer: number | undefined;
    private gameId: string | undefined;
    private playerId: string | undefined;

    constructor(dependencies: RelicEventPlayback.Dependencies) {
        this.dependencies = dependencies;
    }

    readonly getState = (): RelicEventPlayback.State => this.state;
    readonly subscribe = (listener: () => void): () => void => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    receive(snapshot: RelicPublicSnapshot | undefined, playerId: string | undefined): void {
        if (snapshot?.gameId !== this.gameId || playerId !== this.playerId || this.seen.size === 0) {
            this.stop();
            this.gameId = snapshot?.gameId;
            this.playerId = playerId;
            const events = snapshot?.events ?? [];
            this.seen.clear();
            for (const event of events) {
                this.seen.add(event.id);
            }
            this.publish({ events, personalFlash: undefined, tension: false });
            return;
        }
        for (const event of snapshot?.events ?? []) {
            if (!this.seen.has(event.id)) {
                this.seen.add(event.id);
                this.queue.push(event);
            }
        }
        if (this.timer !== undefined || this.queue.length === 0) {
            return;
        }
        const tension = this.queue.some((event) => isTurnResultEvent(event) || event.type === 'action_revealed');
        this.publish({ ...this.state, tension });
        this.timer = this.dependencies.schedule(() => this.beginReveal(), tension ? 1200 : 400);
    }

    stop(): void {
        if (this.timer !== undefined) {
            this.dependencies.cancel(this.timer);
        }
        this.timer = undefined;
        this.queue.length = 0;
    }

    clearPersonalFlash(): void {
        this.publish({ ...this.state, personalFlash: undefined });
    }

    private beginReveal(): void {
        if (this.state.tension) {
            this.publish({ ...this.state, tension: false });
            this.timer = this.dependencies.schedule(() => this.reveal(), 400);
        }
        else {
            this.reveal();
        }
    }

    private reveal(): void {
        this.timer = undefined;
        const event = this.queue.shift();
        if (!event) {
            return;
        }
        this.dependencies.play(event);
        const personalFlash: RelicPersonalFlash | undefined = isPersonalEvent(event, this.playerId)
            ? { tone: event.tone === 'danger' ? 'bad' : 'good', key: event.id }
            : this.state.personalFlash;
        this.publish({ ...this.state, events: [...this.state.events, event], personalFlash });
        if (this.queue.length > 0) {
            this.timer = this.dependencies.schedule(() => this.reveal(), 750);
        }
    }

    private publish(state: RelicEventPlayback.State): void {
        this.state = state;
        for (const listener of this.listeners) {
            listener();
        }
    }
}

function useRelicPhaseBanner(event: RelicRoundTransitionEvent | undefined, lang: Lang): RelicPhaseBanner | undefined {
    const [banner, setBanner] = useState<RelicPhaseBanner | undefined>();
    useEffect(() => {
        if (!event) {
            setBanner(undefined);
            return;
        }
        const next = toRelicPhaseBanner(event, lang);
        setBanner(next);
        const timer = window.setTimeout(() => setBanner(undefined), next.durationMs);
        return () => window.clearTimeout(timer);
    }, [event, lang]);
    return banner;
}

function useRelicRoomFlash(
    snapshot: RelicPublicSnapshot | undefined,
    playerId: string | undefined
): readonly [RelicRoomFlash | undefined, () => void] {
    const [flash, setFlash] = useState<RelicRoomFlash | undefined>();
    const [previous, setPrevious] = useState<string | undefined>();
    const roomId = snapshot?.players.find((player) => player.playerId === playerId)?.roomId;
    useEffect(() => {
        const room = snapshot?.map.find((candidate) => candidate.id === roomId);
        if (previous && room && previous !== room.id) {
            setFlash({ room: room.name, key: `${snapshot?.gameId}:${snapshot?.round}:${room.id}` });
        }
        setPrevious(roomId);
    }, [roomId, snapshot?.map, previous]);
    useEffect(() => {
        setPrevious(undefined);
        setFlash(undefined);
    }, [snapshot?.gameId, playerId]);
    return [flash, () => setFlash(undefined)];
}

function relicEventRoom(event: RelicEvent | undefined, snapshot: RelicPublicSnapshot | undefined): string | undefined {
    if (!event || !snapshot || (!isTurnResultEvent(event) && event.type !== 'action_revealed')) {
        return undefined;
    }
    return event.animationCue?.roomId ??
        snapshot.players.find((player) => player.playerId === event.animationCue?.playerId)?.roomId;
}
