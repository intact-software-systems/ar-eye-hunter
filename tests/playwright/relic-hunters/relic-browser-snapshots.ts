import type {
    RelicDefinition,
    RelicEvent,
    RelicGamePhase,
    RelicPlayer,
    RelicPublicSnapshot,
    RelicRoom,
    RelicRoomInvestigation
} from '../../../packages/relic-hunters/mod.ts';

interface RelicSnapshotFixtureOptions {
    readonly carryRelic?: boolean;
    readonly includeStorage?: boolean;
    readonly includeExit?: boolean;
    readonly playerRoomId?: string;
    readonly playerRooms?: Readonly<Record<string, string>>;
    readonly playerRelicIds?: Readonly<Record<string, readonly string[]>>;
    readonly playerScores?: Readonly<Record<string, number>>;
    readonly roomInvestigations?: readonly RelicRoomInvestigation[];
    readonly events?: readonly RelicEvent[];
    readonly submittedPlayerIds?: readonly string[];
    readonly includeFullMap?: boolean;
    readonly round?: number;
    readonly roundStartedAtEpochMs?: number;
    readonly roundTimeLimitMs?: number;
}

const fixtureRooms = {
    entrance: {
        id: 'entrance',
        name: 'Entrance',
        kind: 'entrance',
        x: 0,
        z: -6,
        neighbors: ['hallway', 'storage']
    },
    hallway: {
        id: 'hallway',
        name: 'Hallway',
        kind: 'hallway',
        x: 0,
        z: -3,
        neighbors: ['entrance', 'shrine', 'monster']
    },
    storage: {
        id: 'storage',
        name: 'Storage',
        kind: 'storage',
        x: -4,
        z: -3,
        neighbors: ['entrance', 'trap']
    },
    trap: {
        id: 'trap',
        name: 'Trap Room',
        kind: 'trap',
        x: -4,
        z: 0,
        neighbors: ['storage', 'shrine']
    },
    shrine: {
        id: 'shrine',
        name: 'Shrine',
        kind: 'shrine',
        x: 0,
        z: 0,
        neighbors: ['hallway', 'trap', 'treasure', 'exit']
    },
    monster: {
        id: 'monster',
        name: 'Monster',
        kind: 'monster',
        x: 4,
        z: -3,
        neighbors: ['hallway', 'treasure']
    },
    treasure: {
        id: 'treasure',
        name: 'Treasure',
        kind: 'treasure',
        x: 4,
        z: 0,
        neighbors: ['monster', 'shrine']
    },
    exit: {
        id: 'exit',
        name: 'Exit',
        kind: 'exit',
        x: 0,
        z: 3,
        neighbors: ['shrine']
    }
} satisfies Readonly<Record<string, RelicRoom>>;
const entranceSearchEvents: readonly RelicEvent[] = [
    {
        id: 'turn-1-reveal',
        round: 1,
        type: 'action_revealed',
        message: 'Round 1 actions are revealed.',
        tone: 'mystery',
        createdAtEpochMs: 1
    },
    {
        id: 'turn-1-search',
        round: 1,
        type: 'player_searched',
        message: 'Alice searched the Entrance.',
        animationCue: {
            type: 'search_altar',
            playerId: 'alice-session',
            roomId: 'entrance',
            durationMs: 700,
            intensity: 'low'
        },
        tone: 'mystery',
        createdAtEpochMs: 1
    },
    {
        id: 'turn-1-round-2',
        round: 1,
        type: 'round_started',
        message: 'Round 2 begins.',
        tone: 'mystery',
        createdAtEpochMs: 1
    }
];
const storageInvestigations: readonly RelicRoomInvestigation[] = [
    {
        roomId: 'storage',
        searchedByPlayerId: 'alice-session',
        searchedByUsername: 'Alice',
        searchedAtRound: 1,
        searchedAtEpochMs: 1,
        result: 'empty',
        summary: 'The crates held a torn supply map, but no relic.',
        hint: 'The supply marks point back toward the Entrance and onward through the Trap Room.',
        effect: 'map-fragment',
        revealedRoomId: 'trap'
    }
];
const storageSearchEvents: readonly RelicEvent[] = [
    {
        id: 'event-reveal-1',
        round: 1,
        type: 'action_revealed',
        message: 'Round 1 actions are revealed.',
        animationCue: {
            type: 'noise_pulse',
            durationMs: 620,
            intensity: 'low'
        },
        tone: 'mystery',
        createdAtEpochMs: 1
    },
    {
        id: 'event-search-1',
        round: 1,
        type: 'player_searched',
        message: 'Alice searched the crates and marked a false supply trail.',
        animationCue: {
            type: 'search_altar',
            playerId: 'alice-session',
            roomId: 'storage',
            durationMs: 700,
            intensity: 'low'
        },
        tone: 'mystery',
        createdAtEpochMs: 1
    },
    {
        id: 'event-noise-1',
        round: 1,
        type: 'noise_pulse',
        message: 'The ruin hears 2 noise.',
        animationCue: {
            type: 'noise_pulse',
            durationMs: 900,
            intensity: 'low'
        },
        tone: 'mystery',
        createdAtEpochMs: 1
    },
    {
        id: 'event-round-2',
        round: 1,
        type: 'round_started',
        message: 'Round 2 begins.',
        tone: 'mystery',
        createdAtEpochMs: 1
    }
];
const finishedExpeditionEvents: readonly RelicEvent[] = [
    {
        id: 'turn-final-escape',
        round: 3,
        type: 'player_escaped',
        message: 'Alice escaped with the Golden Idol.',
        tone: 'success',
        createdAtEpochMs: 1
    },
    {
        id: 'turn-final-finished',
        round: 3,
        type: 'game_finished',
        message: 'The expedition is over.',
        tone: 'success',
        createdAtEpochMs: 1
    }
];
export function createRelicSnapshotWithPlayers(
    playerCount: 1 | 2 | 4,
    phase: RelicGamePhase = 'lobby',
    options: RelicSnapshotFixtureOptions = {}
): RelicPublicSnapshot {
    return {
        protocolVersion: 1,
        gameId: 'room-1',
        roomId: 'room-1',
        phase,
        round: options.round ?? 1,
        maxRounds: 10,
        createdAtEpochMs: 1,
        updatedAtEpochMs: Date.now(),
        roundTimeLimitMs: options.roundTimeLimitMs ?? 180_000,
        roundStartedAtEpochMs: options.roundStartedAtEpochMs,
        map: createFixtureMap(options),
        relics: createFixtureRelics(options),
        roomInvestigations: options.roomInvestigations ?? [],
        players: createFixturePlayers(playerCount, options),
        submittedPlayerIds: options.submittedPlayerIds ?? [],
        events: options.events ?? [],
        winnerIds: []
    };
}

