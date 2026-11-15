import {
    describe,
    expect,
    it
} from 'vitest';

import { decodeDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run-validation.ts';

import { toCellGateRunManifest } from '../../../tests/playwright/rallar-black-box/full-stack-cell-gate-run.ts';

const group = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

const agentsByRole = new Map(
    [
        ['sender', { agentId: 'sender-agent' }],
        ['receiver', { agentId: 'receiver-agent' }],
        ['recipient-b', { agentId: 'recipient-b-agent' }]
    ] as const
);

describe('cell gate run', () => {
    it('registers one start selection per role with the run\'s own barrier disabled and a manual start', () => {
        const manifest = toCellGateRunManifest({ run: { runId: 'alm-rtc-run', group }, cellKey: undefined, agentsByRole });

        expect(decodeDistributedRunManifest(manifest).left).toBeUndefined();
        expect(manifest).toMatchObject({ barrier: { enabled: false }, startMode: 'manual', groupAssertions: [] });
        expect(manifest.recipes.map((selection) => selection.role)).toEqual(['sender', 'receiver', 'recipient-b']);
        for (const selection of manifest.recipes) {
            expect(selection.recipe?.commands.map((command) => command.kind), selection.recipeId).toEqual(['health']);
        }
        expect(manifest.roleAssignments).toEqual([
            { role: 'sender', agentId: 'sender-agent', recipeIds: [], variables: {} },
            { role: 'receiver', agentId: 'receiver-agent', recipeIds: [], variables: {} },
            { role: 'recipient-b', agentId: 'recipient-b-agent', recipeIds: [], variables: {} }
        ]);
    });

    it('names the lane\'s control run and every family agent', () => {
        const family = toCellGateRunManifest({ run: { runId: 'alm-rtc-run', group }, cellKey: undefined, agentsByRole });
        const cell = toCellGateRunManifest({ run: { runId: 'alm-rtc-run', group }, cellKey: 'durable-takeover', agentsByRole });

        expect(family).toMatchObject({ controlRunId: 'alm-rtc-run', group });
        expect(family.targetPolicy).toEqual({
            mode: 'selected-agents',
            agentIds: ['sender-agent', 'receiver-agent', 'recipient-b-agent']
        });
        // A same-context cell registers a run of its own, so its id names the cell.
        expect(family.distributedRunId).toBe('alm-rtc-run-gate');
        expect(cell.distributedRunId).toBe('alm-rtc-run-durable-takeover-gate');
        expect(cell.recipes.flatMap((selection) => selection.recipe!.commands.map((command) => command.commandId)))
            .toEqual(['sender', 'receiver', 'recipient-b'].map((role) => `alm-rtc-run-durable-takeover-gate-${role}-health`));
    });
});
