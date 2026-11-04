import { requireEpoch, requireExactKeys, requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
import type {
    ArenaMatchDurationMs,
    ArenaSimulationState,
    PlayerArenaState,
    PlayerInputState,
    ShotIntent
} from './arena-contracts.ts';
import { finishArenaMatchIfDue, startArenaMatch } from './arena-match.ts';
import { forwardFromAngles } from './arena-math.ts';
import { createInitialPlayerState, EMPTY_INPUT, stepLocalPlayer, type LocalPlayerState } from './arena-player-state.ts';
import { resolveShot, stepArenaTargets } from './arena-targets.ts';
import {
    createInitialArenaState,
    findPickupNearPlayer,
    resolvePickupIntent,
    resolvePlayerHitIntent,
    respawnArenaPlayers,
    stepArenaDirectorState
} from './simulation.ts';

export const AR_EYE_TOURNAMENT_RULES_ID = 'ar-eye-native-60s-v1';

const STEP_MS = 50;
const MAX_STEPS_PER_ATTEMPT = 20;
const INPUT_LIFETIME_MS = 250;

export interface TournamentArenaInput {
    readonly sequence: number;
    readonly yaw: number;
    readonly pitch: number;
    readonly controls: PlayerInputState;
}

export interface TournamentArenaPlayer {
    readonly principalId: string;
    readonly simulation: LocalPlayerState;
    readonly input: TournamentArenaInput;
    readonly inputAtEpochMs: number;
}

export interface TournamentArena {
    readonly gameId: string;
    readonly startedAtEpochMs: number;
    readonly endsAtEpochMs: number;
    readonly simulatedAtEpochMs: number;
    readonly arena: ArenaSimulationState;
    readonly players: readonly TournamentArenaPlayer[];
}

export interface CreateTournamentArenaInput {
    readonly gameId: string;
    readonly principalIds: readonly [string, string];
    readonly seed: number;
    readonly startedAtEpochMs: number;
    readonly durationMs: ArenaMatchDurationMs;
}

export interface TournamentArenaInputResolution {
    readonly accepted: boolean;
    readonly state: TournamentArena;
    readonly reason: 'accepted' | 'not-playing' | 'stale-input' | 'input-rate' | 'catching-up';
}

export function createTournamentArena(input: CreateTournamentArenaInput): TournamentArena {
    requireString(input.gameId, 'Tournament game');
    requireEpoch(input.startedAtEpochMs, 'Tournament start');
    requireEpoch(input.startedAtEpochMs + input.durationMs, 'Tournament finish');
    if (
        !Number.isSafeInteger(input.seed) || input.principalIds.length !== 2 || new Set(input.principalIds).size !== 2
    ) {
        throw new TypeError('Tournament arena requires a seed and two distinct accounts');
    }
    const arena = createInitialArenaState(input.seed, input.startedAtEpochMs);
    const players = input.principalIds.map((principalId, index): TournamentArenaPlayer => {
        requireString(principalId, 'Tournament player');
        return {
            principalId,
            simulation: {
                ...createInitialPlayerState(input.startedAtEpochMs),
                position: arena.layout.spawnPoints[index]
            },
            input: { sequence: 0, yaw: 0, pitch: 0, controls: EMPTY_INPUT },
            inputAtEpochMs: input.startedAtEpochMs
        };
    });
    const started = startArenaMatch({ ...arena, players: players.map(toArenaPlayer) }, {
        matchId: input.gameId,
        directorSessionId: 'tournament-server',
        durationMs: input.durationMs,
        sentAtEpochMs: input.startedAtEpochMs
    }, input.startedAtEpochMs);
    if (!started.accepted) {
        throw new TypeError(`Cannot create tournament arena: ${started.reason}`);
    }
    return {
        gameId: input.gameId,
        startedAtEpochMs: input.startedAtEpochMs,
        endsAtEpochMs: input.startedAtEpochMs + input.durationMs,
        simulatedAtEpochMs: input.startedAtEpochMs,
        arena: { ...started.state, match: { ...started.acceptedMatch.match, enrollment: 'confirmed' } },
        players
    };
}

export interface ApplyTournamentArenaInput {
    readonly state: TournamentArena;
    readonly principalId: string;
    readonly input: TournamentArenaInput;
    readonly nowEpochMs: number;
}

export function applyTournamentArenaInput(
    { state: previous, principalId, input: value, nowEpochMs }: ApplyTournamentArenaInput
): TournamentArenaInputResolution {
    const input = decodeTournamentArenaInput(value);
    const state = advanceTournamentArena(previous, nowEpochMs);
    const player = state.players.find((candidate) => candidate.principalId === principalId);
    if (!player || state.arena.match?.status !== 'active' || nowEpochMs >= state.endsAtEpochMs) {
        return { accepted: false, state, reason: 'not-playing' };
    }
    if (state.simulatedAtEpochMs + STEP_MS <= nowEpochMs || nowEpochMs < state.simulatedAtEpochMs) {
        return { accepted: false, state, reason: 'catching-up' };
    }
    if (input.sequence <= player.input.sequence) {
        return { accepted: false, state, reason: 'stale-input' };
    }
    if (player.input.sequence > 0 && nowEpochMs < player.inputAtEpochMs + STEP_MS) {
        return { accepted: false, state, reason: 'input-rate' };
    }
    return {
        accepted: true,
        state: {
            ...state,
            players: state.players.map((candidate) =>
                candidate === player ? { ...candidate, input, inputAtEpochMs: nowEpochMs } : candidate
            )
        },
        reason: 'accepted'
    };
}

/** Bounded deterministic catch-up. Durable work must reschedule while simulated time trails the server clock. */
export function advanceTournamentArena(state: TournamentArena, nowEpochMs: number): TournamentArena {
    requireEpoch(nowEpochMs, 'Tournament server clock');
    const until = Math.min(nowEpochMs, state.endsAtEpochMs);
    let next = state;
    for (let index = 0; index < MAX_STEPS_PER_ATTEMPT && next.simulatedAtEpochMs + STEP_MS <= until; index++) {
        next = stepTournamentArena(next, next.simulatedAtEpochMs + STEP_MS);
    }
    return next;
}

export function decodeTournamentArenaInput(value: unknown): TournamentArenaInput {
    const input = requireRecord(value, 'Tournament controls');
    requireExactKeys(input, ['sequence', 'yaw', 'pitch', 'controls'], 'Tournament controls');
    requireEpoch(input.sequence, 'Tournament input sequence');
    if (
        input.sequence === 0 || typeof input.yaw !== 'number' || !Number.isFinite(input.yaw) ||
        Math.abs(input.yaw) > Math.PI * 2
    ) {
        throw new TypeError('Tournament input sequence or aim is invalid');
    }
    if (typeof input.pitch !== 'number' || !Number.isFinite(input.pitch) || Math.abs(input.pitch) > Math.PI / 2) {
        throw new TypeError('Tournament aim pitch is invalid');
    }
    return {
        sequence: input.sequence,
        yaw: input.yaw,
        pitch: input.pitch,
        controls: decodeTournamentControls(input.controls)
    };
}

function decodeTournamentControls(value: unknown): PlayerInputState {
    const controls = requireRecord(value, 'Tournament movement');
    requireExactKeys(controls, Object.keys(EMPTY_INPUT), 'Tournament movement');
    if (
        typeof controls.moveX !== 'number' || !Number.isFinite(controls.moveX) || Math.abs(controls.moveX) > 1 ||
        typeof controls.moveZ !== 'number' || !Number.isFinite(controls.moveZ) || Math.abs(controls.moveZ) > 1 ||
        typeof controls.sprint !== 'boolean' || typeof controls.dash !== 'boolean' ||
        typeof controls.slide !== 'boolean' || typeof controls.jump !== 'boolean' ||
        typeof controls.fire !== 'boolean' || typeof controls.altFire !== 'boolean' ||
        typeof controls.overdrive !== 'boolean' || typeof controls.pause !== 'boolean'
    ) {
        throw new TypeError('Tournament movement or buttons are invalid');
    }
    return {
        moveX: controls.moveX,
        moveZ: controls.moveZ,
        sprint: controls.sprint,
        dash: controls.dash,
        slide: controls.slide,
        jump: controls.jump,
        fire: controls.fire,
        altFire: controls.altFire,
        overdrive: controls.overdrive,
        pause: controls.pause
    };
}

function stepTournamentArena(state: TournamentArena, nowEpochMs: number): TournamentArena {
    if (nowEpochMs >= state.endsAtEpochMs) {
        return {
            ...state,
            arena: finishArenaMatchIfDue(state.arena, state.endsAtEpochMs),
            simulatedAtEpochMs: state.endsAtEpochMs
        };
    }
    const respawned = respawnArenaPlayers(state.arena, nowEpochMs);
    const present = respawned === state.arena ? state.players : synchronizeTournamentPlayers(state.players, respawned);
    let players = present.map((player) => moveTournamentPlayer(player, respawned, nowEpochMs));
    let arena: ArenaSimulationState = {
        ...stepArenaTargets(respawned, STEP_MS, nowEpochMs),
        players: players.map(toArenaPlayer)
    };
    for (const principalId of players.map((player) => player.principalId)) {
        const player = players.find((candidate) => candidate.principalId === principalId)!;
        const shooting = fireTournamentShot(arena, player, nowEpochMs);
        arena = shooting.arena;
        players = players.map((candidate) => candidate.principalId === principalId ? shooting.player : candidate);
        players = synchronizeTournamentPlayers(players, arena);
    }
    for (const player of players) {
        const pickup = findPickupNearPlayer(arena, player.principalId, nowEpochMs);
        if (pickup === undefined) {
            continue;
        }
        const collected = resolvePickupIntent(arena, {
            pickupId: pickup.id,
            sessionId: player.principalId,
            position: player.simulation.position,
            seq: player.input.sequence,
            sentAtEpochMs: nowEpochMs
        }, nowEpochMs);
        if (collected.accepted) {
            arena = collected.state;
        }
    }
    arena = stepArenaDirectorState(arena, nowEpochMs);
    return { ...state, arena, players: synchronizeTournamentPlayers(players, arena), simulatedAtEpochMs: nowEpochMs };
}

function synchronizeTournamentPlayers(
    players: readonly TournamentArenaPlayer[],
    arena: ArenaSimulationState
): TournamentArenaPlayer[] {
    return players.map((player) => {
        const authoritative = arena.players.find((entry) => entry.sessionId === player.principalId)!;
        return {
            ...player,
            simulation: {
                ...player.simulation,
                position: authoritative.position,
                vitals: authoritative.vitals,
                loadout: authoritative.loadout
            }
        };
    });
}

function moveTournamentPlayer(
    player: TournamentArenaPlayer,
    arena: ArenaSimulationState,
    nowEpochMs: number
): TournamentArenaPlayer {
    const live = nowEpochMs - player.inputAtEpochMs <= INPUT_LIFETIME_MS;
    const controls = live ? { ...player.input.controls, pause: false } : EMPTY_INPUT;
    return {
        ...player,
        simulation: stepLocalPlayer({
            player: { ...player.simulation, yaw: player.input.yaw, pitch: player.input.pitch },
            input: controls,
            dtMs: STEP_MS,
            nowEpochMs,
            arenaHalfSize: arena.layout.halfSize
        })
    };
}

interface TournamentShotResolution {
    readonly arena: ArenaSimulationState;
    readonly player: TournamentArenaPlayer;
}

function fireTournamentShot(
    arena: ArenaSimulationState,
    player: TournamentArenaPlayer,
    nowEpochMs: number
): TournamentShotResolution {
    const { simulation, input } = player;
    if (
        !input.controls.fire || nowEpochMs - player.inputAtEpochMs > INPUT_LIFETIME_MS ||
        simulation.vitals.health <= 0 || nowEpochMs < simulation.combat.shotReadyAtEpochMs
    ) {
        return { arena, player };
    }
    const shot: ShotIntent = {
        sessionId: player.principalId,
        username: player.principalId,
        color: '#00e5ff',
        origin: simulation.position,
        direction: forwardFromAngles(simulation.yaw, simulation.pitch),
        weaponKind: simulation.loadout.weaponKind,
        charged: input.controls.altFire,
        overdrive: input.controls.overdrive,
        seq: input.sequence,
        sentAtEpochMs: nowEpochMs
    };
    const resolution = resolveShot({ state: arena, combat: simulation.combat, shot, nowEpochMs });
    const updated = { ...player, simulation: { ...simulation, combat: resolution.combat } };
    let next: ArenaSimulationState = {
        ...resolution.state,
        players: resolution.state.players.map((entry) =>
            entry.sessionId === player.principalId ? toArenaPlayer(updated) : entry
        )
    };
    const opponent = next.players.find((entry) => entry.sessionId !== player.principalId)!;
    const hit = resolvePlayerHitIntent(next, {
        shot,
        targetSessionId: opponent.sessionId,
        predictedImpact: opponent.position,
        sentAtEpochMs: nowEpochMs
    }, nowEpochMs);
    if (hit.accepted) {
        next = hit.state;
    }
    return { arena: next, player: updated };
}

function toArenaPlayer(player: TournamentArenaPlayer): PlayerArenaState {
    const { simulation, principalId } = player;
    return {
        sessionId: principalId,
        username: principalId,
        color: '#00e5ff',
        score: simulation.combat.score,
        position: simulation.position,
        rotation: [simulation.pitch, simulation.yaw, 0],
        vitals: simulation.vitals,
        loadout: simulation.loadout,
        seq: player.input.sequence,
        updatedAtEpochMs: player.inputAtEpochMs
    };
}
