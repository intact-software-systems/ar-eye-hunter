import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyApiV1FairnessProof } from '@shared-test/black-box-runner/state-write-evidence/api-v1-fairness-proof.ts';

describe('API v1 fairness proof', () => {
    it('binds the exact overdue fixture to controller-selected FAIRNESS timing', async () => {
        const fixture = await createFixture('target-resource');
        try {
            const proofs = await verifyApiV1FairnessProof(fixture.root, [fixture.log]);

            expect(proofs).toEqual([expect.objectContaining({
                resourceId: 'target-resource',
                selectedLane: 'FAIRNESS',
                dueAgeMs: 65_100,
                noBeforeNextTs: true,
            })]);
            const persisted = JSON.parse(await readFile(
                path.join(fixture.root, 'fairness-proof.json'), 'utf8',
            ));
            expect(persisted.proofs).toEqual(proofs);
            const report = JSON.parse(await readFile(fixture.report, 'utf8'));
            expect(report.outputs.stateWriteEvidence.overdueRecoveryFixture.selectedLane)
                .toBe('FAIRNESS');
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    it('fails closed when timing belongs to a different resource', async () => {
        const fixture = await createFixture('other-resource');
        try {
            await expect(verifyApiV1FairnessProof(fixture.root, [fixture.log]))
                .rejects.toThrow(/target-resource.*FAIRNESS/i);
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });
});

async function createFixture(timingResourceId: string) {
    const root = await mkdtemp(path.join(tmpdir(), 'api-v1-fairness-proof-'));
    const runDir = path.join(root, 'cluster', 'convergence');
    await mkdir(runDir, { recursive: true });
    const report = path.join(runDir, 'report.json');
    await writeFile(report, JSON.stringify({
        outputs: {
            stateWriteEvidence: {
                overdueRecoveryFixture: {
                    resourceId: 'target-resource',
                    commandType: 'TOPOLOGY_CONFIG_PUT',
                    injectedDueAt: '2026-01-01T00:00:00.000Z',
                    claimedAt: '2026-01-01T00:01:05.000Z',
                    dueAgeAtClaimMs: 65_000,
                    afterAttempts: 2,
                },
            },
        },
    }));
    await writeFile(path.join(root, 'cluster', 'matrix-summary.json'), JSON.stringify({
        runs: [{ id: 'convergence', status: 'PASSED', artifactDir: runDir }],
    }));
    const log = path.join(root, 'api-v1-server.log');
    await writeFile(log, `${JSON.stringify({
        component: 'app-inbox-phase',
        operation: 'transaction',
        atEpochMs: Date.parse('2026-01-01T00:01:05.100Z'),
        details: {
            resourceId: timingResourceId,
            type: 'TOPOLOGY_CONFIG_PUT',
            attempt: 2,
            selectedLane: 'FAIRNESS',
            dueAgeMs: 65_100,
        },
    })}\n`);
    return { root, report, log };
}
