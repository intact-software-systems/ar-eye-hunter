import { defaultRelicCharacterId, findRelicCharacter } from './characters.ts';
import type { RelicGameState, RelicPlayer } from './model.ts';
import { appendRelicEvent } from './to-relic-event.ts';

export interface RelicPlayerAdmission {
    readonly state: RelicGameState;
    readonly playerId: string;
    readonly username: string;
    readonly now: number;
    readonly characterId: RelicPlayer['characterId'] | undefined;
}

export interface RelicPlayerAdmissionResult {
    readonly state: RelicGameState;
    readonly player: RelicPlayer;
}

interface RelicJoinedPlayerRefresh {
    readonly state: RelicGameState;
    readonly existing: RelicPlayer;
    readonly username: string;
    readonly characterId: RelicPlayer['characterId'] | undefined;
}

export function admitRelicHunter(
    { state, playerId, username, now, characterId }: RelicPlayerAdmission
): RelicPlayerAdmissionResult {
    const existing = state.players.find((player) => player.playerId === playerId);
    if (existing) {
        const player = refreshJoinedPlayer({ state, existing, username, characterId });
        return {
            state: {
                ...state,
                players: state.players.map((candidate) => candidate.playerId === player.playerId ? player : candidate)
            },
            player
        };
    }

    const nextCharacterId = characterId ?? defaultRelicCharacterId(state.players.length);
    const player: RelicPlayer = {
        playerId,
        username,
        characterId: nextCharacterId,
        roomId: 'entrance',
        health: startingHealth(nextCharacterId),
        escaped: false,
        defeated: false,
        score: 0,
        relicIds: []
    };

    return {
        state: {
            ...state,
            adminPlayerId: state.players.length === 0 ? state.adminPlayerId ?? playerId : state.adminPlayerId,
            players: [...state.players, player],
            events: appendRelicEvent({
                state,
                message: `${username} joined as ${findRelicCharacter(player.characterId).name}.`,
                now,
                options: {
                    type: 'player_joined',
                    tone: 'success'
                }
            })
        },
        player
    };
}

function refreshJoinedPlayer({ state, existing, username, characterId }: RelicJoinedPlayerRefresh): RelicPlayer {
    if (existing.username === username && !characterId) {
        return existing;
    }
    const nextCharacterId = state.phase === 'lobby' && characterId ? characterId : existing.characterId;
    return {
        ...existing,
        username,
        characterId: nextCharacterId,
        health: state.phase === 'lobby' && characterId ? startingHealth(nextCharacterId) : existing.health
    };
}

export function startRelicExpedition(state: RelicGameState, player: RelicPlayer, now: number): RelicGameState {
    const starting = state.phase === 'lobby';
    return {
        ...state,
        phase: starting ? 'planning' : state.phase,
        roundStartedAtEpochMs: starting ? now : state.roundStartedAtEpochMs,
        events: appendRelicEvent({
            state,
            message: `${player.username} started the expedition.`,
            now,
            options: {
                type: 'round_started',
                tone: 'success'
            }
        }),
        updatedAtEpochMs: now
    };
}

function startingHealth(characterId: RelicPlayer['characterId']): number {
    return 3 + (findRelicCharacter(characterId).healthBonus ?? 0);
}
