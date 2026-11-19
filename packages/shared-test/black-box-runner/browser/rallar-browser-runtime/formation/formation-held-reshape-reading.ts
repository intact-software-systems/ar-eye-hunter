import { toScopedRoomKey } from '@shared/api/api-type-utils.ts';
import type { GroupFormationView } from '@shared/api/group-lifecycle/group-formation-view.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toError } from '@shared/resilience/to-error.ts';

import type { BlackBoxRallarFormationHeldReshape } from '../black-box-rallar-operation-contracts.ts';

/** The scale lane measured follow-up replanning 2.7 s after acceptance; a layout held this long with nothing pending is settled. */
export const FORMATION_LAYOUT_QUIET_WINDOW_MS = 3_500;

type HeldReading = Extract<BlackBoxRallarFormationHeldReshape, { reading: 'held'; }>;

const LAYOUT_NOT_SETTLED: BlackBoxRallarFormationHeldReshape = { reading: 'not-read', because: 'layout-not-settled' };

export namespace FormationHeldReshapeReading {
    export interface Dependencies {
        readView(roomRef: GroupRef, timeoutMs: number): Promise<GroupFormationView>;
        now(): number;
    }
    export interface UnsettledObservation {
        readonly roomRef: GroupRef;
        readonly settled: false;
    }
    /** Nothing pending, and the accepted layout held for FORMATION_LAYOUT_QUIET_WINDOW_MS. */
    export interface SettledObservation {
        readonly roomRef: GroupRef;
        readonly settled: true;
        /** When the page began holding its accepted layout; a held reading is reused only under the same one. */
        readonly acceptedHeldSinceEpochMs: number;
        readonly timeoutMs: number;
    }
    export type Observation = UnsettledObservation | SettledObservation;
}

interface RememberedHeldReading {
    readonly held: HeldReading;
    readonly acceptedHeldSinceEpochMs: number;
}

/**
 * What each room's settled page last read of the reshape the server holds. The view is several server queries, so a
 * held reading is repeated without a read until its gate opens, while the page holds the same accepted layout;
 * `none` and `layout-stale` come only from a read at this observation.
 */
export class FormationHeldReshapeReading {
    readonly #dependencies: FormationHeldReshapeReading.Dependencies;
    readonly #held = new Map<string, RememberedHeldReading>();

    constructor(dependencies: FormationHeldReshapeReading.Dependencies) {
        this.#dependencies = dependencies;
    }

    async observe(observation: FormationHeldReshapeReading.Observation): Promise<BlackBoxRallarFormationHeldReshape> {
        const key = toScopedRoomKey(observation.roomRef);
        if (!observation.settled) {
            this.#held.delete(key);
            return LAYOUT_NOT_SETTLED;
        }
        const remembered = this.#held.get(key);
        if (
            remembered !== undefined &&
            remembered.acceptedHeldSinceEpochMs === observation.acceptedHeldSinceEpochMs &&
            this.#dependencies.now() < remembered.held.opensAtEpochMs
        ) {
            return remembered.held;
        }
        return this.#read(key, observation);
    }

    async #read(
        key: string,
        observation: FormationHeldReshapeReading.SettledObservation
    ): Promise<BlackBoxRallarFormationHeldReshape> {
        const view = await this.#dependencies.readView(observation.roomRef, observation.timeoutMs).catch(toError);
        if (view instanceof Error) {
            return { reading: 'not-read', because: 'view-read-failed', message: view.message };
        }
        const readAtEpochMs = this.#dependencies.now();
        if (view.heldReshape !== null) {
            const held: HeldReading = {
                reading: 'held',
                readAtEpochMs,
                wantedReasons: view.heldReshape.wantedReasons,
                opensAtEpochMs: view.heldReshape.opensAtEpochMs
            };
            this.#held.set(key, { held, acceptedHeldSinceEpochMs: observation.acceptedHeldSinceEpochMs });
            return held;
        }
        this.#held.delete(key);
        return view.layoutStale ? { reading: 'layout-stale', readAtEpochMs } : { reading: 'none', readAtEpochMs };
    }
}
