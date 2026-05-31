import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    BLACK_BOX_RUNNER_SCENARIO_RECIPE_SCHEMA,
} from '../../shared-test/black-box-runner/schema.ts';
import {
    RALLAR_BLACK_BOX_COMMAND_CAPABILITIES,
    RALLAR_BLACK_BOX_CONTROL_COMMAND_ENVELOPE_SCHEMA,
    RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA,
    RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA,
    RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
    formatJsonSchemaValidationErrors,
    validateJsonSchema,
} from '../../shared-test/rallar-bb-test/schema.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMMAND_KINDS,
    type RallarBlackBoxTestRecipe,
} from '../../shared-test/rallar-bb-test/types.ts';
import { controlOpenApiSpec } from '../../../apps/rallar-black-box-control-server/src/routes/swagger-routes.ts';
import {
    FLOW_BUILDER_TEMPLATES,
    buildFlowBuilderRecipe,
    buildFlowBuilderRunnerScenario,
} from '../../../apps/rallar-black-box/src/flow-builder.ts';
import { manualRecipeSnippet, type ManualActionHistoryEntry } from '../../../apps/rallar-black-box/src/manual-workbench.ts';
import { RALLAR_BLACK_BOX_RECIPE_FIXTURES } from '../../../apps/rallar-black-box/src/recipe-fixtures.ts';
import { RUN_MANAGER_COMMAND_PRESETS } from '../../../apps/rallar-black-box/src/run-manager-presets.ts';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const appExamplesRoot = path.join(repoRoot, 'apps/rallar-black-box/examples');
const runnerExamplesRoot = path.join(repoRoot, 'packages/shared-test/black-box-runner/examples');

function readJsonFile(filePath: string): unknown {
    return JSON.parse(readFileSync(filePath, 'utf8'));
}

function expectValid(schema: Parameters<typeof validateJsonSchema>[0], value: unknown): void {
    const result = validateJsonSchema(schema, value);
    expect(result.ok, result.ok ? undefined : formatJsonSchemaValidationErrors(result.errors)).toBe(true);
}

describe('rallar-bb-test capability and schema contract', () => {
    it('keeps command capability metadata in lockstep with command kinds', () => {
        expect(RALLAR_BLACK_BOX_COMMAND_CAPABILITIES.map(capability => capability.kind)).toEqual(
            RALLAR_BLACK_BOX_TEST_COMMAND_KINDS,
        );

        for (const capability of RALLAR_BLACK_BOX_COMMAND_CAPABILITIES) {
            expect(capability.description.length).toBeGreaterThan(0);
            expect(capability.runtimeSurfaces.length).toBeGreaterThan(0);
            expect(capability.artifactExpectations.length).toBeGreaterThan(0);
            expectValid(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, capability.example);
        }
    });

    it('validates recipe fixtures, examples, flow exports, manual snippets, and run-manager presets', () => {
        const capabilityRecipe: RallarBlackBoxTestRecipe = {
            recipeId: 'all-capability-examples',
            commands: RALLAR_BLACK_BOX_COMMAND_CAPABILITIES.map(capability => capability.example),
        };
        expectValid(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, capabilityRecipe);

        for (const fixture of RALLAR_BLACK_BOX_RECIPE_FIXTURES) {
            expectValid(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, fixture.recipe);
        }

        for (const fileName of readdirSync(appExamplesRoot).filter(name => name.endsWith('.recipe.json'))) {
            expectValid(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, readJsonFile(path.join(appExamplesRoot, fileName)));
        }

        const flow = FLOW_BUILDER_TEMPLATES[0].flow;
        expectValid(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, buildFlowBuilderRecipe(flow));
        expectValid(BLACK_BOX_RUNNER_SCENARIO_RECIPE_SCHEMA, buildFlowBuilderRunnerScenario(flow));

        const manualEntry: ManualActionHistoryEntry = {
            actionId: 'action-1',
            label: 'Health',
            atEpochMs: 123,
            commandIds: ['manual-health-1'],
            commands: [{ kind: 'health', commandId: 'manual-health-1' }],
        };
        expectValid(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, JSON.parse(manualRecipeSnippet([manualEntry])));

        for (const preset of RUN_MANAGER_COMMAND_PRESETS) {
            expectValid(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, preset.command);
        }
    });

    it('validates every shared-test black-box-runner example scenario', () => {
        const exampleNames = readdirSync(runnerExamplesRoot).filter(name => name.endsWith('.json'));
        expect(exampleNames.length).toBeGreaterThan(0);

        for (const fileName of exampleNames) {
            expectValid(
                BLACK_BOX_RUNNER_SCENARIO_RECIPE_SCHEMA,
                readJsonFile(path.join(runnerExamplesRoot, fileName)),
            );
        }
    });

    it('validates control envelopes, distributed manifests, and OpenAPI command examples', () => {
        expectValid(RALLAR_BLACK_BOX_CONTROL_COMMAND_ENVELOPE_SCHEMA, {
            kind: 'command',
            protocolVersion: 1,
            runId: 'schema-run',
            agentId: 'agent-1',
            commandId: 'health-1',
            command: {
                kind: 'health',
                commandId: 'health-1',
            },
        });

        expectValid(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA, {
            distributedRunId: 'distributed-schema-run',
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'bb-group',
            },
            recipes: [
                {
                    recipeId: 'health-only',
                    role: 'all-agents',
                    required: true,
                },
            ],
            targetPolicy: {
                mode: 'all-online-group-members',
                expectedParticipantCount: 2,
            },
            ackTimeoutMs: 5_000,
            startMode: 'manual',
        });

        const spec = controlOpenApiSpec(new Request('http://localhost:5180/api/openapi.json')) as {
            components?: {
                schemas?: Record<string, unknown>;
            };
            paths?: Record<string, {
                post?: {
                    requestBody?: {
                        content?: Record<string, {
                            examples?: Record<string, { value: unknown }>;
                        }>;
                    };
                };
            }>;
        };
        expect(spec.components?.schemas?.RallarBlackBoxTestCommand).toEqual(
            RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA,
        );
        expect(spec.components?.schemas?.DistributedRunManifest).toEqual(
            RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA,
        );

        const commandExamples = spec
            .paths?.['/runs/{runId}/agents/{agentId}/commands']
            ?.post?.requestBody?.content?.['application/json']?.examples ?? {};
        expect(Object.keys(commandExamples).length).toBeGreaterThan(0);
        for (const example of Object.values(commandExamples)) {
            const value = example.value as { command?: unknown };
            expectValid(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, value.command);
        }
    });

    it('returns actionable schema errors for invalid JSON before dispatch', () => {
        const commandResult = validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, {
            kind: 'http.request',
            unexpected: true,
        });

        expect(commandResult.ok).toBe(false);
        if (!commandResult.ok) {
            const text = formatJsonSchemaValidationErrors(commandResult.errors);
            expect(text).toContain('Missing required property request');
            expect(text).toContain('$.unexpected: Unexpected property');
        }

        const recipeResult = validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, {
            commands: [{ kind: 'health' }],
        });
        expect(recipeResult.ok).toBe(false);
        if (!recipeResult.ok) {
            expect(formatJsonSchemaValidationErrors(recipeResult.errors)).toContain('Missing required property recipeId');
        }
    });
});
