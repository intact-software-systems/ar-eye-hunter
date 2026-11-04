import type { ArenaEvent, ArenaSnapshot } from '@ar-eye-hunter/arena-contracts.ts';
import { type ArenaSimulationState } from '@ar-eye-hunter/arena-contracts.ts';
import {
    applyArenaEvent,
    hydrateArenaSnapshot,
    stepArenaDirectorState
} from '@ar-eye-hunter/simulation.ts';

export namespace ArenaSceneState {
    /** Synchronously commits only against the exact current predecessor; false has no publication effects. */
    export type PublishSnapshot = (snapshot: ArenaSnapshot, expected: ArenaSnapshot | undefined) => boolean;
    export interface Authority {
        readonly roomId: string | undefined;
        readonly sessionId: string | undefined;
        readonly epoch: number | undefined;
        readonly local: boolean;
        readonly fresh: boolean;
        readonly freshUntilEpochMs: number;
    }
    export interface Observation {
        readonly snapshot: ArenaSnapshot | undefined;
        readonly authority: Authority;
    }
}

/** Owns accepted room state separately from the renderer's speculative state. */
export class ArenaSceneState {
    private readonly initial: ArenaSimulationState;
    private simulation: ArenaSimulationState;
    private observed: ArenaSnapshot | undefined;
    private published: ArenaSnapshot | undefined;
    private authority: ArenaSceneState.Authority | undefined;
    private readonly representedEvents = new Set<string>();

    constructor(initial: ArenaSimulationState) {
        this.initial = initial;
        this.simulation = initial;
    }

    getSimulation(): ArenaSimulationState {
        return this.simulation;
    }

    setPrediction(simulation: ArenaSimulationState): void {
        this.simulation = simulation;
    }

    publishSnapshot(snapshot: ArenaSnapshot, publish: ArenaSceneState.PublishSnapshot): boolean {
        if (!publish(snapshot, this.getPublicationBase())) {
            return false;
        }
        this.published = snapshot;
        return true;
    }

    getPublicationBase(): ArenaSnapshot | undefined {
        return this.published ?? this.observed;
    }

    canPublish(nowEpochMs: number): boolean {
        return this.authority?.roomId !== undefined && this.authority.local && this.authority.fresh &&
            nowEpochMs <= this.authority.freshUntilEpochMs;
    }

    reconcile(observation: ArenaSceneState.Observation): boolean {
        const changed = !sameAuthority(this.authority, observation.authority);
        this.authority = observation.authority;
        const snapshot = observation.snapshot;
        if (!changed && snapshot === this.observed) {
            return false;
        }
        if (snapshot && snapshot.roomId !== observation.authority.roomId) {
            return false;
        }
        this.observed = snapshot;
        if (!changed && snapshot === this.published) {
            return false;
        }
        this.published = undefined;
        if (!snapshot) {
            if (changed) {
                this.simulation = this.initial;
                this.representedEvents.clear();
            }
            return changed;
        }
        this.adoptSnapshot(snapshot, !changed && observation.authority.local && observation.authority.fresh);
        return true;
    }

    advance(nowEpochMs: number): void {
        if (this.authority?.roomId === undefined || this.canPublish(nowEpochMs)) {
            this.simulation = stepArenaDirectorState(this.simulation, nowEpochMs);
        }
    }

    applyEvent(event: ArenaEvent): void {
        if (!this.representedEvents.has(event.id)) {
            this.representedEvents.add(event.id);
            this.simulation = applyArenaEvent(this.simulation, event);
        }
    }

    private adoptSnapshot(
        snapshot: ArenaSnapshot,
        preserveSchedule: boolean
    ): void {
        const hydrated = hydrateArenaSnapshot(snapshot);
        this.simulation = preserveSchedule
            ? {
                ...hydrated,
                players: snapshot.players,
                nextPickupSeq: this.simulation.nextPickupSeq,
                nextPickupAtEpochMs: this.simulation.nextPickupAtEpochMs
            }
            : hydrated;
        for (const event of snapshot.events) {
            this.representedEvents.add(event.id);
        }
    }
}

function sameAuthority(
    previous: ArenaSceneState.Authority | undefined,
    current: ArenaSceneState.Authority
): boolean {
    return previous?.roomId === current.roomId && previous?.sessionId === current.sessionId &&
        previous?.epoch === current.epoch && previous?.local === current.local && previous?.fresh === current.fresh;
}
