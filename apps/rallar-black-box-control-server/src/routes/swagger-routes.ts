type JsonRecord = Record<string, unknown>;

const CONTROL_OPENAPI_SPEC: JsonRecord = {
    openapi: '3.1.0',
    info: {
        title: 'Rallar Black Box Control Server',
        version: '0.1.0',
        description:
            'Local orchestration API for browser-based Rallar black-box test agents. The server queues commands, dispatches them to SPA agents over WebSocket, and stores results, events, stats, reports, and heartbeats in memory.',
    },
    servers: [
        {
            url: 'http://localhost:5180',
            description: 'Local control server',
        },
    ],
    tags: [
        { name: 'Docs' },
        { name: 'Health' },
        { name: 'Runs' },
        { name: 'Commands' },
        { name: 'Reports' },
        { name: 'Tokens' },
        { name: 'Control WebSocket' },
    ],
    paths: {
        '/health': {
            get: {
                tags: ['Health'],
                summary: 'Read server health',
                responses: {
                    '200': {
                        description: 'Control server is ready.',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/HealthResponse' },
                            },
                        },
                    },
                },
            },
        },
        '/runs': {
            get: {
                tags: ['Runs'],
                summary: 'List run snapshots',
                responses: {
                    '200': {
                        description: 'All in-memory runs known by the control server.',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/ControlServerSnapshot' },
                            },
                        },
                    },
                },
            },
        },
        '/runs/{runId}': {
            get: {
                tags: ['Runs'],
                summary: 'Read one run snapshot',
                parameters: [{ $ref: '#/components/parameters/RunId' }],
                responses: {
                    '200': {
                        description: 'Run snapshot.',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/ControlRunSnapshot' },
                            },
                        },
                    },
                    '404': { $ref: '#/components/responses/NotFound' },
                },
            },
        },
        '/runs/{runId}/agents/{agentId}/commands': {
            post: {
                tags: ['Commands'],
                summary: 'Queue a command for a browser agent',
                description:
                    'Queues a rallar-bb-test command. If the agent is connected over `/control`, the command is dispatched immediately.',
                security: [{ bearerAuth: [] }, { runTokenHeader: [] }, { queryToken: [] }],
                parameters: [
                    { $ref: '#/components/parameters/RunId' },
                    { $ref: '#/components/parameters/AgentId' },
                ],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/EnqueueCommandRequest' },
                            examples: {
                                health: {
                                    summary: 'Health command',
                                    value: {
                                        commandId: 'health-1',
                                        command: {
                                            kind: 'health',
                                            commandId: 'health-1',
                                        },
                                    },
                                },
                                rtcConnect: {
                                    summary: 'RTC connect command',
                                    value: {
                                        commandId: 'rtc-connect-alice',
                                        command: {
                                            kind: 'rtc.connect',
                                            commandId: 'rtc-connect-alice',
                                            connection: 'aliceRtc',
                                            actor: 'alice',
                                            roomId: 'rallar-black-box-room',
                                            transport: 'realtime',
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                responses: {
                    '202': {
                        description: 'Command accepted and queued.',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/CommandAcceptedResponse' },
                            },
                        },
                    },
                    '400': { $ref: '#/components/responses/BadRequest' },
                    '401': { $ref: '#/components/responses/Unauthorized' },
                    '403': { $ref: '#/components/responses/Forbidden' },
                    '429': { $ref: '#/components/responses/TooManyRequests' },
                },
            },
        },
        '/runs/{runId}/agents/{agentId}/report': {
            post: {
                tags: ['Reports'],
                summary: 'Upload a browser-agent report envelope',
                security: [{ bearerAuth: [] }, { runTokenHeader: [] }, { queryToken: [] }],
                parameters: [
                    { $ref: '#/components/parameters/RunId' },
                    { $ref: '#/components/parameters/AgentId' },
                ],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/ControlEventEnvelope' },
                        },
                    },
                },
                responses: {
                    '202': {
                        description: 'Report accepted.',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/AcceptedResponse' },
                            },
                        },
                    },
                    '400': { $ref: '#/components/responses/BadRequest' },
                    '401': { $ref: '#/components/responses/Unauthorized' },
                },
            },
        },
        '/runs/{runId}/agents/{agentId}/tokens': {
            post: {
                tags: ['Tokens'],
                summary: 'Issue a run token for one agent',
                description:
                    'Requires the admin token when `RALLAR_BLACK_BOX_ADMIN_TOKEN` is configured. The issued token can authorize REST commands and WebSocket registration for the target run/agent.',
                security: [{ bearerAuth: [] }, { queryToken: [] }],
                parameters: [
                    { $ref: '#/components/parameters/RunId' },
                    { $ref: '#/components/parameters/AgentId' },
                ],
                requestBody: {
                    required: false,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/IssueTokenRequest' },
                        },
                    },
                },
                responses: {
                    '201': {
                        description: 'Run token issued.',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/ControlRunToken' },
                            },
                        },
                    },
                    '400': { $ref: '#/components/responses/BadRequest' },
                    '401': { $ref: '#/components/responses/Unauthorized' },
                },
            },
        },
        '/control': {
            get: {
                tags: ['Control WebSocket'],
                summary: 'Upgrade to browser-agent control WebSocket',
                description:
                    'Browser agents connect here, send a register envelope, receive queued commands, and stream results, events, stats, reports, and heartbeats back to the control server.',
                security: [{ bearerAuth: [] }, { runTokenHeader: [] }, { queryToken: [] }],
                responses: {
                    '101': { description: 'WebSocket upgrade accepted.' },
                    '401': { $ref: '#/components/responses/Unauthorized' },
                    '426': {
                        description: '`Upgrade: websocket` header missing.',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/ErrorResponse' },
                            },
                        },
                    },
                },
            },
        },
        '/api/openapi.json': {
            get: {
                tags: ['Docs'],
                summary: 'Read OpenAPI document',
                responses: {
                    '200': {
                        description: 'OpenAPI JSON document.',
                        content: {
                            'application/json': {
                                schema: { type: 'object' },
                            },
                        },
                    },
                },
            },
        },
        '/api/docs': {
            get: {
                tags: ['Docs'],
                summary: 'Open Swagger UI',
                responses: {
                    '200': {
                        description: 'Swagger UI HTML.',
                        content: {
                            'text/html': {
                                schema: { type: 'string' },
                            },
                        },
                    },
                },
            },
        },
    },
    components: {
        securitySchemes: {
            bearerAuth: {
                type: 'http',
                scheme: 'bearer',
                description: 'Admin token or run token, depending on endpoint configuration.',
            },
            runTokenHeader: {
                type: 'apiKey',
                in: 'header',
                name: 'X-Rallar-Run-Token',
                description: 'Run token issued for the target run and agent.',
            },
            queryToken: {
                type: 'apiKey',
                in: 'query',
                name: 'token',
                description: 'Token query parameter accepted by REST endpoints and `/control`.',
            },
        },
        parameters: {
            RunId: {
                name: 'runId',
                in: 'path',
                required: true,
                schema: { type: 'string' },
            },
            AgentId: {
                name: 'agentId',
                in: 'path',
                required: true,
                schema: { type: 'string' },
            },
        },
        responses: {
            BadRequest: {
                description: 'Invalid request.',
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/ErrorResponse' },
                    },
                },
            },
            Unauthorized: {
                description: 'Missing or invalid token.',
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/ErrorResponse' },
                    },
                },
            },
            Forbidden: {
                description: 'Rejected by server policy.',
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/ErrorResponse' },
                    },
                },
            },
            NotFound: {
                description: 'Resource not found.',
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/ErrorResponse' },
                    },
                },
            },
            TooManyRequests: {
                description: 'Command rate limit exceeded.',
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/ErrorResponse' },
                    },
                },
            },
        },
        schemas: {
            HealthResponse: {
                type: 'object',
                required: ['ok', 'app', 'protocolVersion'],
                properties: {
                    ok: { type: 'boolean' },
                    app: { type: 'string', enum: ['rallar-black-box-control-server'] },
                    protocolVersion: { type: 'integer', enum: [1] },
                },
            },
            ErrorResponse: {
                type: 'object',
                required: ['error'],
                properties: {
                    error: { type: 'string' },
                },
            },
            AcceptedResponse: {
                type: 'object',
                required: ['accepted'],
                properties: {
                    accepted: { type: 'boolean' },
                },
            },
            ControlServerSnapshot: {
                type: 'object',
                required: ['runs'],
                properties: {
                    runs: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/ControlRunSnapshot' },
                    },
                },
            },
            ControlRunSnapshot: {
                type: 'object',
                required: [
                    'runId',
                    'createdAtEpochMs',
                    'updatedAtEpochMs',
                    'agents',
                    'commands',
                    'results',
                    'events',
                    'stats',
                    'reports',
                    'heartbeats',
                ],
                properties: {
                    runId: { type: 'string' },
                    createdAtEpochMs: { type: 'integer' },
                    updatedAtEpochMs: { type: 'integer' },
                    agents: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/ControlAgentSnapshot' },
                    },
                    commands: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/ControlQueuedCommandSnapshot' },
                    },
                    results: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/ControlResultEnvelope' },
                    },
                    events: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/ControlEventEnvelope' },
                    },
                    stats: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/ControlEventEnvelope' },
                    },
                    reports: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/ControlEventEnvelope' },
                    },
                    heartbeats: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/ControlHeartbeatEnvelope' },
                    },
                },
            },
            ControlAgentSnapshot: {
                type: 'object',
                required: [
                    'runId',
                    'agentId',
                    'connected',
                    'connectionSequence',
                    'reconnectCount',
                    'receivedResultCount',
                    'receivedEventCount',
                    'completedCommandIds',
                    'resumeCompletedCommandIds',
                ],
                properties: {
                    runId: { type: 'string' },
                    agentId: { type: 'string' },
                    connected: { type: 'boolean' },
                    registeredAtEpochMs: { type: 'integer' },
                    disconnectedAtEpochMs: { type: 'integer' },
                    lastSeenAtEpochMs: { type: 'integer' },
                    lastHeartbeatAtEpochMs: { type: 'integer' },
                    status: { type: 'string' },
                    connectionSequence: { type: 'integer' },
                    reconnectCount: { type: 'integer' },
                    receivedResultCount: { type: 'integer' },
                    receivedEventCount: { type: 'integer' },
                    completedCommandIds: { type: 'array', items: { type: 'string' } },
                    resumeCompletedCommandIds: { type: 'array', items: { type: 'string' } },
                },
            },
            ControlQueuedCommandSnapshot: {
                type: 'object',
                required: ['envelope', 'queuedAtEpochMs', 'dispatchCount'],
                properties: {
                    envelope: { $ref: '#/components/schemas/ControlCommandEnvelope' },
                    queuedAtEpochMs: { type: 'integer' },
                    dispatchedAtEpochMs: { type: 'integer' },
                    completedAtEpochMs: { type: 'integer' },
                    dispatchCount: { type: 'integer' },
                },
            },
            EnqueueCommandRequest: {
                type: 'object',
                required: ['command'],
                properties: {
                    commandId: { type: 'string' },
                    command: { $ref: '#/components/schemas/RallarBlackBoxTestCommand' },
                    deadlineEpochMs: { type: 'integer' },
                },
            },
            CommandAcceptedResponse: {
                type: 'object',
                required: ['accepted', 'command'],
                properties: {
                    accepted: { type: 'boolean' },
                    command: { $ref: '#/components/schemas/ControlCommandEnvelope' },
                },
            },
            ControlCommandEnvelope: {
                type: 'object',
                required: ['kind', 'protocolVersion', 'runId', 'commandId', 'command'],
                properties: {
                    kind: { type: 'string', enum: ['command'] },
                    protocolVersion: { type: 'integer', enum: [1] },
                    runId: { type: 'string' },
                    agentId: { type: 'string' },
                    commandId: { type: 'string' },
                    command: { $ref: '#/components/schemas/RallarBlackBoxTestCommand' },
                    deadlineEpochMs: { type: 'integer' },
                },
            },
            ControlResultEnvelope: {
                type: 'object',
                required: ['kind', 'protocolVersion', 'runId', 'agentId', 'commandId', 'ok'],
                properties: {
                    kind: { type: 'string', enum: ['result'] },
                    protocolVersion: { type: 'integer', enum: [1] },
                    runId: { type: 'string' },
                    agentId: { type: 'string' },
                    commandId: { type: 'string' },
                    ok: { type: 'boolean' },
                    result: { type: 'object', additionalProperties: true },
                    error: { $ref: '#/components/schemas/ErrorResponse' },
                    replayed: { type: 'boolean' },
                },
            },
            ControlEventEnvelope: {
                type: 'object',
                required: ['kind', 'protocolVersion', 'runId', 'agentId', 'atEpochMs', 'payload'],
                properties: {
                    kind: { type: 'string', enum: ['event', 'diagnostic', 'stats', 'report'] },
                    protocolVersion: { type: 'integer', enum: [1] },
                    runId: { type: 'string' },
                    agentId: { type: 'string' },
                    atEpochMs: { type: 'integer' },
                    eventId: { type: 'string' },
                    commandId: { type: 'string' },
                    payload: {},
                },
            },
            ControlHeartbeatEnvelope: {
                type: 'object',
                required: ['kind', 'protocolVersion', 'runId', 'agentId', 'atEpochMs', 'status'],
                properties: {
                    kind: { type: 'string', enum: ['heartbeat'] },
                    protocolVersion: { type: 'integer', enum: [1] },
                    runId: { type: 'string' },
                    agentId: { type: 'string' },
                    atEpochMs: { type: 'integer' },
                    status: { type: 'string' },
                    lastCommandId: { type: 'string' },
                    lastEventAtEpochMs: { type: 'integer' },
                },
            },
            ControlRunToken: {
                type: 'object',
                required: ['runId', 'agentId', 'token', 'issuedAtEpochMs', 'expiresAtEpochMs'],
                properties: {
                    runId: { type: 'string' },
                    agentId: { type: 'string' },
                    token: { type: 'string' },
                    issuedAtEpochMs: { type: 'integer' },
                    expiresAtEpochMs: { type: 'integer' },
                },
            },
            IssueTokenRequest: {
                type: 'object',
                properties: {
                    ttlMs: {
                        type: 'integer',
                        minimum: 1,
                        description: 'Optional token lifetime in milliseconds.',
                    },
                },
            },
            RallarBlackBoxTestCommand: {
                type: 'object',
                required: ['kind'],
                properties: {
                    kind: {
                        type: 'string',
                        enum: [
                            'configure',
                            'recipe.load',
                            'recipe.run',
                            'recipe.cancel',
                            'rtc.connect',
                            'rtc.send',
                            'ws.open',
                            'ws.send',
                            'ws.close',
                            'http.request',
                            'health',
                            'stats',
                            'close',
                            'reset',
                        ],
                    },
                    commandId: { type: 'string' },
                    label: { type: 'string' },
                    deadlineEpochMs: { type: 'integer' },
                    timeoutMs: { type: 'integer' },
                    metadata: { type: 'object', additionalProperties: true },
                    config: { type: 'object', additionalProperties: true },
                    connection: { type: 'string' },
                    actor: { type: 'string' },
                    roomId: { type: 'string' },
                    transport: { type: 'string', enum: ['realtime', 'messages.rtc', 'ws', 'http'] },
                    rallar: { type: 'object', additionalProperties: true },
                    send: {},
                    expect: {},
                    url: { type: 'string' },
                    protocols: {
                        oneOf: [
                            { type: 'string' },
                            { type: 'array', items: { type: 'string' } },
                        ],
                    },
                    headers: { type: 'object', additionalProperties: { type: 'string' } },
                    data: {},
                    code: { type: 'integer' },
                    reason: { type: 'string' },
                    request: { type: 'object', additionalProperties: true },
                    response: { type: 'object', additionalProperties: true },
                    recipe: { type: 'object', additionalProperties: true },
                },
                additionalProperties: true,
            },
        },
    },
};

