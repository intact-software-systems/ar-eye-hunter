import {
    describe,
    expect,
    it
} from 'vitest';
import { createExecuteManifestDraft } from '../../../apps/rallar-black-box/src/recipe-console/execute/execute-manifest.ts';
import { projectDistributedRecipeCatalog } from '../../shared-test/rallar-bb-test/distributed-recipe-catalog.ts';

const group = { applicationId: 'app', workspaceId: 'workspace', groupId: 'group' };
const selectedRecipe = projectDistributedRecipeCatalog({ configuration: { group, apiBaseUrl: 'https://api.example.test', rtcRealtimeDurationSeconds: 5 } })
    .entries.find((entry) => entry.schema.status === 'valid');
if (!selectedRecipe) {
    throw new Error('A valid recipe must be available.');
}
const input = { distributedRunId: 'history', controlRunId: 'control', group, selectedRecipe, selectedAgentIds: ['agent'] };

describe('operator event history manifest', () => {
    it('inherits by omission and records explicit recent and full selections', () => {
        expect(createExecuteManifestDraft(input).right?.manifest).not.toHaveProperty('eventHistory');
        for (const eventHistory of [{ mode: 'full' }, { mode: 'recent', maxEvents: 64 }] as const) {
            const draft = createExecuteManifestDraft({ ...input, eventHistory }).right;
            expect(draft?.manifest.eventHistory).toEqual(eventHistory);
            expect(draft?.validationIssues).toEqual([]);
            expect(draft?.rawJson).toContain('"eventHistory"');
        }
    });
    it('reports malformed recent bounds before create or stage can proceed', () => {
        const draft = createExecuteManifestDraft({ ...input, eventHistory: { mode: 'recent', maxEvents: 0 } }).right;
        expect(draft?.validationIssues.length).toBeGreaterThan(0);
    });
});