export function createEmptyRelicSnapshot(): RelicPublicSnapshot {
    return {
        ...createRelicSnapshotWithPlayers(1),
        players: [],
        submittedPlayerIds: [],
        events: []
    };
}

export function createResolvedSearchSnapshot(): RelicPublicSnapshot {
    return createRelicSnapshotWithPlayers(1, 'planning', {
        round: 2,
        events: entranceSearchEvents
    });
}

export function createResolvedStorageSearchSnapshot(): RelicPublicSnapshot {
    return createRelicSnapshotWithPlayers(1, 'planning', {
        includeStorage: true,
        playerRoomId: 'storage',
        roomInvestigations: storageInvestigations,
        events: storageSearchEvents,
        round: 2
    });
}

export function createReviewStorageSearchSnapshot(): RelicPublicSnapshot {
    return createRelicSnapshotWithPlayers(1, 'review', {
        includeStorage: true,
        playerRoomId: 'storage',
        roomInvestigations: storageInvestigations,
        events: storageSearchEvents.slice(0, 3),
        submittedPlayerIds: []
    });
}

export function createContinuedStoragePlanningSnapshot(): RelicPublicSnapshot {
    const review = createReviewStorageSearchSnapshot();
    return {
        ...review,
        phase: 'planning',
        round: 2,
        roundStartedAtEpochMs: Date.now(),
        events: [
            ...review.events,
            {
                id: 'event-round-2',
                round: 1,
                type: 'round_started',
                message: 'Round 2 begins.',
                tone: 'mystery',
                createdAtEpochMs: Date.now()
            }
        ]
    };
}

