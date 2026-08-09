import { describe, expect, it } from 'vitest';

import { distributedRecipePreflight } from '../../shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe,
} from '../../shared-test/rallar-bb-test/types.ts';

const ROOM_IDENTITY_WARNING =
    'Browser Rallar RTC readiness cannot point-refresh room state without an exact room reference';
const ROOM_IDENTITY_REMEDY =
    'provide roomRef or applicationId plus roomId on rtc.connect or the active configure command.';

function recipeWith(commands: readonly RallarBlackBoxTestCommand[]): RallarBlackBoxTestRecipe {
    return {
        recipeId: 'rtc-readiness-room-identity',
        commands,
    };
}

function readinessConnect(
    fields: Partial<Extract<RallarBlackBoxTestCommand, { kind: 'rtc.connect' }>> = {},
): Extract<RallarBlackBoxTestCommand, { kind: 'rtc.connect' }> {
    return {
        kind: 'rtc.connect',
        commandId: 'connect',
        readiness: {
            minReadyPeers: 1,
            timeoutMs: 10_000,
            intervalMs: 100,
        },
        ...fields,
    };
}

function roomIdentityWarnings(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    return distributedRecipePreflight(recipe).warnings.filter(warning =>
        warning.includes(ROOM_IDENTITY_WARNING)
    );
}

function expectedRoomIdentityWarning(path: string): string {
    return `${path}: ${ROOM_IDENTITY_WARNING}; ${ROOM_IDENTITY_REMEDY}`;
}

