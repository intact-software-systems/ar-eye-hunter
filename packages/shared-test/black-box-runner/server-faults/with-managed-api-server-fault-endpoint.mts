import type { ApiJsonValue } from '../../../shared/api/api-json-value.ts';
import type { ManagedApiServerFaults } from './managed-api-server-faults.mts';
import { decodeServerFaultCommand, type ServerFaultReply } from './server-fault-command.ts';

const STATUS_BY_OUTCOME: Readonly<Record<ServerFaultReply['outcome'], number>> = {
    applied: 200,
    refused: 409,
    invalid: 400
};

function toServerFaultResponse(reply: ServerFaultReply): Response {
    return Response.json(reply, { status: STATUS_BY_OUTCOME[reply.outcome] });
}

async function readJsonBody(request: Request): Promise<ApiJsonValue | undefined> {
    const text = await request.text();
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}

export async function answerServerFaultRequest(
    faults: Pick<ManagedApiServerFaults, 'apply'>,
    request: Request
): Promise<Response> {
    if (request.method !== 'POST') {
        return toServerFaultResponse({ outcome: 'invalid', issue: 'a server fault is a POST' });
    }
    const command = decodeServerFaultCommand(await readJsonBody(request));
    return await command.fold(
        async (issue) => toServerFaultResponse({ outcome: 'invalid', issue }),
        async (decoded) =>
            (await faults.apply(decoded)).fold(
                (refusal) => toServerFaultResponse({ outcome: 'refused', refusal }),
                (applied) => toServerFaultResponse({ outcome: 'applied', applied })
            )
    );
}

/**
 * Serves the run's faults on a loopback port the system picks, for the recipe processes the run starts:
 * they are two processes below the lifecycle owner and reach it by nothing else.
 */
export async function withManagedApiServerFaultEndpoint<Result>(
    faults: Pick<ManagedApiServerFaults, 'apply'>,
    run: (url: string) => Promise<Result>
): Promise<Result> {
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        // A restart answers once the replacement is ready, which outlasts the default idle limit.
        idleTimeout: 0,
        fetch: (request) => answerServerFaultRequest(faults, request)
    });
    try {
        return await run(`http://127.0.0.1:${server.port}`);
    }
    finally {
        await server.stop(true);
    }
}
