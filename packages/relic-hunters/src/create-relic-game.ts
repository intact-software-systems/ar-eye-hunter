import { Either } from '@shared/resilience/Either.ts';
import {
    relicsFromRelicExpeditionBlueprint,
    roomsFromRelicExpeditionBlueprint,
    validateRelicExpeditionBlueprint,
    type RelicExpeditionBlueprint
} from './expedition-blueprint.ts';
import type { RelicExpeditionSetupMetadata, RelicGameState, RelicRoom, RelicRuleRefusal } from './model.ts';
import { RELIC_PROTOCOL_VERSION } from './protocol.ts';
import { toRelicEvent } from './to-relic-event.ts';

export interface CreateRelicGameFromBlueprintInput {
    readonly gameId: string;
    readonly roomId: string;
    readonly blueprint: RelicExpeditionBlueprint;
    readonly now: number;
    readonly setup?: Partial<RelicExpeditionSetupMetadata>;
}

interface RelicGameCreation {
    readonly gameId: string;
    readonly roomId: string;
    readonly now: number;
    readonly map: readonly RelicRoom[];
    readonly relics: readonly RelicGameState['relics'][number][];
    readonly setup: RelicExpeditionSetupMetadata;
}

const MAX_ROUNDS = 10;

export const RELIC_MVP_MAP: readonly RelicRoom[] = [
    { id: 'entrance', name: 'Entrance', kind: 'entrance', x: 0, z: -6, neighbors: ['hallway', 'storage'] },
    { id: 'hallway', name: 'Hallway', kind: 'hallway', x: 0, z: -3, neighbors: ['entrance', 'shrine', 'trap'] },
    { id: 'storage', name: 'Storage', kind: 'storage', x: -4, z: -3, neighbors: ['entrance', 'trap'] },
    { id: 'shrine', name: 'Shrine', kind: 'shrine', x: 4, z: -3, neighbors: ['hallway', 'treasure'] },
    {
        id: 'trap',
        name: 'Trap Room',
        kind: 'trap',
        x: 0,
        z: 0,
        neighbors: ['hallway', 'storage', 'treasure', 'monster']
    },
    { id: 'treasure', name: 'Treasure Chamber', kind: 'treasure', x: 4, z: 0, neighbors: ['shrine', 'trap'] },
    { id: 'monster', name: 'Monster Lair', kind: 'monster', x: 0, z: 3, neighbors: ['trap', 'exit'] },
    { id: 'exit', name: 'Exit', kind: 'exit', x: 0, z: 6, neighbors: ['monster'] }
];

export const RELIC_MVP_RELICS = [
    // Entrance and Exit — visible neon freebies so every room has something worth touching.
    { id: 'visitor-badge', name: 'Visitor Badge of Questionable Consent', value: 1, roomId: 'entrance' },
    { id: 'gift-shop-receipt', name: 'Gift Shop Exit Receipt', value: 2, roomId: 'exit' },
    // Treasure Chamber — three prizes of descending value
    { id: 'golden-idol', name: 'Golden Idol', value: 5, roomId: 'treasure' },
    { id: 'jade-dragon', name: 'Jade Dragon', value: 3, roomId: 'treasure' },
    { id: 'pearl-netsuke', name: 'Pearl Netsuke', value: 2, roomId: 'treasure' },
    // Shrine — two sacred artefacts
    { id: 'oracle-stone', name: 'Oracle Stone', value: 4, roomId: 'shrine' },
    { id: 'moonstone', name: 'Moonstone Pendant', value: 3, roomId: 'shrine' },
    // Storage — hidden cache, second piece buried deeper
    { id: 'sun-disk', name: 'Sun Disk', value: 6, roomId: 'storage' },
    { id: 'bronze-mirror', name: 'Bronze Mirror', value: 3, roomId: 'storage' },
    // Monster Lair — great risk, two rewards
    { id: 'cursed-mask', name: 'Cursed Mask', value: 8, roomId: 'monster' },
    { id: 'bone-seal', name: 'Bone Seal', value: 4, roomId: 'monster' },
    // Trap Room — two relics worth braving the spikes
    { id: 'serpent-crown', name: 'Serpent Crown', value: 7, roomId: 'trap' },
    { id: 'rusted-tanto', name: 'Rusted Tantō', value: 3, roomId: 'trap' },
    // Hallway — scattered find for sharp-eyed hunters
    { id: 'copper-coin', name: 'Copper Coin', value: 2, roomId: 'hallway' }
] as const;

export function createRelicGame(
    gameId: string,
    roomId: string,
    now: number
): RelicGameState {
    return createRelicGameState({
        gameId,
        roomId,
        now,
        map: RELIC_MVP_MAP,
        relics: RELIC_MVP_RELICS,
        setup: {
            schemaVersion: 1,
            source: 'default',
            seed: 'relic-static-v1',
            theme: 'Castle of Yamashiro',
            blueprintId: 'relic-static-v1'
        }
    });
}

export function createRelicGameFromBlueprint(
    { gameId, roomId, blueprint, now, setup }: CreateRelicGameFromBlueprintInput
): Either<RelicRuleRefusal, RelicGameState> {
    const validation = validateRelicExpeditionBlueprint(blueprint);
    if (!validation.ok) {
        return Either.ofLeft({
            code: 'invalid-expedition-blueprint',
            message: `Invalid Relic expedition blueprint: ${validation.errors.join('; ')}`
        });
    }
    return Either.ofRight(createRelicGameState({
        gameId,
        roomId,
        now,
        map: roomsFromRelicExpeditionBlueprint(blueprint),
        relics: relicsFromRelicExpeditionBlueprint(blueprint),
        setup: {
            schemaVersion: 1,
            source: setup?.source ?? blueprint.source ?? 'procedural',
            seed: setup?.seed ?? blueprint.seed,
            theme: setup?.theme ?? blueprint.theme,
            blueprintId: setup?.blueprintId
        }
    }));
}

function createRelicGameState({
    gameId,
    roomId,
    now,
    map,
    relics,
    setup
}: RelicGameCreation): RelicGameState {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        gameId,
        roomId,
        phase: 'lobby',
        round: 1,
        maxRounds: MAX_ROUNDS,
        createdAtEpochMs: now,
        updatedAtEpochMs: now,
        adminPlayerId: undefined,
        roundTimeLimitMs: 60_000,
        roundStartedAtEpochMs: undefined,
        map,
        relics,
        roomInvestigations: [],
        players: [],
        pendingActions: [],
        events: [
            toRelicEvent({
                round: 1,
                message: 'The expedition is waiting for hunters.',
                now,
                options: {
                    type: 'game_waiting',
                    tone: 'mystery'
                }
            })
        ],
        winnerIds: [],
        setup
    };
}
