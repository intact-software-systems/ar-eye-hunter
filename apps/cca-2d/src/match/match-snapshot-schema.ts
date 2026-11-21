import { TOWN_MATCH_MAX_TICKS } from './match-extension.ts';

export const MATCH_SNAPSHOT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        matchId: {
            type: 'string',
            minLength: 1,
            maxLength: 128
        },
        phase: {
            enum: [
                'lobby',
                'countdown',
                'playing',
                'finished',
                'interrupted'
            ]
        },
        tick: {
            type: 'integer',
            minimum: 0,
            maximum: TOWN_MATCH_MAX_TICKS
        },
        countdownTicks: {
            type: 'integer',
            minimum: 0,
            maximum: 90
        },
        remainingTicks: {
            type: 'integer',
            minimum: 0,
            maximum: TOWN_MATCH_MAX_TICKS
        },
        members: {
            type: 'array',
            items: {
                $ref: '#/$defs/member'
            },
            maxItems: 4
        },
        participants: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'displayName'],
                properties: {
                    id: { type: 'string', minLength: 1, maxLength: 128 },
                    displayName: { type: 'string', minLength: 1, maxLength: 128 }
                }
            },
            maxItems: 4
        },
        seats: {
            type: 'array',
            maxItems: 4,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'sessionId', 'status', 'expiresAtEpochMs'],
                properties: {
                    id: { type: 'string', minLength: 1, maxLength: 128 },
                    sessionId: { type: 'string', minLength: 1, maxLength: 128 },
                    status: { enum: ['active', 'away', 'observer'] },
                    expiresAtEpochMs: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
                }
            }
        },
        players: {
            type: 'array',
            items: {
                $ref: '#/$defs/player'
            },
            maxItems: 4
        },
        town: {
            $ref: '#/$defs/town'
        },
        results: {
            type: 'array',
            items: {
                $ref: '#/$defs/result'
            },
            maxItems: 4
        },
        interruption: {
            type: 'string',
            maxLength: 512
        }
    },
    required: [
        'matchId',
        'phase',
        'tick',
        'countdownTicks',
        'remainingTicks',
        'members',
        'participants',
        'seats',
        'players',
        'town',
        'results'
    ],
    $defs: {
        point: {
            type: 'object',
            additionalProperties: false,
            properties: {
                x: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                z: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                }
            },
            required: [
                'x',
                'z'
            ]
        },
        cloud: {
            type: 'object',
            additionalProperties: false,
            properties: {
                x: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                z: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                id: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                age: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                }
            },
            required: [
                'x',
                'z',
                'id',
                'age'
            ]
        },
        member: {
            type: 'object',
            additionalProperties: false,
            properties: {
                id: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 128
                },
                sessionId: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 128
                },
                displayName: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 128
                },
                ready: {
                    type: 'boolean'
                }
            },
            required: [
                'id',
                'sessionId',
                'displayName',
                'ready'
            ]
        },
        player: {
            type: 'object',
            additionalProperties: false,
            properties: {
                x: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                z: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                stain: {
                    enum: [
                        'clean',
                        'poop',
                        'pee',
                        'puke'
                    ]
                },
                stainedUntil: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                messImmuneUntil: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                frozenUntil: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                shieldUntil: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                facingX: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                facingZ: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                dashTime: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                dizzyUntil: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                immuneUntil: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                sickAt: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                power: {
                    enum: [
                        'fart',
                        'powder',
                        'zapper',
                        'poop-bomb'
                    ]
                },
                id: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 128
                },
                dash: {
                    type: 'boolean'
                },
                score: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                rescues: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                consumedDash: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                slips: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                pranks: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                rescueTarget: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 128
                },
                rescueProgress: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                vx: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                vz: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                elapsed: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                cooldown: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                rewardedThisRaid: {
                    type: 'boolean'
                },
                slipping: {
                    type: 'boolean'
                },
                clouds: {
                    type: 'array',
                    items: {
                        $ref: '#/$defs/cloud'
                    },
                    maxItems: 16
                }
            },
            required: [
                'x',
                'z',
                'stain',
                'stainedUntil',
                'messImmuneUntil',
                'frozenUntil',
                'shieldUntil',
                'facingX',
                'facingZ',
                'dashTime',
                'dizzyUntil',
                'immuneUntil',
                'sickAt',
                'power',
                'id',
                'dash',
                'score',
                'rescues',
                'consumedDash',
                'slips',
                'pranks',
                'rescueProgress',
                'vx',
                'vz',
                'elapsed',
                'cooldown',
                'rewardedThisRaid',
                'slipping',
                'clouds'
            ]
        },
        result: {
            type: 'object',
            additionalProperties: false,
            properties: {
                id: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 128
                },
                displayName: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 128
                },
                score: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                rescues: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                qualified: {
                    type: 'boolean'
                }
            },
            required: [
                'id',
                'displayName',
                'score',
                'rescues',
                'qualified'
            ]
        },
        shop: {
            type: 'object',
            additionalProperties: false,
            properties: {
                id: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 128
                },
                tipped: {
                    type: 'boolean'
                },
                pickupAt: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                rewardAt: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                }
            },
            required: [
                'id',
                'tipped',
                'pickupAt',
                'rewardAt'
            ]
        },
        npc: {
            type: 'object',
            additionalProperties: false,
            properties: {
                x: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                z: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                stain: {
                    enum: [
                        'clean',
                        'poop',
                        'pee',
                        'puke'
                    ]
                },
                stainedUntil: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                messImmuneUntil: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                targetId: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 128
                },
                chaseUntil: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                lastSeenAt: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                zapAt: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                until: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                cleanAt: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                dizzyUntil: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                miniUntil: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                sickAt: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                immuneUntil: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                shopId: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 128
                },
                mode: {
                    enum: [
                        'watching',
                        'chasing',
                        'warning',
                        'cleaning'
                    ]
                },
                aim: {
                    $ref: '#/$defs/point'
                }
            },
            required: [
                'x',
                'z',
                'stain',
                'stainedUntil',
                'messImmuneUntil',
                'chaseUntil',
                'lastSeenAt',
                'zapAt',
                'until',
                'cleanAt',
                'dizzyUntil',
                'miniUntil',
                'sickAt',
                'immuneUntil',
                'shopId',
                'mode',
                'aim'
            ]
        },
        fruit: {
            type: 'object',
            additionalProperties: false,
            properties: {
                x: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                z: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                id: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                shopId: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 128
                },
                vx: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                vz: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                born: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                }
            },
            required: [
                'x',
                'z',
                'id',
                'shopId',
                'vx',
                'vz',
                'born'
            ]
        },
        patch: {
            type: 'object',
            additionalProperties: false,
            properties: {
                x: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                z: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                id: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                kind: {
                    enum: [
                        'powder',
                        'puke',
                        'poop',
                        'pee',
                        'trash',
                        'fish',
                        'water'
                    ]
                },
                born: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                expires: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                }
            },
            required: [
                'x',
                'z',
                'id',
                'kind',
                'born',
                'expires'
            ]
        },
        zap: {
            type: 'object',
            additionalProperties: false,
            properties: {
                x: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                z: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                id: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                target: {
                    $ref: '#/$defs/point'
                },
                expires: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                }
            },
            required: [
                'x',
                'z',
                'id',
                'target',
                'expires'
            ]
        },
        guard: {
            type: 'object',
            additionalProperties: false,
            properties: {
                x: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                z: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                stain: {
                    enum: [
                        'clean',
                        'poop',
                        'pee',
                        'puke'
                    ]
                },
                stainedUntil: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                messImmuneUntil: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                id: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                mode: {
                    enum: [
                        'emerging',
                        'patrol',
                        'warning',
                        'cooldown'
                    ]
                },
                target: {
                    type: 'string',
                    maxLength: 128
                },
                aim: {
                    $ref: '#/$defs/point'
                },
                until: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                }
            },
            required: [
                'x',
                'z',
                'stain',
                'stainedUntil',
                'messImmuneUntil',
                'id',
                'mode',
                'target',
                'aim',
                'until'
            ]
        },
        raid: {
            type: 'object',
            additionalProperties: false,
            properties: {
                bonuses: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                rewarded: {
                    type: 'boolean'
                },
                phase: {
                    enum: [
                        'quiet',
                        'alarm',
                        'active',
                        'returning',
                        'cooldown'
                    ]
                },
                until: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                guards: {
                    type: 'array',
                    items: {
                        $ref: '#/$defs/guard'
                    },
                    maxItems: 10
                }
            },
            required: [
                'bonuses',
                'rewarded',
                'phase',
                'until',
                'guards'
            ]
        },
        fountain: {
            type: 'object',
            additionalProperties: false,
            properties: {
                broken: {
                    type: 'boolean'
                },
                since: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                repair: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                rewardAt: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                }
            },
            required: [
                'broken',
                'since',
                'repair',
                'rewardAt'
            ]
        },
        cart: {
            type: 'object',
            additionalProperties: false,
            properties: {
                x: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                z: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                loose: {
                    type: 'boolean'
                },
                since: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                repair: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                rewardAt: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                }
            },
            required: [
                'x',
                'z',
                'loose',
                'since',
                'repair',
                'rewardAt'
            ]
        },
        object: {
            type: 'object',
            additionalProperties: false,
            properties: {
                x: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                z: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                width: {
                    type: 'number',
                    exclusiveMinimum: 0,
                    maximum: 48
                },
                depth: {
                    type: 'number',
                    exclusiveMinimum: 0,
                    maximum: 48
                },
                id: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 128
                },
                owner: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 128
                },
                kind: {
                    enum: [
                        'bin',
                        'fish',
                        'toilet',
                        'hydrant'
                    ]
                },
                damagedUntil: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                rewardAt: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                repair: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                disturbedAt: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                }
            },
            required: [
                'x',
                'z',
                'width',
                'depth',
                'id',
                'owner',
                'kind',
                'damagedUntil',
                'rewardAt',
                'repair',
                'disturbedAt'
            ]
        },
        creature: {
            type: 'object',
            additionalProperties: false,
            properties: {
                x: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                z: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                id: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                kind: {
                    enum: [
                        'bird',
                        'dog',
                        'cat'
                    ]
                },
                home: {
                    $ref: '#/$defs/point'
                },
                mode: {
                    enum: [
                        'roaming',
                        'chasing',
                        'warning',
                        'recovering'
                    ]
                },
                until: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                angryUntil: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                provokedUntil: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                rewardAt: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                provokerId: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 128
                },
                aim: {
                    $ref: '#/$defs/point'
                },
                attacks: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                }
            },
            required: [
                'x',
                'z',
                'id',
                'kind',
                'home',
                'mode',
                'until',
                'angryUntil',
                'provokedUntil',
                'rewardAt',
                'aim',
                'attacks'
            ]
        },
        obstacle: {
            type: 'object',
            additionalProperties: false,
            properties: {
                x: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                z: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                width: {
                    type: 'number',
                    exclusiveMinimum: 0,
                    maximum: 48
                },
                depth: {
                    type: 'number',
                    exclusiveMinimum: 0,
                    maximum: 48
                }
            },
            required: [
                'x',
                'z',
                'width',
                'depth'
            ]
        },
        personality: {
            type: 'object',
            additionalProperties: false,
            properties: {
                x: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                z: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                stain: {
                    enum: [
                        'clean',
                        'poop',
                        'pee',
                        'puke'
                    ]
                },
                stainedUntil: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                messImmuneUntil: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                id: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 128
                },
                kind: {
                    enum: [
                        'silence',
                        'gardener',
                        'queue',
                        'cleaner',
                        'mayor',
                        'washer',
                        'watcher',
                        'inspector'
                    ]
                },
                home: {
                    $ref: '#/$defs/point'
                },
                prop: {
                    $ref: '#/$defs/obstacle'
                },
                color: {
                    type: 'string',
                    pattern: '^#[a-fA-F0-9]{6}$'
                },
                phase: {
                    enum: [
                        'idle',
                        'reacting',
                        'returning',
                        'rivalry',
                        'chasing'
                    ]
                },
                startedAt: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                until: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                rewardAt: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                rivalAt: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                rivalCreature: {
                    type: 'integer',
                    minimum: -1,
                    maximum: 5
                },
                target: {
                    $ref: '#/$defs/point'
                },
                targetId: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 128
                },
                collected: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                released: {
                    type: 'boolean'
                }
            },
            required: [
                'x',
                'z',
                'stain',
                'stainedUntil',
                'messImmuneUntil',
                'id',
                'kind',
                'home',
                'prop',
                'color',
                'phase',
                'startedAt',
                'until',
                'rewardAt',
                'rivalAt',
                'rivalCreature',
                'target',
                'collected',
                'released'
            ]
        },
        spectacleRequest: {
            type: 'object',
            additionalProperties: false,
            properties: {
                kind: {
                    enum: [
                        'fire',
                        'poop',
                        'vomit'
                    ]
                },
                origin: {
                    $ref: '#/$defs/point'
                },
                witnesses: {
                    type: 'array',
                    items: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 128
                    },
                    uniqueItems: true,
                    maxItems: 32
                }
            },
            required: [
                'kind',
                'origin',
                'witnesses'
            ]
        },
        firefighter: {
            type: 'object',
            additionalProperties: false,
            properties: {
                x: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                z: {
                    type: 'number',
                    minimum: -64,
                    maximum: 64
                },
                stain: {
                    enum: [
                        'clean',
                        'poop',
                        'pee',
                        'puke'
                    ]
                },
                stainedUntil: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                messImmuneUntil: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                id: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                phase: {
                    enum: [
                        'responding',
                        'aiming',
                        'spraying',
                        'returning'
                    ]
                },
                aim: {
                    $ref: '#/$defs/point'
                },
                until: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                }
            },
            required: [
                'x',
                'z',
                'stain',
                'stainedUntil',
                'messImmuneUntil',
                'id',
                'phase',
                'aim',
                'until'
            ]
        },
        spectacle: {
            type: 'object',
            additionalProperties: false,
            properties: {
                kind: {
                    enum: [
                        'fire',
                        'poop',
                        'vomit'
                    ]
                },
                origin: {
                    $ref: '#/$defs/point'
                },
                witnesses: {
                    type: 'array',
                    items: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 128
                    },
                    uniqueItems: true,
                    maxItems: 32
                },
                startedAt: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                until: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                progress: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                nextPatchAt: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                phase: {
                    enum: [
                        'warning',
                        'active',
                        'cleanup'
                    ]
                }
            },
            required: [
                'kind',
                'origin',
                'witnesses',
                'startedAt',
                'until',
                'progress',
                'nextPatchAt',
                'phase'
            ]
        },
        spectacles: {
            type: 'object',
            additionalProperties: false,
            properties: {
                active: {
                    $ref: '#/$defs/spectacle'
                },
                queue: {
                    type: 'array',
                    items: {
                        $ref: '#/$defs/spectacleRequest'
                    },
                    maxItems: 3
                },
                firefighters: {
                    type: 'array',
                    items: {
                        $ref: '#/$defs/firefighter'
                    },
                    maxItems: 2
                },
                fireReadyAt: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                bombReadyAt: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                vomitReadyAt: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                umbrellaUntil: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                fires: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                bombs: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                dinners: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                }
            },
            required: [
                'queue',
                'firefighters',
                'fireReadyAt',
                'bombReadyAt',
                'vomitReadyAt',
                'umbrellaUntil',
                'fires',
                'bombs',
                'dinners'
            ]
        },
        town: {
            type: 'object',
            additionalProperties: false,
            properties: {
                spectacles: {
                    $ref: '#/$defs/spectacles'
                },
                personalities: {
                    type: 'array',
                    items: {
                        $ref: '#/$defs/personality'
                    },
                    maxItems: 8
                },
                creatures: {
                    type: 'array',
                    items: {
                        $ref: '#/$defs/creature'
                    },
                    maxItems: 6
                },
                objects: {
                    type: 'array',
                    items: {
                        $ref: '#/$defs/object'
                    },
                    maxItems: 5
                },
                mischief: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                score: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                heat: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                rescues: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                nextId: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                spills: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                cleaned: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 1000000
                },
                raid: {
                    $ref: '#/$defs/raid'
                },
                rescueProgress: {
                    type: 'number',
                    minimum: -86400,
                    maximum: 86400
                },
                fountain: {
                    $ref: '#/$defs/fountain'
                },
                cart: {
                    $ref: '#/$defs/cart'
                },
                shops: {
                    type: 'array',
                    items: {
                        $ref: '#/$defs/shop'
                    },
                    maxItems: 6
                },
                npcs: {
                    type: 'array',
                    items: {
                        $ref: '#/$defs/npc'
                    },
                    maxItems: 6
                },
                fruit: {
                    type: 'array',
                    items: {
                        $ref: '#/$defs/fruit'
                    },
                    maxItems: 48
                },
                patches: {
                    type: 'array',
                    items: {
                        $ref: '#/$defs/patch'
                    },
                    maxItems: 256
                },
                zaps: {
                    type: 'array',
                    items: {
                        $ref: '#/$defs/zap'
                    },
                    maxItems: 64
                }
            },
            required: [
                'spectacles',
                'personalities',
                'creatures',
                'objects',
                'mischief',
                'score',
                'heat',
                'rescues',
                'nextId',
                'spills',
                'cleaned',
                'raid',
                'rescueProgress',
                'fountain',
                'cart',
                'shops',
                'npcs',
                'fruit',
                'patches',
                'zaps'
            ]
        }
    }
};
