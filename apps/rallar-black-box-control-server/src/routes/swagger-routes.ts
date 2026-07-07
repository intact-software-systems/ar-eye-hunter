import {
  RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA,
  RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA,
} from '@shared-test/rallar-bb-test/schema.ts';
import { createControlResponseHeaders } from '../cors.ts';

type JsonRecord = Record<string, unknown>;
type SwaggerRouteOptions = Readonly<{
  corsOrigins?: readonly string[];
}>;

const CONTROL_OPENAPI_SPEC: JsonRecord = {
  openapi: '3.1.0',
  info: {
    title: 'Rallar Black Box Control Server',
    version: '0.1.0',
    description:
      'Local orchestration API for browser-based Rallar black-box test agents. The server queues commands, dispatches them to SPA agents over WebSocket, stores results, events, stats, reports, and heartbeats, and exports redacted run artifacts.',
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
    { name: 'Distributed Runs' },
    { name: 'Fleet' },
    { name: 'Commands' },
    { name: 'Reports' },
    { name: 'Tokens' },
    { name: 'Retention' },
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
        parameters: [
          { $ref: '#/components/parameters/LimitCommands' },
          { $ref: '#/components/parameters/LimitResults' },
          { $ref: '#/components/parameters/LimitEvents' },
          { $ref: '#/components/parameters/LimitStats' },
          { $ref: '#/components/parameters/LimitReports' },
          { $ref: '#/components/parameters/LimitHeartbeats' },
        ],
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
    '/distributed-runs': {
      get: {
        tags: ['Distributed Runs'],
        summary: 'List distributed run snapshots',
        responses: {
          '200': {
            description: 'Distributed runs known by the control server.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DistributedRunListResponse' },
              },
            },
          },
        },
      },
      post: {
        tags: ['Distributed Runs'],
        summary: 'Create a distributed recipe run',
        description:
          'Creates distributed orchestration metadata over a lower-level control run. Requires the admin token or a signed logged-in operator token when configured.',
        security: [{ bearerAuth: [] }, { queryToken: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/DistributedRunManifest' },
                  {
                    type: 'object',
                    required: ['manifest'],
                    properties: {
                      manifest: { $ref: '#/components/schemas/DistributedRunManifest' },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Distributed run created.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ControlDistributedRunSnapshot' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/distributed-runs/resolve-targets': {
      post: {
        tags: ['Distributed Runs'],
        summary: 'Preview distributed run target resolution',
        description:
          'Resolves target agents and derived roles for a distributed manifest without creating a run or queueing commands.',
        security: [{ bearerAuth: [] }, { queryToken: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/DistributedRunManifest' },
                  {
                    type: 'object',
                    required: ['manifest'],
                    properties: {
                      manifest: { $ref: '#/components/schemas/DistributedRunManifest' },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Resolved target preview.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DistributedTargetResolution' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/distributed-runs/{distributedRunId}': {
      get: {
        tags: ['Distributed Runs'],
        summary: 'Read one distributed run snapshot',
        parameters: [{ $ref: '#/components/parameters/DistributedRunId' }],
        responses: {
          '200': {
            description: 'Distributed run snapshot.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ControlDistributedRunSnapshot' },
              },
            },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/distributed-runs/{distributedRunId}/stage': {
      post: {
        tags: ['Distributed Runs'],
        summary: 'Stage a distributed run',
        description:
          'Queues recipe-load or preflight commands for target agents. Command results become the explicit readiness ACKs.',
        security: [{ bearerAuth: [] }, { queryToken: [] }],
        parameters: [{ $ref: '#/components/parameters/DistributedRunId' }],
        responses: {
          '202': {
            description: 'Staging commands queued.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ControlDistributedRunSnapshot' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { $ref: '#/components/responses/Conflict' },
          '429': { $ref: '#/components/responses/TooManyRequests' },
        },
      },
    },
    '/distributed-runs/{distributedRunId}/start': {
      post: {
        tags: ['Distributed Runs'],
        summary: 'Start a distributed run',
        description:
          'Queues recipe-run commands for target agents. Scheduled manifests pass the start deadline through to the command envelopes.',
        security: [{ bearerAuth: [] }, { queryToken: [] }],
        parameters: [{ $ref: '#/components/parameters/DistributedRunId' }],
        responses: {
          '202': {
            description: 'Start commands queued.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ControlDistributedRunSnapshot' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { $ref: '#/components/responses/Conflict' },
          '429': { $ref: '#/components/responses/TooManyRequests' },
        },
      },
    },
    '/distributed-runs/{distributedRunId}/cancel': {
      post: {
        tags: ['Distributed Runs'],
        summary: 'Cancel a distributed run',
        description:
          'Marks the distributed run cancelled and queues recipe-cancel commands for target agents.',
        security: [{ bearerAuth: [] }, { queryToken: [] }],
        parameters: [{ $ref: '#/components/parameters/DistributedRunId' }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  reason: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '202': {
            description: 'Distributed run cancelled.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ControlDistributedRunSnapshot' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
          '429': { $ref: '#/components/responses/TooManyRequests' },
        },
      },
    },
    '/distributed-runs/{distributedRunId}/artifacts': {
      get: {
        tags: ['Distributed Runs'],
        summary: 'Export a bounded distributed run artifact metadata bundle',
        parameters: [{ $ref: '#/components/parameters/DistributedRunId' }],
        responses: {
          '200': {
            description:
              'Bounded distributed run artifact metadata. Download full events/results evidence from the linked control-run JSONL endpoints.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ControlDistributedRunArtifactBundle' },
              },
            },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/fleet/reports': {
      get: {
        tags: ['Fleet'],
        summary: 'List fleet-oriented distributed run reports',
        description:
          'Returns persisted and lazily rebuilt fleet reports for terminal distributed runs, with optional filters for operator dashboards.',
        parameters: [
          {
            name: 'region',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          {
            name: 'provider',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          {
            name: 'recipeId',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          {
            name: 'groupId',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          {
            name: 'state',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          {
            name: 'fromEpochMs',
            in: 'query',
            required: false,
            schema: { type: 'integer' },
          },
          {
            name: 'toEpochMs',
            in: 'query',
            required: false,
            schema: { type: 'integer' },
          },
        ],
        responses: {
          '200': {
            description: 'Fleet report index and aggregate summary.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ControlFleetReportsResponse' },
              },
            },
          },
        },
      },
    },
    '/fleet/reports/rebuild': {
      post: {
        tags: ['Fleet'],
        summary: 'Rebuild fleet report index',
        description:
          'Recomputes persisted fleet reports for terminal distributed runs. Requires the admin token or a signed logged-in operator token when configured.',
        security: [{ bearerAuth: [] }, { queryToken: [] }],
        responses: {
          '200': {
            description: 'Rebuilt fleet report index and aggregate summary.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ControlFleetReportsResponse' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/fleet/reports/{distributedRunId}': {
      get: {
        tags: ['Fleet'],
        summary: 'Read one fleet run report',
        parameters: [{ $ref: '#/components/parameters/DistributedRunId' }],
        responses: {
          '200': {
            description: 'Fleet run report for one distributed run.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ControlFleetRunReport' },
              },
            },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/fleet/reports/{distributedRunId}/artifacts': {
      get: {
        tags: ['Fleet'],
        summary: 'Export a shareable fleet run report bundle',
        parameters: [{ $ref: '#/components/parameters/DistributedRunId' }],
        responses: {
          '200': {
            description: 'Fleet report export files.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ControlFleetReportBundle' },
              },
            },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/retention/cleanup': {
      post: {
        tags: ['Retention'],
        summary: 'Apply configured run retention',
        description:
          'Deletes the oldest in-memory runs beyond `RALLAR_BLACK_BOX_RETENTION_MAX_RUNS`. Requires the admin token or a signed logged-in operator token when configured.',
        security: [{ bearerAuth: [] }, { queryToken: [] }],
        responses: {
          '200': {
            description: 'Retention cleanup result.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RetentionCleanupResponse' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/runs/{runId}': {
      get: {
        tags: ['Runs'],
        summary: 'Read one run snapshot',
        parameters: [
          { $ref: '#/components/parameters/RunId' },
          { $ref: '#/components/parameters/LimitCommands' },
          { $ref: '#/components/parameters/LimitResults' },
          { $ref: '#/components/parameters/LimitEvents' },
          { $ref: '#/components/parameters/LimitStats' },
          { $ref: '#/components/parameters/LimitReports' },
          { $ref: '#/components/parameters/LimitHeartbeats' },
        ],
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
      delete: {
        tags: ['Runs'],
        summary: 'Delete one run',
        description:
          'Removes the in-memory run and closes any connected browser-agent sockets for that run. Requires the admin token or a signed logged-in operator token when configured.',
        security: [{ bearerAuth: [] }, { queryToken: [] }],
        parameters: [{ $ref: '#/components/parameters/RunId' }],
        responses: {
          '200': {
            description: 'Run deleted.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeleteRunResponse' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/runs/{runId}/reset': {
      post: {
        tags: ['Runs'],
        summary: 'Reset one run snapshot',
        description:
          'Clears queued commands, results, events, stats, reports, heartbeats, and agent counters while keeping known agents and run tokens. Requires the admin token or a signed logged-in operator token when configured.',
        security: [{ bearerAuth: [] }, { queryToken: [] }],
        parameters: [{ $ref: '#/components/parameters/RunId' }],
        responses: {
          '200': {
            description: 'Run reset.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ResetRunResponse' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/runs/{runId}/commands': {
      post: {
        tags: ['Commands'],
        summary: 'Queue a command for multiple browser agents',
        description:
          'Queues one command per selected agent. Requires the admin token or a signed logged-in operator token when configured and is intended for run-manager bulk orchestration.',
        security: [{ bearerAuth: [] }, { queryToken: [] }],
        parameters: [{ $ref: '#/components/parameters/RunId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/BulkEnqueueCommandRequest' },
            },
          },
        },
        responses: {
          '202': {
            description: 'Commands accepted and queued.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/BulkCommandAcceptedResponse' },
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
    '/runs/{runId}/artifacts': {
      get: {
        tags: ['Reports'],
        summary: 'Export a run artifact bundle',
        description:
          'Returns bounded redacted report.json, events.jsonl preview, failures.json, and metadata.json strings for attaching failed runs to issues or importing into the SPA artifact browser. Download full events/results evidence from the JSONL endpoints.',
        parameters: [{ $ref: '#/components/parameters/RunId' }],
        responses: {
          '200': {
            description: 'Control run artifact bundle.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ControlRunArtifactBundle' },
              },
            },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/runs/{runId}/artifacts/{fileName}': {
      get: {
        tags: ['Reports'],
        summary: 'Export one run artifact file',
        parameters: [
          { $ref: '#/components/parameters/RunId' },
          { $ref: '#/components/parameters/ArtifactFileName' },
        ],
        responses: {
          '200': {
            description: 'Artifact file content.',
            content: {
              'application/json': { schema: { type: 'object' } },
              'application/x-ndjson': { schema: { type: 'string' } },
            },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/runs/{runId}/events.jsonl': {
      get: {
        tags: ['Reports'],
        summary: 'Export run events as JSONL',
        parameters: [{ $ref: '#/components/parameters/RunId' }],
        responses: {
          '200': {
            description: 'JSONL event stream.',
            content: {
              'application/x-ndjson': { schema: { type: 'string' } },
            },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/runs/{runId}/results.jsonl': {
      get: {
        tags: ['Reports'],
        summary: 'Export run results as JSONL',
        parameters: [{ $ref: '#/components/parameters/RunId' }],
        responses: {
          '200': {
            description: 'JSONL result stream.',
            content: {
              'application/x-ndjson': { schema: { type: 'string' } },
            },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/runs/{runId}/failure-bundle': {
      get: {
        tags: ['Reports'],
        summary: 'Export a copyable failure bundle',
        parameters: [{ $ref: '#/components/parameters/RunId' }],
        responses: {
          '200': {
            description: 'Failure-focused report bundle.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ControlRunFailureBundle' },
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
          'Requires the admin token or a signed logged-in operator token when configured. The issued token can authorize REST commands and WebSocket registration for the target run/agent.',
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
      DistributedRunId: {
        name: 'distributedRunId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
      ArtifactFileName: {
        name: 'fileName',
        in: 'path',
        required: true,
        schema: {
          type: 'string',
          enum: ['report.json', 'results.jsonl', 'events.jsonl', 'failures.json', 'metadata.json'],
        },
      },
      LimitCommands: {
        name: 'limitCommands',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 0 },
        description: 'Return only the most recent queued command snapshots.',
      },
      LimitResults: {
        name: 'limitResults',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 0 },
        description: 'Return only the most recent command results.',
      },
      LimitEvents: {
        name: 'limitEvents',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 0 },
        description: 'Return only the most recent events.',
      },
      LimitStats: {
        name: 'limitStats',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 0 },
        description: 'Return only the most recent stats envelopes.',
      },
      LimitReports: {
        name: 'limitReports',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 0 },
        description: 'Return only the most recent report envelopes.',
      },
      LimitHeartbeats: {
        name: 'limitHeartbeats',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 0 },
        description: 'Return only the most recent heartbeat envelopes.',
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
      Conflict: {
        description: 'Resource state does not allow the requested action.',
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
          distributedRuns: {
            type: 'array',
            items: { $ref: '#/components/schemas/ControlDistributedRunSnapshot' },
          },
          fleetReports: {
            type: 'array',
            items: { $ref: '#/components/schemas/ControlFleetRunReport' },
          },
        },
      },
      DistributedRunListResponse: {
        type: 'object',
        required: ['distributedRuns'],
        properties: {
          distributedRuns: {
            type: 'array',
            items: { $ref: '#/components/schemas/ControlDistributedRunSnapshot' },
          },
        },
      },
      DistributedRunManifest: openApiJsonSchema(
        RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA,
        '#/components/schemas/DistributedRunManifest',
      ),
      ControlDistributedRunSnapshot: {
        type: 'object',
        required: [
          'distributedRunId',
          'controlRunId',
          'manifest',
          'state',
          'createdAtEpochMs',
          'updatedAtEpochMs',
          'targetAgentIds',
          'commandLinks',
          'rollup',
        ],
        properties: {
          distributedRunId: { type: 'string' },
          controlRunId: { type: 'string' },
          manifest: { $ref: '#/components/schemas/DistributedRunManifest' },
          state: {
            type: 'string',
            enum: [
              'draft',
              'resolving-targets',
              'staging',
              'waiting-for-ack',
              'waiting-for-barrier',
              'ready',
              'running',
              'passed',
              'failed',
              'cancelled',
              'timed-out',
            ],
          },
          createdAtEpochMs: { type: 'integer' },
          updatedAtEpochMs: { type: 'integer' },
          stagedAtEpochMs: { type: 'integer' },
          barrierStartedAtEpochMs: { type: 'integer' },
          barrierCompletedAtEpochMs: { type: 'integer' },
          startedAtEpochMs: { type: 'integer' },
          cancelledAtEpochMs: { type: 'integer' },
          completedAtEpochMs: { type: 'integer' },
          targetAgentIds: { type: 'array', items: { type: 'string' } },
          targetResolution: { $ref: '#/components/schemas/DistributedTargetResolution' },
          commandLinks: {
            type: 'array',
            items: { $ref: '#/components/schemas/ControlDistributedRunCommandLink' },
          },
          rollup: { $ref: '#/components/schemas/ControlDistributedRunRollup' },
          error: { type: 'object', additionalProperties: true },
        },
      },
      ControlDistributedRunCommandLink: {
        type: 'object',
        required: ['phase', 'agentId', 'commandId', 'queuedAtEpochMs'],
        properties: {
          phase: { type: 'string', enum: ['stage', 'barrier', 'start', 'cancel'] },
          agentId: { type: 'string' },
          commandId: { type: 'string' },
          recipeId: { type: 'string' },
          role: { type: 'string' },
          queuedAtEpochMs: { type: 'integer' },
        },
      },
      ControlDistributedRunRollup: {
        type: 'object',
        required: ['state', 'ok', 'summary', 'failures'],
        properties: {
          state: { type: 'string' },
          ok: { type: 'boolean' },
          summary: { type: 'object', additionalProperties: true },
          failures: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
          },
        },
      },
      DistributedTargetResolution: {
        type: 'object',
        required: [
          'group',
          'resolvedAtEpochMs',
          'staleAfterMs',
          'targetPolicyMode',
          'targetAgentIds',
          'roleAssignments',
          'blockers',
          'summary',
        ],
        properties: {
          group: { type: 'object', additionalProperties: true },
          resolvedAtEpochMs: { type: 'integer' },
          staleAfterMs: { type: 'integer' },
          targetPolicyMode: { type: 'string' },
          targetAgentIds: { type: 'array', items: { type: 'string' } },
          roleAssignments: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
          },
          blockers: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
          },
          summary: { type: 'object', additionalProperties: true },
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
          identity: { $ref: '#/components/schemas/ControlAgentIdentity' },
          connectionSequence: { type: 'integer' },
          reconnectCount: { type: 'integer' },
          receivedResultCount: { type: 'integer' },
          receivedEventCount: { type: 'integer' },
          completedCommandIds: { type: 'array', items: { type: 'string' } },
          resumeCompletedCommandIds: { type: 'array', items: { type: 'string' } },
        },
      },
      ControlAgentIdentity: {
        type: 'object',
        description:
          'Latest Rallar identity metadata reported by a browser control agent. Used for distributed recipe target resolution.',
        properties: {
          principalId: { type: 'string' },
          clientId: { type: 'string' },
          username: { type: 'string' },
          sessionId: { type: 'string' },
          clientInstanceId: { type: 'string' },
          applicationId: { type: 'string' },
          workspaceId: { type: 'string' },
          groupId: { type: 'string' },
          providerMode: { type: 'string' },
          browserLabel: { type: 'string' },
          sessionLabel: { type: 'string' },
          region: { type: 'string' },
          provider: { type: 'string' },
          datacenter: { type: 'string' },
          hostId: { type: 'string' },
          agentPoolId: { type: 'string' },
          deploymentId: { type: 'string' },
          browserName: { type: 'string' },
          browserVersion: { type: 'string' },
          os: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          location: { $ref: '#/components/schemas/RallarBlackBoxGeoLocation' },
          capabilities: {
            type: 'object',
            properties: {
              crdt: {
                type: 'object',
                required: ['supported'],
                properties: {
                  supported: { type: 'boolean' },
                  transports: {
                    type: 'array',
                    items: {
                      type: 'string',
                      enum: [
                        'local-only',
                        'ws',
                        'rtc',
                        'ws-then-rtc',
                        'rtc-with-ws-fallback',
                      ],
                    },
                  },
                  runtimeSurface: { type: 'string' },
                  apiBaseUrlConfigured: { type: 'boolean' },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
          updatedAtEpochMs: { type: 'integer' },
        },
        additionalProperties: false,
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
      BulkEnqueueCommandRequest: {
        type: 'object',
        required: ['agentIds', 'command'],
        properties: {
          agentIds: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' },
          },
          commandId: {
            type: 'string',
            description:
              'Exact command id when one agent is targeted; used as a prefix when multiple agents are targeted.',
          },
          commandIdPrefix: {
            type: 'string',
            description: 'Optional command id prefix for generated per-agent command ids.',
          },
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
      BulkCommandAcceptedResponse: {
        type: 'object',
        required: ['accepted', 'commands'],
        properties: {
          accepted: { type: 'boolean' },
          commands: {
            type: 'array',
            items: { $ref: '#/components/schemas/ControlCommandEnvelope' },
          },
        },
      },
      ResetRunResponse: {
        type: 'object',
        required: ['reset', 'run'],
        properties: {
          reset: { type: 'boolean' },
          run: { $ref: '#/components/schemas/ControlRunSnapshot' },
        },
      },
      DeleteRunResponse: {
        type: 'object',
        required: ['deleted', 'runId'],
        properties: {
          deleted: { type: 'boolean' },
          runId: { type: 'string' },
        },
      },
      RetentionCleanupResponse: {
        type: 'object',
        required: ['deletedRunIds', 'retainedRuns', 'maxRuns'],
        properties: {
          deletedRunIds: { type: 'array', items: { type: 'string' } },
          retainedRuns: { type: 'integer' },
          maxRuns: { type: 'integer' },
        },
      },
      ControlRunArtifactBundle: {
        type: 'object',
        required: ['artifactSchemaVersion', 'runId', 'generatedAtEpochMs', 'files'],
        properties: {
          artifactSchemaVersion: { type: 'integer', enum: [1] },
          runId: { type: 'string' },
          generatedAtEpochMs: { type: 'integer' },
          files: {
            type: 'object',
            required: [
              'report.json',
              'results.jsonl',
              'events.jsonl',
              'failures.json',
              'metadata.json',
            ],
            properties: {
              'report.json': { type: 'string' },
              'results.jsonl': { type: 'string' },
              'events.jsonl': { type: 'string' },
              'failures.json': { type: 'string' },
              'metadata.json': { type: 'string' },
            },
          },
        },
      },
      ControlDistributedRunArtifactBundle: {
        type: 'object',
        required: ['artifactSchemaVersion', 'distributedRunId', 'generatedAtEpochMs', 'files'],
        properties: {
          artifactSchemaVersion: { type: 'integer', enum: [1, 2] },
          distributedRunId: { type: 'string' },
          generatedAtEpochMs: { type: 'integer' },
          files: {
            type: 'object',
            required: ['distributed-run.json', 'manifest.json', 'control-run.json'],
            properties: {
              'distributed-run.json': { type: 'string' },
              'manifest.json': { type: 'string' },
              'target-resolution.json': { type: 'string' },
              'control-run.json': { type: 'string' },
              'report.json': { type: 'string' },
              'results.jsonl': { type: 'string' },
              'events.jsonl': { type: 'string' },
              'failures.json': { type: 'string' },
              'metadata.json': { type: 'string' },
            },
          },
        },
      },
      ControlFleetReportsResponse: {
        type: 'object',
        required: ['reports', 'aggregate'],
        properties: {
          reports: {
            type: 'array',
            items: { $ref: '#/components/schemas/ControlFleetRunReport' },
          },
          aggregate: { $ref: '#/components/schemas/ControlFleetAggregateReport' },
        },
      },
      ControlFleetAggregateReport: {
        type: 'object',
        required: [
          'generatedAtEpochMs',
          'reportCount',
          'runCount',
          'agentCount',
          'regionCount',
          'passRate',
          'staleAgentCount',
          'flakyAgentCount',
          'failureGroupCount',
          'timing',
          'regions',
          'failureSignatures',
        ],
        properties: {
          generatedAtEpochMs: { type: 'integer' },
          reportCount: { type: 'integer' },
          runCount: { type: 'integer' },
          agentCount: { type: 'integer' },
          regionCount: { type: 'integer' },
          passRate: { type: 'number' },
          staleAgentCount: { type: 'integer' },
          flakyAgentCount: { type: 'integer' },
          failureGroupCount: { type: 'integer' },
          timing: {
            type: 'object',
            properties: {
              runs: { $ref: '#/components/schemas/ControlFleetTimingDistribution' },
              commands: { $ref: '#/components/schemas/ControlFleetTimingDistribution' },
            },
          },
          regions: {
            type: 'array',
            items: { $ref: '#/components/schemas/ControlFleetRegionSummary' },
          },
          failureSignatures: {
            type: 'array',
            items: { $ref: '#/components/schemas/ControlFleetFailureSignature' },
          },
        },
      },
      ControlFleetRunReport: {
        type: 'object',
        required: [
          'fleetReportSchemaVersion',
          'distributedRunId',
          'controlRunId',
          'generatedAtEpochMs',
          'state',
          'ok',
          'group',
          'recipeIds',
          'summary',
          'timing',
          'agents',
          'regions',
          'failureSignatures',
          'artifactRefs',
        ],
        properties: {
          fleetReportSchemaVersion: { type: 'integer', enum: [1] },
          distributedRunId: { type: 'string' },
          controlRunId: { type: 'string' },
          generatedAtEpochMs: { type: 'integer' },
          state: { type: 'string' },
          ok: { type: 'boolean' },
          group: {
            type: 'object',
            required: ['applicationId', 'workspaceId', 'groupId'],
            properties: {
              applicationId: { type: 'string' },
              workspaceId: { type: 'string' },
              groupId: { type: 'string' },
            },
          },
          recipeIds: { type: 'array', items: { type: 'string' } },
          runDurationMs: { type: 'number' },
          summary: {
            type: 'object',
            required: [
              'agents',
              'regions',
              'passed',
              'failed',
              'missing',
              'flaky',
              'stale',
              'passRate',
              'failureGroups',
            ],
            properties: {
              agents: { type: 'integer' },
              regions: { type: 'integer' },
              passed: { type: 'integer' },
              failed: { type: 'integer' },
              missing: { type: 'integer' },
              flaky: { type: 'integer' },
              stale: { type: 'integer' },
              passRate: { type: 'number' },
              failureGroups: { type: 'integer' },
            },
          },
          timing: {
            type: 'object',
            properties: {
              run: { $ref: '#/components/schemas/ControlFleetTimingDistribution' },
              commands: { $ref: '#/components/schemas/ControlFleetTimingDistribution' },
            },
          },
          agents: {
            type: 'array',
            items: { $ref: '#/components/schemas/ControlFleetAgentRunOutcome' },
          },
          regions: {
            type: 'array',
            items: { $ref: '#/components/schemas/ControlFleetRegionSummary' },
          },
          failureSignatures: {
            type: 'array',
            items: { $ref: '#/components/schemas/ControlFleetFailureSignature' },
          },
          artifactRefs: {
            type: 'object',
            required: ['distributedRun', 'controlRun', 'fleetReport'],
            properties: {
              distributedRun: { type: 'string' },
              controlRun: { type: 'string' },
              fleetReport: { type: 'string' },
            },
          },
        },
      },
      ControlFleetAgentRunOutcome: {
        type: 'object',
        required: [
          'agentId',
          'label',
          'state',
          'ok',
          'missing',
          'flaky',
          'stale',
          'commandCount',
          'failedCommandCount',
          'resultCount',
          'eventCount',
          'diagnosticCount',
          'reconnectCount',
          'failureSignatureIds',
        ],
        properties: {
          agentId: { type: 'string' },
          label: { $ref: '#/components/schemas/ControlFleetAgentLabel' },
          state: {
            type: 'string',
            enum: ['passed', 'failed', 'missing', 'running', 'cancelled', 'timed-out', 'unknown'],
          },
          ok: { type: 'boolean' },
          missing: { type: 'boolean' },
          flaky: { type: 'boolean' },
          stale: { type: 'boolean' },
          commandCount: { type: 'integer' },
          failedCommandCount: { type: 'integer' },
          resultCount: { type: 'integer' },
          eventCount: { type: 'integer' },
          diagnosticCount: { type: 'integer' },
          reconnectCount: { type: 'integer' },
          durationMs: { type: 'number' },
          lastHeartbeatAtEpochMs: { type: 'integer' },
          failureSignatureIds: { type: 'array', items: { type: 'string' } },
        },
      },
      ControlFleetAgentLabel: {
        type: 'object',
        required: ['agentId'],
        properties: {
          agentId: { type: 'string' },
          region: { type: 'string' },
          provider: { type: 'string' },
          datacenter: { type: 'string' },
          hostId: { type: 'string' },
          agentPoolId: { type: 'string' },
          deploymentId: { type: 'string' },
          browserName: { type: 'string' },
          browserVersion: { type: 'string' },
          os: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          location: { $ref: '#/components/schemas/RallarBlackBoxGeoLocation' },
        },
      },
      RallarBlackBoxGeoLocation: {
        type: 'object',
        required: ['latitude', 'longitude'],
        properties: {
          latitude: {
            type: 'number',
            minimum: -90,
            maximum: 90,
          },
          longitude: {
            type: 'number',
            minimum: -180,
            maximum: 180,
          },
          label: { type: 'string' },
          precision: {
            type: 'string',
            enum: ['exact', 'approximate'],
          },
        },
        additionalProperties: false,
      },
      ControlFleetRegionSummary: {
        type: 'object',
        required: [
          'region',
          'agentCount',
          'passed',
          'failed',
          'missing',
          'flaky',
          'stale',
          'passRate',
          'timing',
        ],
        properties: {
          region: { type: 'string' },
          provider: { type: 'string' },
          agentCount: { type: 'integer' },
          passed: { type: 'integer' },
          failed: { type: 'integer' },
          missing: { type: 'integer' },
          flaky: { type: 'integer' },
          stale: { type: 'integer' },
          passRate: { type: 'number' },
          timing: { $ref: '#/components/schemas/ControlFleetTimingDistribution' },
          dominantFailureSignatureId: { type: 'string' },
        },
      },
      ControlFleetFailureSignature: {
        type: 'object',
        required: [
          'signatureId',
          'category',
          'title',
          'normalizedMessage',
          'count',
          'affectedAgents',
          'affectedRegions',
          'affectedRuns',
          'likelyCause',
          'nextAction',
        ],
        properties: {
          signatureId: { type: 'string' },
          category: {
            type: 'string',
            enum: [
              'targeting',
              'readiness',
              'barrier',
              'command',
              'diagnostic',
              'runtime',
              'unknown',
            ],
          },
          title: { type: 'string' },
          normalizedMessage: { type: 'string' },
          code: { type: 'string' },
          recipeId: { type: 'string' },
          commandKind: { type: 'string' },
          diagnosticTypeId: { type: 'string' },
          transport: { type: 'string' },
          count: { type: 'integer' },
          firstSeenAtEpochMs: { type: 'integer' },
          lastSeenAtEpochMs: { type: 'integer' },
          affectedAgents: { type: 'array', items: { type: 'string' } },
          affectedRegions: { type: 'array', items: { type: 'string' } },
          affectedRuns: { type: 'array', items: { type: 'string' } },
          likelyCause: { type: 'string' },
          nextAction: { type: 'string' },
        },
      },
      ControlFleetTimingDistribution: {
        type: 'object',
        required: ['count'],
        properties: {
          count: { type: 'integer' },
          minMs: { type: 'number' },
          p50Ms: { type: 'number' },
          p90Ms: { type: 'number' },
          p95Ms: { type: 'number' },
          maxMs: { type: 'number' },
        },
      },
      ControlFleetReportBundle: {
        type: 'object',
        required: ['fleetReportSchemaVersion', 'distributedRunId', 'generatedAtEpochMs', 'files'],
        properties: {
          fleetReportSchemaVersion: { type: 'integer', enum: [1] },
          distributedRunId: { type: 'string' },
          generatedAtEpochMs: { type: 'integer' },
          files: {
            type: 'object',
            required: [
              'fleet-report.json',
              'summary.md',
              'agent-results.csv',
              'failure-signatures.csv',
            ],
            properties: {
              'fleet-report.json': { type: 'string' },
              'summary.md': { type: 'string' },
              'agent-results.csv': { type: 'string' },
              'failure-signatures.csv': { type: 'string' },
            },
          },
        },
      },
      ControlRunFailureBundle: {
        type: 'object',
        required: ['summary', 'failures', 'outputs'],
        properties: {
          summary: { type: 'object', additionalProperties: true },
          failures: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
          },
          outputs: { type: 'object', additionalProperties: true },
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
          identity: { $ref: '#/components/schemas/ControlAgentIdentity' },
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
      RallarBlackBoxTestCommand: openApiJsonSchema(
        RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA,
        '#/components/schemas/RallarBlackBoxTestCommand',
      ),
    },
  },
};

function openApiJsonSchema(schema: JsonRecord, selfRef: string): JsonRecord {
  return cloneJsonSchema(schema, selfRef, []) as JsonRecord;
}

function cloneJsonSchema(
  value: unknown,
  selfRef: string,
  ancestors: readonly unknown[],
): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }

  if (ancestors.includes(value)) {
    if (
      value === RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA ||
      value === RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA.oneOf
    ) {
      return { $ref: '#/components/schemas/RallarBlackBoxTestCommand' };
    }
    if (
      value === RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA ||
      value === RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA.oneOf
    ) {
      return { $ref: '#/components/schemas/DistributedRunManifest' };
    }
    return { $ref: selfRef };
  }

  const nextAncestors = [...ancestors, value];
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonSchema(item, selfRef, nextAncestors));
  }

  const record = value as JsonRecord;
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [
      key,
      cloneJsonSchema(child, selfRef, nextAncestors),
    ]),
  );
}

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

function swaggerHtml(): string {
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
  options: SwaggerRouteOptions = {},
): Response | undefined {
  const isRead = request.method === 'GET' || request.method === 'HEAD';
  if (!isRead) {
    return undefined;
  }

  if (
    url.pathname === '/api/openapi.json' ||
    url.pathname === '/openapi.json'
  ) {
    return jsonResponse(controlOpenApiSpec(request), 200, request, options);
  }

  if (
    url.pathname === '/api/docs' ||
    url.pathname === '/swagger-ui' ||
    url.pathname === '/docs'
  ) {
    return htmlResponse(swaggerHtml(), 200, request, options);
  }

  return undefined;
}

export function swaggerFallbackResponse(
  request?: Request,
  options: SwaggerRouteOptions = {},
): Response {
  return new Response(null, {
    status: 302,
    headers: responseHeaders(request, {
      extra: {
        Location: '/swagger-ui',
      },
      corsOrigins: options.corsOrigins,
    }),
  });
}

function jsonResponse(
  value: unknown,
  status = 200,
  request?: Request,
  options: SwaggerRouteOptions = {},
): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: responseHeaders(request, {
      contentType: 'application/json',
      corsOrigins: options.corsOrigins,
    }),
  });
}

function htmlResponse(
  value: string,
  status = 200,
  request?: Request,
  options: SwaggerRouteOptions = {},
): Response {
  return new Response(value, {
    status,
    headers: responseHeaders(request, {
      contentType: 'text/html; charset=utf-8',
      corsOrigins: options.corsOrigins,
    }),
  });
}

function responseHeaders(
  request: Request | undefined,
  options: Readonly<{
    contentType?: string;
    extra?: Readonly<Record<string, string>>;
    corsOrigins?: readonly string[];
  }> = {},
): Headers {
  return createControlResponseHeaders(request, options);
}
