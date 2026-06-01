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
    RALLAR_BLACK_BOX_RECIPE_SCHEMA_VERSION,
    RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA,
    RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
    formatJsonSchemaValidationErrors,
    validateJsonSchema,
    validateRallarBlackBoxRecipeCompatibility,
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
const rallarBbTestRoot = path.join(repoRoot, 'packages/shared-test/rallar-bb-test');
const goldenCompatibilityCorpusPath = path.join(
    rallarBbTestRoot,
    'fixtures/schema/v1/golden-compatibility-corpus.json',
);
const schemaCompatibilityGuidePath = path.join(
    rallarBbTestRoot,
    'docs/schema-compatibility-guide.md',
);

function readJsonFile(filePath: string): unknown {
    return JSON.parse(readFileSync(filePath, 'utf8'));
}

function expectValid(schema: Parameters<typeof validateJsonSchema>[0], value: unknown): void {
    const result = validateJsonSchema(schema, value);
    expect(result.ok, result.ok ? undefined : formatJsonSchemaValidationErrors(result.errors)).toBe(true);
}

type GoldenCompatibilityCorpus = Readonly<{
    schemaVersion: 1;
    validRecipes: readonly RallarBlackBoxTestRecipe[];
    validDistributedManifests: readonly unknown[];
    invalidRecipes: readonly Readonly<{
        caseId: string;
        value: unknown;
        expectedErrors: readonly string[];
    }>[];
    invalidDistributedManifests: readonly Readonly<{
        caseId: string;
        value: unknown;
        expectedErrors: readonly string[];
    }>[];
}>;

function readGoldenCompatibilityCorpus(): GoldenCompatibilityCorpus {
    return readJsonFile(goldenCompatibilityCorpusPath) as GoldenCompatibilityCorpus;
}

function commandKindsInCommand(command: RallarBlackBoxTestRecipe['commands'][number]): readonly string[] {
    if (command.kind === 'loop') {
        return [command.kind, ...command.commands.flatMap(commandKindsInCommand)];
    }
    if (command.kind === 'parallel') {
        return [
            command.kind,
            ...command.groups.flatMap(group => group.commands.flatMap(commandKindsInCommand)),
        ];
    }
    if ((command.kind === 'recipe.load' || command.kind === 'recipe.run') && command.recipe) {
        return [
            command.kind,
            ...command.recipe.commands.flatMap(commandKindsInCommand),
        ];
    }
    return [command.kind];
}

function commandKindsInRecipe(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    return recipe.commands.flatMap(commandKindsInCommand);
}

function inlineRecipesInManifest(manifest: unknown): readonly RallarBlackBoxTestRecipe[] {
    if (!manifest || typeof manifest !== 'object' || !('recipes' in manifest)) {
        return [];
    }

    const manifestRecipes = (manifest as { recipes?: unknown }).recipes;
    if (!Array.isArray(manifestRecipes)) {
        return [];
    }

    return manifestRecipes.flatMap(entry => {
        if (!entry || typeof entry !== 'object' || !('recipe' in entry)) {
            return [];
        }

        const recipe = (entry as { recipe?: unknown }).recipe;
        return recipe ? [recipe as RallarBlackBoxTestRecipe] : [];
    });
}