describe('RTC readiness room identity preflight', () => {
    it('warns with the command path when readiness cannot resolve an exact room', () => {
        const warnings = roomIdentityWarnings(recipeWith([
            readinessConnect({ roomId: 'room-1' }),
        ]));

        expect(warnings).toEqual([
            expectedRoomIdentityWarning('$.commands[0]'),
        ]);
    });

    it.each([
        {
            label: 'direct room reference',
            fields: {
                roomRef: {
                    applicationId: 'game-app',
                    groupId: 'room-1',
                },
            },
        },
        {
            label: 'application and room fields without a workspace',
            fields: {
                applicationId: 'game-app',
                roomId: 'room-1',
            },
        },
        {
            label: 'command Rallar room reference',
            fields: {
                rallar: {
                    roomRef: {
                        applicationId: 'game-app',
                        groupId: 'room-1',
                    },
                },
            },
        },
        {
            label: 'command scope and room fields',
            fields: {
                roomId: 'room-1',
                scope: {
                    applicationId: 'game-app',
                },
            },
        },
    ] satisfies readonly Readonly<{
        label: string;
        fields: Partial<Extract<RallarBlackBoxTestCommand, { kind: 'rtc.connect' }>>;
    }>[])('accepts exact room identity from $label', ({ fields }) => {
        expect(roomIdentityWarnings(recipeWith([readinessConnect(fields)]))).toEqual([]);
    });

    it('accepts exact room identity from the latest preceding configure command', () => {
        const recipe = recipeWith([
            {
                kind: 'configure',
                config: {
                    roomId: 'room-1',
                    rallar: {
                        applicationId: 'game-app',
                    },
                },
            },
            readinessConnect(),
        ]);

        expect(roomIdentityWarnings(recipe)).toEqual([]);
    });

    it('uses the latest configure instead of stale room addressing', () => {
        const recipe = recipeWith([
            {
                kind: 'configure',
                config: {
                    roomId: 'room-1',
                    rallar: {
                        applicationId: 'game-app',
                    },
                },
            },
            {
                kind: 'configure',
                config: {
                    roomId: 'room-2',
                },
            },
            readinessConnect(),
        ]);

        expect(roomIdentityWarnings(recipe)).toEqual([
            expectedRoomIdentityWarning('$.commands[2]'),
        ]);
    });

    it('inherits active configuration inside loops and embedded recipes', () => {
        const recipe = recipeWith([
            {
                kind: 'configure',
                config: {
                    roomId: 'room-1',
                    rallar: {
                        applicationId: 'game-app',
                    },
                },
            },
            {
                kind: 'loop',
                count: 1,
                commands: [readinessConnect({ commandId: 'loop-connect' })],
            },
            {
                kind: 'recipe.run',
                recipe: {
                    recipeId: 'embedded-readiness',
                    commands: [readinessConnect({ commandId: 'recipe-connect' })],
                },
            },
        ]);

        expect(roomIdentityWarnings(recipe)).toEqual([]);
    });

    it('evaluates sequential configuration inside loops and embedded recipes', () => {
        const recipe = recipeWith([
            {
                kind: 'loop',
                count: 1,
                commands: [
                    {
                        kind: 'configure',
                        config: {
                            roomId: 'loop-room',
                            rallar: { applicationId: 'game-app' },
                        },
                    },
                    readinessConnect({ commandId: 'loop-connect' }),
                ],
            },
            {
                kind: 'recipe.run',
                recipe: {
                    recipeId: 'embedded-readiness',
                    commands: [
                        {
                            kind: 'configure',
                            config: {
                                roomId: 'recipe-room',
                                rallar: { applicationId: 'game-app' },
                            },
                        },
                        readinessConnect({ commandId: 'recipe-connect' }),
                    ],
                },
            },
        ]);

        expect(roomIdentityWarnings(recipe)).toEqual([]);
    });

    it.each([
        {
            label: 'loop',
            composite: {
                kind: 'loop',
                count: 1,
                commands: [{
                    kind: 'configure',
                    config: {
                        roomId: 'loop-room',
                        rallar: { applicationId: 'game-app' },
                    },
                }],
            },
        },
        {
            label: 'embedded recipe',
            composite: {
                kind: 'recipe.run',
                recipe: {
                    recipeId: 'embedded-config',
                    commands: [{
                        kind: 'configure',
                        config: {
                            roomId: 'recipe-room',
                            rallar: { applicationId: 'game-app' },
                        },
                    }],
                },
            },
        },
        {
            label: 'parallel group',
            composite: {
                kind: 'parallel',
                groups: [{
                    groupId: 'configured-branch',
                    commands: [{
                        kind: 'configure',
                        config: {
                            roomId: 'parallel-room',
                            rallar: { applicationId: 'game-app' },
                        },
                    }],
                }],
            },
        },
    ] satisfies readonly Readonly<{
        label: string;
        composite: RallarBlackBoxTestCommand;
    }>[])('does not propagate $label configuration to following commands', ({ composite }) => {
        const recipe = recipeWith([
            composite,
            readinessConnect(),
        ]);

        expect(roomIdentityWarnings(recipe)).toEqual([
            expectedRoomIdentityWarning('$.commands[1]'),
        ]);
    });

    it('does not share configure state between parallel branches', () => {
        const recipe = recipeWith([
            {
                kind: 'parallel',
                groups: [
                    {
                        groupId: 'configured-branch',
                        commands: [
                            {
                                kind: 'configure',
                                config: {
                                    roomId: 'room-1',
                                    rallar: {
                                        applicationId: 'game-app',
                                    },
                                },
                            },
                        ],
                    },
                    {
                        groupId: 'readiness-branch',
                        commands: [readinessConnect()],
                    },
                ],
            },
        ]);

        expect(roomIdentityWarnings(recipe)).toEqual([
            expectedRoomIdentityWarning('$.commands[0].groups[1].commands[0]'),
        ]);
    });

    it('does not warn when rtc.connect has no readiness contract', () => {
        const recipe = recipeWith([
            {
                kind: 'rtc.connect',
                commandId: 'connect',
                roomId: 'room-1',
            },
        ]);

        expect(roomIdentityWarnings(recipe)).toEqual([]);
    });
});
