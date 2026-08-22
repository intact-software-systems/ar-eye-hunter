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
            label: 'Run manager health probe'
        }
    },
    {
        presetId: 'stats',
        label: 'Stats',
        command: {
            kind: 'stats',
            label: 'Run manager stats snapshot'
        }
    },
    {
        presetId: 'reset',
        label: 'Browser Reset',
        command: {
            kind: 'reset',
            label: 'Run manager browser reset'
        }
    },
    {
        presetId: 'crdt-open-local',
        label: 'CRDT Open Local',
        command: {
            kind: 'crdt.open',
            commandId: 'crdt-open-local',
            label: 'Open local CRDT document',
            handle: 'checklist',
            name: 'checklist',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            documentType: 'checklist',
            documentId: 'rallar-black-box-room',
            scope: {
                kind: 'room'
            },
            roomRef: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'rallar-black-box-room'
            },
            transport: 'local-only',
            persist: true,
            tabSync: true,
            initialValue: {
                items: []
            },
            timeoutMs: 5_000
        }
    },
    {
        presetId: 'crdt-wait-clean',
        label: 'CRDT Wait Clean',
        command: {
            kind: 'crdt.wait',
            commandId: 'crdt-wait-clean',
            label: 'Wait for clean CRDT health',
            handle: 'checklist',
            timeoutMs: 10_000,
            intervalMs: 250,
            stableForMs: 500,
            conditions: [
                {
                    source: 'health',
                    path: 'pendingUpdateCount',
                    operator: 'equals',
                    expected: 0
                },
                {
                    source: 'health',
                    path: 'dependencyBlockedUpdateCount',
                    operator: 'equals',
                    expected: 0
                }
            ]
        }
    },
    {
        presetId: 'crdt-health',
        label: 'CRDT',
        command: {
            kind: 'crdt.health',
            commandId: 'crdt-health',
            label: 'Read CRDT health',
            handle: 'checklist',
            timeoutMs: 5_000
        }
    }
];