export function createFinishedRelicSnapshot(): RelicPublicSnapshot {
    const base = createRelicSnapshotWithPlayers(2, 'planning', {
        carryRelic: true,
        includeExit: true,
        playerRoomId: 'exit',
        playerScores: {
            'alice-session': 5,
            'bob-session': 1
        },
        events: finishedExpeditionEvents,
        round: 3
    });

    return {
        ...base,
        phase: 'finished',
        winnerIds: ['alice-session'],
        submittedPlayerIds: [],
        players: base.players.map((player) =>
            player.playerId === 'alice-session'
                ? { ...player, escaped: true, score: 5, relicIds: [] }
                : player
        ),
        relics: base.relics.map((relic) =>
            relic.id === 'golden-idol'
                ? {
                    ...relic,
                    carriedBy: undefined,
                    escapedBy: 'alice-session'
                }
                : relic
        )
    };
}

function createFixturePlayers(playerCount: number, options: RelicSnapshotFixtureOptions): readonly RelicPlayer[] {
    const playerSpecs = [
        ['alice-session', 'Alice', 'kael-ironstride'],
        ['bob-session', 'Bob', 'nyra-vale'],
        ['cara-session', 'Cara', 'oryn-starcoil'],
        ['dain-session', 'Dain', 'vessa-thornlock']
    ] as const;
    return playerSpecs.slice(0, playerCount).map(([playerId, username, characterId]) => {
        const relicIds = options.playerRelicIds?.[playerId] ??
            (options.carryRelic && playerId === 'alice-session' ? ['golden-idol'] : []);
        return {
            playerId,
            username,
            characterId,
            roomId: options.playerRooms?.[playerId] ?? options.playerRoomId ?? 'entrance',
            health: 3,
            escaped: false,
            defeated: false,
            score: options.playerScores?.[playerId] ?? 0,
            relicIds
        };
    });
}

function createFixtureRelics(options: RelicSnapshotFixtureOptions): readonly RelicDefinition[] {
    return [
        ...(options.carryRelic
            ? [
                {
                    id: 'golden-idol',
                    name: 'Golden Idol',
                    value: 5,
                    roomId: 'treasure',
                    foundBy: 'alice-session',
                    carriedBy: 'alice-session'
                }
            ]
            : []),
        ...Object.entries(options.playerRelicIds ?? {}).flatMap(([playerId, relicIds]) =>
            relicIds.map((relicId, index) => ({
                id: relicId,
                name: relicId === 'sun-disk' ? 'Sun Disk' : `Relic ${index + 1}`,
                value: relicId === 'sun-disk' ? 6 : 4,
                roomId: options.playerRooms?.[playerId] ?? options.playerRoomId ?? 'entrance',
                foundBy: playerId,
                carriedBy: playerId
            }))
        )
    ];
}

function createFixtureMap(options: RelicSnapshotFixtureOptions): readonly RelicRoom[] {
    if (options.includeFullMap) {
        return Object.values(fixtureRooms);
    }
    const rooms: RelicRoom[] = [
        { ...fixtureRooms.entrance, neighbors: options.includeStorage ? ['hallway', 'storage'] : ['hallway'] },
        { ...fixtureRooms.hallway, neighbors: options.includeExit ? ['entrance', 'exit'] : ['entrance'] }
    ];
    if (options.includeExit) {
        rooms.push({ ...fixtureRooms.exit, z: 0, neighbors: ['hallway'] });
    }
    if (options.includeStorage) {
        rooms.push(fixtureRooms.storage, { ...fixtureRooms.trap, neighbors: ['storage'] });
    }
    return rooms;
}
