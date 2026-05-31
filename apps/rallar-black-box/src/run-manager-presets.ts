import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/types.ts';

export const RUN_MANAGER_COMMAND_PRESETS: readonly {
    presetId: string;
    label: string;
    command: RallarBlackBoxTestCommand;
}[] = [
    {
        presetId: 'health',
        label: 'Health',
        command: {
            kind: 'health',
            label: 'Run manager health probe',
        },
    },
    {
        presetId: 'stats',
        label: 'Stats',
        command: {
            kind: 'stats',
            label: 'Run manager stats snapshot',
        },
    },
    {
        presetId: 'reset',
        label: 'Browser Reset',
        command: {
            kind: 'reset',
            label: 'Run manager browser reset',
        },
    },
];
