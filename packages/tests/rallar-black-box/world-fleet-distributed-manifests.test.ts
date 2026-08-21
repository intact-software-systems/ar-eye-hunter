import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
    buildWorldFleetDistributedManifestCatalog,
    WORLD_FLEET_DISTRIBUTED_MANIFEST_DIAGNOSTIC_ORDER,
    WORLD_FLEET_DISTRIBUTED_MANIFEST_GREEN_ORDER
} from '../../../apps/rallar-black-box/src/world-fleet-distributed-manifests.ts';
import {
    validateDistributedRunManifestContract,
    type RallarBlackBoxDistributedRunManifest
} from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import {
    formatJsonSchemaValidationErrors,
    RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA,
    validateJsonSchema
} from '../../../packages/shared-test/rallar-bb-test/schema.ts';

type ManifestCommand = Readonly<{
    kind?: string;
    transport?: string;
    rallar?: Readonly<Record<string, unknown>>;
    commands?: readonly ManifestCommand[];
    groups?: readonly Readonly<{
        commands?: readonly ManifestCommand[];
    }>[];
}>;

function manifestCommands(manifest: RallarBlackBoxDistributedRunManifest): readonly ManifestCommand[] {
    const walk = (commands: readonly ManifestCommand[]): readonly ManifestCommand[] =>
        commands.flatMap((command) => [
            command,
            ...walk(command.commands ?? []),
            ...(command.groups ?? []).flatMap((group) => walk(group.commands ?? []))
        ]);

    return manifest.recipes.flatMap((selection) => walk((selection.recipe?.commands ?? []) as readonly ManifestCommand[]));
}

describe('world fleet distributed manifest catalog', () => {
    it('writes checked-in JSON that matches the generated catalog exactly', async () => {
        for (const entry of buildWorldFleetDistributedManifestCatalog()) {
            const current = await readFile(entry.filePath, 'utf8');
            expect(current).toBe(`${JSON.stringify(entry.manifest, null, 2)}\n`);
        }
    });

    it('builds no-spawn all-online manifests with expected 50 participants', () => {
        const catalog = buildWorldFleetDistributedManifestCatalog();

        expect(catalog.map((entry) => entry.filePath)).toEqual([
            ...WORLD_FLEET_DISTRIBUTED_MANIFEST_GREEN_ORDER,
            ...WORLD_FLEET_DISTRIBUTED_MANIFEST_DIAGNOSTIC_ORDER
        ]);

        for (const entry of catalog) {
            expect(entry.agentCount).toBe(50);
            expect(entry.manifest.targetPolicy).toMatchObject({
                mode: 'all-online-group-members',
                expectedParticipantCount: 50
            });
            expect(entry.manifest.metadata).toMatchObject({
                worldFleet: true,
                noSpawn: true
            });
            expect(entry.manifest.roleAssignments).toBeUndefined();

            const schemaResult = validateJsonSchema(
                RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA,
                entry.manifest
            );
            expect(
                schemaResult.ok,
                schemaResult.ok ? undefined : formatJsonSchemaValidationErrors(schemaResult.errors)
            ).toBe(true);
            expect(validateDistributedRunManifestContract(entry.manifest)).toEqual({
                ok: true,
                errors: []
            });
        }
    });

    it('uses ordered target role policy for principal world-fleet multicast', () => {
        const principal = buildWorldFleetDistributedManifestCatalog()
            .find((entry) => entry.manifest.distributedRunId.includes('principal-50-agent-30s-20hz-tree'));

        expect(principal?.manifest.roleAssignmentPolicy).toEqual({
            mode: 'ordered-targets',
            pattern: 'one-sender-many-receivers',
            orderBy: 'agent-id'
        });
        expect(principal?.manifest.recipes.map((selection) => selection.role)).toEqual(['sender', 'receiver']);
        expect(principal?.manifest.metadata?.receiverDelivery).toMatchObject({
            expectedInboundMessages: 600,
            minReceiveRatio: 0.95
        });
    });

    it('configures matching selectors for every messages.rtc connection', () => {
        for (const entry of buildWorldFleetDistributedManifestCatalog()) {
            for (const command of manifestCommands(entry.manifest)) {
                if (command.kind !== 'rtc.connect' || command.transport !== 'messages.rtc') {
                    continue;
                }

                expect(command.rallar, entry.filePath).toEqual({
                    typeId: 'black-box.group.multicast.position',
                    topicId: 'black-box.group.multicast.position'
                });
            }
        }
    });

    it('keeps 20 Hz all-peer and 60m world-fleet runs diagnostic', () => {
        const catalog = buildWorldFleetDistributedManifestCatalog();
        const diagnostics = catalog.filter((entry) => entry.diagnostic);

        expect(diagnostics.map((entry) => entry.filePath)).toEqual(WORLD_FLEET_DISTRIBUTED_MANIFEST_DIAGNOSTIC_ORDER);
        expect(catalog.filter((entry) => entry.mainline).map((entry) => entry.filePath)).toEqual(
            WORLD_FLEET_DISTRIBUTED_MANIFEST_GREEN_ORDER
        );
    });
});