function jsonCodeBlocks(markdown: string): readonly unknown[] {
    return [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)]
        .map(match => JSON.parse(match[1]));
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
            schemaVersion: RALLAR_BLACK_BOX_RECIPE_SCHEMA_VERSION,
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

    it('keeps the v1 golden compatibility corpus stable', () => {
        const corpus = readGoldenCompatibilityCorpus();
        const inlineRecipes = corpus.validDistributedManifests.flatMap(inlineRecipesInManifest);

        expect(corpus.schemaVersion).toBe(1);
        const allRecipeCommandKinds = new Set(
            [...corpus.validRecipes, ...inlineRecipes].flatMap(commandKindsInRecipe),
        );
        expect([...allRecipeCommandKinds].sort()).toEqual([...RALLAR_BLACK_BOX_TEST_COMMAND_KINDS].sort());

        for (const recipe of [...corpus.validRecipes, ...inlineRecipes]) {
            expectValid(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipe);
            const compatibility = validateRallarBlackBoxRecipeCompatibility(recipe);
            expect(compatibility.ok, compatibility.ok ? undefined : formatJsonSchemaValidationErrors(compatibility.errors)).toBe(true);
            if (recipe.schemaVersion === undefined) {
                expect(compatibility.warnings.map(warning => warning.path)).toContain('$.schemaVersion');
            } else {
                expect(compatibility.warnings).toEqual([]);
                expect(compatibility.schemaVersion).toBe(RALLAR_BLACK_BOX_RECIPE_SCHEMA_VERSION);
            }
        }

        for (const manifest of corpus.validDistributedManifests) {
            expectValid(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA, manifest);
        }

        for (const invalid of corpus.invalidRecipes) {
            const result = validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, invalid.value);
            expect(result.ok, invalid.caseId).toBe(false);
            if (!result.ok) {
                const text = formatJsonSchemaValidationErrors(result.errors);
                invalid.expectedErrors.forEach(expected => {
                    expect(text, invalid.caseId).toContain(expected);
                });
            }
        }

        for (const invalid of corpus.invalidDistributedManifests) {
            const result = validateJsonSchema(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA, invalid.value);
            expect(result.ok, invalid.caseId).toBe(false);
            if (!result.ok) {
                const text = formatJsonSchemaValidationErrors(result.errors);
                invalid.expectedErrors.forEach(expected => {
                    expect(text, invalid.caseId).toContain(expected);
                });
            }
        }
    });

    it('keeps schema compatibility guide JSON examples validating', () => {
        const blocks = jsonCodeBlocks(readFileSync(schemaCompatibilityGuidePath, 'utf8'));
        expect(blocks.length).toBeGreaterThan(0);

        for (const block of blocks) {
            if (block && typeof block === 'object' && 'distributedRunId' in block) {
                expectValid(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA, block);
                for (const recipe of inlineRecipesInManifest(block)) {
                    const compatibility = validateRallarBlackBoxRecipeCompatibility(recipe);
                    expect(compatibility.ok, compatibility.ok ? undefined : formatJsonSchemaValidationErrors(compatibility.errors)).toBe(true);
                    expect(compatibility.warnings).toEqual([]);
                }
            } else {
                expectValid(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, block);
                const compatibility = validateRallarBlackBoxRecipeCompatibility(block);
                expect(compatibility.ok, compatibility.ok ? undefined : formatJsonSchemaValidationErrors(compatibility.errors)).toBe(true);
                expect(compatibility.warnings).toEqual([]);
            }
        }
    });

    it('validates composite loop, parallel, wait, and assert command contracts recursively', () => {
        const compositeRecipe: RallarBlackBoxTestRecipe = {
            schemaVersion: RALLAR_BLACK_BOX_RECIPE_SCHEMA_VERSION,
            recipeId: 'composite-contract',
            commands: [
                {
                    kind: 'loop',
                    commandId: 'loop-health',
                    count: 2,
                    intervalMs: 10,
                    thresholds: {
                        minAchievedRateHz: 20,
                        maxAverageStartDriftMs: 25,
                        maxStartDriftMs: 50,
                        maxJitterMs: 30,
                        minSendSuccessRatio: 0.95,
                        failOnBackpressure: true,
                    },
                    commands: [
                        {
                            kind: 'health',
                            commandId: 'loop-child-health',
                        },
                    ],
                },
                {
                    kind: 'parallel',
                    commandId: 'parallel-health',
                    maxConcurrency: 2,
                    groups: [
                        {
                            groupId: 'left',
                            commands: [{ kind: 'health', commandId: 'left-health' }],
                        },
                        {
                            groupId: 'right',
                            commands: [{ kind: 'stats', commandId: 'right-stats' }],
                        },
                    ],
                },
                {
                    kind: 'wait',
                    commandId: 'wait-for-message',
                    timeoutMs: 1_000,
                    match: {
                        kind: 'message',
                        topic: 'rallar.browser.realtime.message',
                        transport: 'realtime',
                        payloadPath: 'data.topic',
                        equals: 'room.position',
                    },
                },
                {
                    kind: 'assert',
                    commandId: 'assert-message-count',
                    source: 'state.messages.length',
                    operator: 'gte',
                    expected: 1,
                },
            ],
        };

        expectValid(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, compositeRecipe);

        const invalidNested = validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, {
            kind: 'loop',
            commandId: 'loop-invalid',
            commands: [
                {
                    kind: 'http.request',
                    commandId: 'missing-request',
                },
            ],
        });
        expect(invalidNested.ok).toBe(false);
        if (!invalidNested.ok) {
            expect(formatJsonSchemaValidationErrors(invalidNested.errors)).toContain('Missing required property request');
        }

        const invalidConcurrency = validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, {
            kind: 'parallel',
            commandId: 'parallel-invalid',
            maxConcurrency: 99,
            groups: [
                {
                    groupId: 'only',
                    commands: [{ kind: 'health' }],
                },
            ],
        });
        expect(invalidConcurrency.ok).toBe(false);
        if (!invalidConcurrency.ok) {
            expect(formatJsonSchemaValidationErrors(invalidConcurrency.errors)).toContain('Expected number <=');
        }

        const invalidLoopThreshold = validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, {
            kind: 'loop',
            commandId: 'loop-invalid-threshold',
            commands: [{ kind: 'health' }],
            thresholds: {
                minSendSuccessRatio: 1.5,
                unknownThreshold: true,
            },
        });
        expect(invalidLoopThreshold.ok).toBe(false);
        if (!invalidLoopThreshold.ok) {
            const text = formatJsonSchemaValidationErrors(invalidLoopThreshold.errors);
            expect(text).toContain('Expected number <=');
            expect(text).toContain('Unexpected property');
        }

        const invalidWait = validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, {
            kind: 'wait',
            commandId: 'wait-invalid',
            match: {
                kind: 'unknown-event-kind',
            },
        });
        expect(invalidWait.ok).toBe(false);
        if (!invalidWait.ok) {
            expect(formatJsonSchemaValidationErrors(invalidWait.errors)).toContain('Expected one of');
        }

        const invalidAssert = validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, {
            kind: 'assert',
            commandId: 'assert-invalid',
            source: 'state.messages.length',
            operator: 'greaterThan',
        });
        expect(invalidAssert.ok).toBe(false);
        if (!invalidAssert.ok) {
            expect(formatJsonSchemaValidationErrors(invalidAssert.errors)).toContain('Expected one of');
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
            barrier: {
                enabled: true,
                timeoutMs: 5_000,
            },
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