function serverUrl(request: Request): string {
    const url = new URL(request.url);
    return `${url.protocol}//${url.host}`;
}

export function controlOpenApiSpec(request: Request): JsonRecord {
    return {
        ...CONTROL_OPENAPI_SPEC,
        servers: [
            {
                url: serverUrl(request),
                description: 'Current control server',
            },
        ],
    };
}

function swaggerHtml(request: Request): string {
    const openApiUrl = '/api/openapi.json';
    const title = 'Rallar Black Box Control Server Docs';

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      body { margin: 0; background: #f8fafc; }
      .topbar { display: none; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.onload = function () {
        window.ui = SwaggerUIBundle({
          url: ${JSON.stringify(openApiUrl)},
          dom_id: '#swagger-ui',
          persistAuthorization: true,
          deepLinking: true,
          displayRequestDuration: true
        });
      };
    </script>
  </body>
</html>`;
}

export function handleSwaggerRoute(
    request: Request,
    url = new URL(request.url),
): Response | undefined {
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    if (!isRead) {
        return undefined;
    }

    if (
        url.pathname === '/api/openapi.json' ||
        url.pathname === '/openapi.json'
    ) {
        return jsonResponse(controlOpenApiSpec(request));
    }

    if (
        url.pathname === '/api/docs' ||
        url.pathname === '/swagger-ui' ||
        url.pathname === '/docs'
    ) {
        return htmlResponse(swaggerHtml(request));
    }

    return undefined;
}

export function swaggerFallbackResponse(): Response {
    return new Response(null, {
        status: 302,
        headers: responseHeaders(undefined, {
            Location: '/swagger-ui',
        }),
    });
}

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value, null, 2), {
        status,
        headers: responseHeaders('application/json'),
    });
}

function htmlResponse(value: string, status = 200): Response {
    return new Response(value, {
        status,
        headers: responseHeaders('text/html; charset=utf-8'),
    });
}

function responseHeaders(
    contentType?: string,
    extra: Readonly<Record<string, string>> = {},
): Headers {
    const headers = new Headers({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Rallar-Run-Token',
        ...extra,
    });
    if (contentType) {
        headers.set('Content-Type', contentType);
    }
    return headers;
}
