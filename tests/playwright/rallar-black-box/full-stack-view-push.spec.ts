import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runWorldFleetDistributedRecipe } from '../../../apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts';
import { decodeControlDistributedRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-distributed-run-snapshot.ts';
import { decodeDistributedRunManifest } from '../../../packages/shared-test/rallar-bb-test/distributed-run-validation.ts';
import {
    FULL_STACK_CONTROL_BASE_URL,
    openBrowserControlAgent,
    readFullStackConfig,
    uniqueRunId,
    waitForControlRunAgent,
    type OpenedBrowserControlAgent
} from './full-stack-helpers.ts';

const config = readFullStackConfig();
const manifestPath = 'apps/rallar-black-box/manifests/hetzner/24-view-push-2-agent.json';

test(
    'two fresh browser agents observe private view push and recover offline changes',
    async ({ browser, request }, testInfo) => {
        test.skip(!config.enabled, config.skipReason);
        test.setTimeout(180_000);
        const authored = decodeDistributedRunManifest(JSON.parse(await readFile(manifestPath, 'utf8'))).fold(
            (issues) => {
                throw new Error(`Invalid view push manifest: ${JSON.stringify(issues)}`);
            },
            (value) => value
        );
        const runId = uniqueRunId(testInfo);
        const manifest = { ...authored, distributedRunId: `${runId}-view-push`, controlRunId: runId };
        const agents: OpenedBrowserControlAgent[] = [];
        const artifactDir = testInfo.outputPath('view-push-distributed');
        try {
            for (const [index, user] of [config.userA, config.userB].entries()) {
                const agentId = `controller-0${index + 1}`;
                agents.push(
                    await openBrowserControlAgent({
                        browser,
                        config: { ...config, ...manifest.group },
                        user,
                        runId,
                        agentId,
                        groupId: manifest.group.groupId
                    })
                );
                await waitForControlRunAgent(request, runId, agentId);
            }
            expect(new Set(agents.map((agent) => agent.session.clientId)).size).toBe(2);
            const operation = await runWorldFleetDistributedRecipe({
                controlBaseUrl: FULL_STACK_CONTROL_BASE_URL,
                manifestPath,
                controlRunId: runId,
                artifactDir,
                pollMs: 250,
                timeoutMs: 90_000
            }, {
                fetch,
                readManifestText: async () => JSON.stringify(manifest),
                artifacts: {
                    mkdir: async (directory) => {
                        await mkdir(directory, { recursive: true });
                    },
                    writeFile
                },
                clock: {
                    now: Date.now,
                    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
                },
                log: console.log,
                warn: console.warn,
                prepareEvidenceExport: async () => {
                    await Promise.all(agents.map((agent) => agent.context.close()));
                }
            });
            operation.fold((failure) => {
                throw new Error(`View push distributed operation failed: ${JSON.stringify(failure)}`);
            }, () => undefined);
            const snapshot = decodeControlDistributedRunSnapshot(
                JSON.parse(await readFile(path.join(artifactDir, 'distributed-run.json'), 'utf8'))
            )
                .fold(() => {
                    throw new Error('Invalid distributed proof snapshot');
                }, (value) => value);
            expect(snapshot.state).toBe('passed');
            expect(snapshot.targetAgentIds.toSorted()).toEqual(['controller-01', 'controller-02']);
            expect(snapshot.rollup.summary.passedParticipants).toBe(2);
            expect(snapshot.rollup.failures).toEqual([]);
        }
        finally {
            await Promise.all(agents.map((agent) => agent.context.close()));
        }
    }
);
