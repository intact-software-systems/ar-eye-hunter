import { describe, expect, it } from 'vitest';

import { executeBlackBox } from '../../shared-test/black-box-runner/execute-black-box.ts';

const FAULTS_URL = 'http://127.0.0.1:49152';

interface PostedFault {
    readonly url: string;
    readonly body: unknown;
}

function toServerStep(name: string, request: Record<string, unknown>, executionNumber: number) {
    return {
        SERVER: {
            request: { ...request, scenarioExecutionNumber: 1, interactionExecutionNumber: executionNumber },
            response: {}
        },
        [name]: {}
    };
}

/** Stands in for the run's endpoint: it records each posted fault and answers what `reply` gives for it. */
function createEndpoint(reply: (body: any) => Response) {
    const posted: PostedFault[] = [];
    return {
        posted,
        dependencies: {
            now: Date.now,
            createUuid: () => crypto.randomUUID(),
            fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
                const body = JSON.parse(String(init?.body));
                posted.push({ url: String(url), body });
                return reply(body);
            }
        }
    };
}

function applied(body: { action: string; }): Response {
    return Response.json({
        outcome: 'applied',
        applied: body.action === 'restore' ? { action: 'restore', restored: ['secondary'] } : { action: body.action }
    });
}

describe('a recipe\'s server steps', () => {
    it('posts the fault to the run\'s endpoint and restores the servers when the recipe ends', async () => {
        const endpoint = createEndpoint(applied);

        const report = await executeBlackBox(
            [toServerStep('crashSecondary', { action: 'stop', target: 'secondary', mode: 'crash' }, 1)],
            0,
            { dependencies: endpoint.dependencies, environment: { RALLAR_BB_SERVER_FAULTS_URL: FAULTS_URL } }
        );

        expect(report.resultsByName.crashSecondary[0]).toMatchObject({
            status: 'SUCCESS',
            transport: 'SERVER',
            action: 'stop',
            actual: { action: 'stop' }
        });
        expect(endpoint.posted).toEqual([
            { url: FAULTS_URL, body: { action: 'stop', target: 'secondary', mode: 'crash' } },
            { url: FAULTS_URL, body: { action: 'restore' } }
        ]);
    });

    it('asks for no restore when the recipe restored its servers itself', async () => {
        const endpoint = createEndpoint(applied);

        await executeBlackBox(
            [
                toServerStep('suspendTertiary', { action: 'suspend', target: 'tertiary' }, 1),
                toServerStep('restoreAll', { action: 'restore' }, 2)
            ],
            0,
            { dependencies: endpoint.dependencies, environment: { RALLAR_BB_SERVER_FAULTS_URL: FAULTS_URL } }
        );

        expect(endpoint.posted.map((fault) => fault.body)).toEqual([
            { action: 'suspend', target: 'tertiary' },
            { action: 'restore' }
        ]);
    });

    it('asks again when the recipe\'s own restore was refused', async () => {
        let restores = 0;
        const endpoint = createEndpoint((body) => {
            if (body.action !== 'restore') {
                return applied(body);
            }
            restores += 1;
            return restores === 1 ? Response.json({ outcome: 'invalid', issue: 'busy' }, { status: 400 }) : applied(body);
        });

        const report = await executeBlackBox(
            [
                toServerStep('suspendTertiary', { action: 'suspend', target: 'tertiary' }, 1),
                toServerStep('restoreAll', { action: 'restore' }, 2)
            ],
            0,
            {
                dependencies: endpoint.dependencies,
                environment: { RALLAR_BB_SERVER_FAULTS_URL: FAULTS_URL },
                failFast: false
            }
        );

        expect(report.resultsByName.restoreAll[0].status).toBe('FAILURE');
        expect(endpoint.posted.map((fault) => fault.body)).toEqual([
            { action: 'suspend', target: 'tertiary' },
            { action: 'restore' },
            { action: 'restore' }
        ]);
    });

    it('fails the step, without a request, in a run that manages no API servers', async () => {
        const endpoint = createEndpoint(applied);

        const report = await executeBlackBox(
            [toServerStep('crashPrimary', { action: 'stop', target: 'primary', mode: 'crash' }, 1)],
            0,
            { dependencies: endpoint.dependencies, environment: {}, failFast: false }
        );

        expect(report.resultsByName.crashPrimary[0]).toMatchObject({
            status: 'FAILURE',
            result: 'This run manages no API servers, so a server step has nothing to act on.'
        });
        expect(endpoint.posted).toEqual([]);
    });

    it('fails the step with the run\'s refusal', async () => {
        const endpoint = createEndpoint((body) =>
            body.action === 'restore'
                ? applied(body)
                : Response.json({ outcome: 'refused', refusal: 'not-suspended' }, { status: 409 })
        );

        const report = await executeBlackBox(
            [toServerStep('resumePrimary', { action: 'resume', target: 'primary' }, 1)],
            0,
            {
                dependencies: endpoint.dependencies,
                environment: { RALLAR_BB_SERVER_FAULTS_URL: FAULTS_URL },
                failFast: false
            }
        );

        expect(report.resultsByName.resumePrimary[0]).toMatchObject({
            status: 'FAILURE',
            result: 'The run refused the server step: not-suspended.',
            actual: { outcome: 'refused', refusal: 'not-suspended' }
        });
    });

    it('fails a step whose fault the vocabulary lacks, without a request', async () => {
        const endpoint = createEndpoint(applied);

        const report = await executeBlackBox(
            [toServerStep('rebootPrimary', { action: 'reboot', target: 'primary' }, 1)],
            0,
            {
                dependencies: endpoint.dependencies,
                environment: { RALLAR_BB_SERVER_FAULTS_URL: FAULTS_URL },
                failFast: false
            }
        );

        expect(report.resultsByName.rebootPrimary[0].status).toBe('FAILURE');
        expect(report.resultsByName.rebootPrimary[0].result).toContain('A server step is invalid');
        expect(endpoint.posted).toEqual([]);
    });

    it('posts nothing in a dry run', async () => {
        const endpoint = createEndpoint(applied);

        const report = await executeBlackBox(
            [toServerStep('crashSecondary', { action: 'stop', target: 'secondary', mode: 'crash' }, 1)],
            0,
            {
                dependencies: endpoint.dependencies,
                environment: { RALLAR_BB_SERVER_FAULTS_URL: FAULTS_URL },
                dryRun: true
            }
        );

        expect(report.resultsByName.crashSecondary[0].status).toBe('SUCCESS');
        expect(endpoint.posted).toEqual([]);
    });

    it('fails the run when the servers a step faulted cannot be restored', async () => {
        const endpoint = createEndpoint((body) =>
            body.action === 'restore' ? Response.json({ outcome: 'invalid', issue: 'gone' }, { status: 400 }) : applied(body)
        );

        await expect(executeBlackBox(
            [toServerStep('crashSecondary', { action: 'stop', target: 'secondary', mode: 'crash' }, 1)],
            0,
            { dependencies: endpoint.dependencies, environment: { RALLAR_BB_SERVER_FAULTS_URL: FAULTS_URL } }
        )).rejects.toThrow('The run\'s API servers were not restored.');
    });
});
