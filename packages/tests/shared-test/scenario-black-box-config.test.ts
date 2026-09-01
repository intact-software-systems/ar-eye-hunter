import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scenarioCliPath = fileURLToPath(
    new URL('../../shared-test/black-box-runner/scenario-black-box.ts', import.meta.url)
);

async function writeTempConfig(config: unknown): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'scenario-black-box-'));

    await writeFile(
        path.join(dir, 'config.json'),
        JSON.stringify(config, null, 2)
    );

    return dir;
}

async function runScenarioCli(args: string[], env: Record<string, string | undefined> = {}): Promise<{
    code: number;
    stdout: string;
    stderr: string;
}> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            'deno',
            ['run', '-A', scenarioCliPath, ...args],
            {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    ...env
                }
            }
        );

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });

        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('error', reject);

        child.on('close', (code) => {
            resolve({
                code: code ?? 0,
                stdout,
                stderr
            });
        });
    });
}

async function startHeaderEchoServer(): Promise<{ baseUrl: string; close: () => Promise<void>; }> {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        response.writeHead(200, {
            'content-type': 'application/json'
        });
        response.end(JSON.stringify({
            method: request.method,
            url: request.url,
            headers: request.headers
        }));
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Header echo server did not expose a TCP address.');
    }

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => closeServer(server)
    };
}

async function tryStartHeaderEchoServer(): Promise<{ baseUrl: string; close: () => Promise<void>; } | undefined> {
    try {
        return await startHeaderEchoServer();
    }
    catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code?: unknown; }).code)
            : '';
        if (code === 'EPERM' || code === 'EACCES') {
            return undefined;
        }
        throw error;
    }
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

describe('scenario-black-box CLI', () => {
    it('explains a valid recipe without executing network calls', async () => {
        const workingDirectory = await writeTempConfig({
            variables: {
                apiBaseUrl: 'http://localhost:8080'
            },
            connections: {
                api: {
                    type: 'http',
                    baseUrl: '{apiBaseUrl}'
                }
            },
            steps: [
                {
                    name: 'health',
                    type: 'http',
                    connection: 'api',
                    request: {
                        method: 'GET',
                        path: '/health'
                    },
                    expect: {
                        status: 200
                    }
                }
            ]
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--explain'
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const preflight = JSON.parse(result.stdout);

        expect(preflight.ok).toBe(true);
        expect(preflight.profile).toBe('compat');
        expect(preflight.summary.generatedOperationCount).toBe(1);
        expect(preflight.providerModes).toContain('http');
        expect(preflight.connections).toMatchObject({
            defined: ['api'],
            referenced: ['api'],
            missing: []
        });
        expect(preflight.operations[0]).toMatchObject({
            name: 'health',
            transport: 'HTTP',
            connection: 'api',
            path: 'http://localhost:8080/health'
        });
    });

    it('expands static recipe fragments during explain mode', async () => {
        const workingDirectory = await writeTempConfig({
            variables: {
                roomId: 'room-from-parent'
            },
            fragments: {
                inlineAssert: {
                    steps: [
                        {
                            name: 'assertActor',
                            type: 'assert',
                            actual: {
                                actor: '{actorValue}'
                            },
                            expect: {
                                body: {
                                    actor: 'alice'
                                }
                            }
                        }
                    ]
                }
            },
            steps: [
                {
                    include: {
                        path: 'fragments/actor.json',
                        variables: {
                            actor: 'alice'
                        },
                        namePrefix: 'alice-'
                    }
                },
                {
                    include: 'inlineAssert'
                }
            ]
        });
        await mkdir(path.join(workingDirectory, 'fragments'));
        await writeFile(
            path.join(workingDirectory, 'fragments/actor.json'),
            JSON.stringify(
                {
                    variables: {
                        actor: 'fragment-default'
                    },
                    steps: [
                        {
                            name: 'setActor',
                            type: 'set',
                            output: 'actorValue',
                            value: '{actor}'
                        },
                        {
                            name: 'setRoom',
                            type: 'set',
                            output: 'roomValue',
                            value: '{roomId}'
                        }
                    ]
                },
                null,
                2
            )
        );

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--explain'
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const preflight = JSON.parse(result.stdout);

        expect(preflight.ok).toBe(true);
        expect(preflight.summary.includeCount).toBe(2);
        expect(preflight.includes.resolved).toEqual([
            expect.objectContaining({
                source: 'file:fragments/actor.json',
                stepCount: 2
            }),
            expect.objectContaining({
                source: 'fragment:inlineAssert',
                stepCount: 1
            })
        ]);
        expect(preflight.operations.map((operation: { name: string; }) => operation.name)).toEqual([
            'alice-setActor',
            'alice-setRoom',
            'assertActor'
        ]);
    });

    it('writes expanded recipe artifacts that no longer require include files', async () => {
        const workingDirectory = await writeTempConfig({
            variables: {
                roomId: 'room-from-parent'
            },
            steps: [
                {
                    include: {
                        path: 'fragments/actor.json',
                        variables: {
                            actor: 'alice'
                        },
                        namePrefix: 'alice-'
                    }
                },
                {
                    name: 'assertRoom',
                    type: 'assert',
                    actual: {
                        room: '{roomValue}'
                    },
                    expect: {
                        body: {
                            room: 'room-from-parent'
                        }
                    }
                }
            ]
        });
        await mkdir(path.join(workingDirectory, 'fragments'));
        await writeFile(
            path.join(workingDirectory, 'fragments/actor.json'),
            JSON.stringify(
                {
                    variables: {
                        actor: 'fragment-default'
                    },
                    steps: [
                        {
                            name: 'setActor',
                            type: 'set',
                            output: 'actorValue',
                            value: '{actor}'
                        },
                        {
                            name: 'setRoom',
                            type: 'set',
                            output: 'roomValue',
                            value: '{roomId}'
                        }
                    ]
                },
                null,
                2
            )
        );
        const artifactDir = path.join(workingDirectory, 'include-artifacts');

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--artifact-dir',
            artifactDir
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);
        const expandedRecipe = JSON.parse(await readFile(path.join(artifactDir, 'expanded-recipe.json'), 'utf8'));

        expect(report.outputs).toMatchObject({
            actorValue: 'alice',
            roomValue: 'room-from-parent'
        });
        expect(expandedRecipe.kind).toBe('black-box-runner.expanded-recipe');
        expect(expandedRecipe.includeMetadata.includes).toEqual([
            expect.objectContaining({
                source: 'file:fragments/actor.json',
                stepCount: 2
            })
        ]);
        expect(expandedRecipe.recipe.steps.map((step: { name: string; }) => step.name)).toEqual([
            'alice-setActor',
            'alice-setRoom',
            'assertRoom'
        ]);
        expect(JSON.stringify(expandedRecipe.recipe.steps)).not.toContain('"include"');
    });

    it('reports missing, circular, and remote static includes during validation', async () => {
        const missingDirectory = await writeTempConfig({
            steps: [
                {
                    include: 'missing.json'
                }
            ]
        });
        const circularDirectory = await writeTempConfig({
            fragments: {
                a: {
                    steps: [
                        {
                            include: 'b'
                        }
                    ]
                },
                b: {
                    steps: [
                        {
                            include: 'a'
                        }
                    ]
                }
            },
            steps: [
                {
                    include: 'a'
                }
            ]
        });
        const remoteDirectory = await writeTempConfig({
            steps: [
                {
                    include: 'https://example.com/recipe-fragment.json'
                }
            ]
        });

        const missing = await runScenarioCli([
            '-w',
            missingDirectory,
            '-c',
            'config.json',
            '--validate'
        ]);
        const circular = await runScenarioCli([
            '-w',
            circularDirectory,
            '-c',
            'config.json',
            '--validate'
        ]);
        const remote = await runScenarioCli([
            '-w',
            remoteDirectory,
            '-c',
            'config.json',
            '--validate'
        ]);

        expect(missing.code).toBe(1);
        expect(circular.code).toBe(1);
        expect(remote.code).toBe(1);

        const missingPreflight = JSON.parse(missing.stdout);
        const circularPreflight = JSON.parse(circular.stdout);
        const remotePreflight = JSON.parse(remote.stdout);

        expect(missingPreflight.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'PLAN_EXPANSION_FAILED',
                message: expect.stringContaining('Failed to load include missing.json')
            })
        ]));
        expect(circularPreflight.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'PLAN_EXPANSION_FAILED',
                message: expect.stringContaining('Circular include detected')
            })
        ]));
        expect(remotePreflight.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'PLAN_EXPANSION_FAILED',
                message: expect.stringContaining('Remote includes are not allowed by default')
            })
        ]));
    });

    it('validates missing env vars and missing connections before execution', async () => {
        const workingDirectory = await writeTempConfig({
            variables: {
                apiToken: {
                    env: 'RALLAR_BB_REQUIRED_PREFLIGHT_TOKEN',
                    required: true,
                    secret: true
                }
            },
            steps: [
                {
                    name: 'sendWs',
                    type: 'ws.send',
                    connection: 'missingWs',
                    request: {
                        send: {
                            token: '{apiToken}'
                        }
                    }
                }
            ]
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--validate'
        ], {
            RALLAR_BB_REQUIRED_PREFLIGHT_TOKEN: undefined
        });

        expect(result.code).toBe(1);
        expect(result.stderr).toBe('');

        const preflight = JSON.parse(result.stdout);

        expect(preflight.ok).toBe(false);
        expect(preflight.env.missing).toEqual([expect.objectContaining({
            envName: 'RALLAR_BB_REQUIRED_PREFLIGHT_TOKEN',
            variableName: 'apiToken'
        })]);
        expect(preflight.connections.missing).toEqual(['missingWs']);
        expect(preflight.issues.map((issue: { code: string; }) => issue.code)).toEqual(expect.arrayContaining([
            'MISSING_ENV',
            'MISSING_CONNECTION'
        ]));
        expect(result.stdout).not.toContain('<missing:RALLAR_BB_REQUIRED_PREFLIGHT_TOKEN>');
    });

    it('explains missing traffic-plan step references even when expansion fails', async () => {
        const workingDirectory = await writeTempConfig({
            execution: {
                trafficPlan: {
                    seed: 17,
                    count: 2,
                    setupSteps: ['connectMissing'],
                    operations: [
                        {
                            name: 'set-ok',
                            steps: ['setOk']
                        }
                    ]
                }
            },
            steps: [
                {
                    name: 'setOk',
                    type: 'set',
                    output: 'ok',
                    value: true
                }
            ]
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--explain'
        ]);

        expect(result.code).toBe(1);
        expect(result.stderr).toBe('');

        const preflight = JSON.parse(result.stdout);

        expect(preflight.ok).toBe(false);
        expect(preflight.stepReferences.missing).toEqual([expect.objectContaining({
            name: 'connectMissing',
            path: 'execution.trafficPlan.setupSteps[0]'
        })]);
        expect(preflight.issues.map((issue: { code: string; }) => issue.code)).toEqual(expect.arrayContaining([
            'MISSING_STEP_REFERENCE',
            'PLAN_EXPANSION_FAILED'
        ]));
    });

    it('explains seeded traffic-plan expansion without executing the generated steps', async () => {
        const workingDirectory = await writeTempConfig({
            execution: {
                trafficPlan: {
                    seed: 20260601,
                    count: 3,
                    setupSteps: ['setup'],
                    cleanupSteps: ['cleanup'],
                    operations: [
                        {
                            name: 'left',
                            weight: 1,
                            steps: ['sendLeft']
                        }
                    ]
                }
            },
            steps: [
                {
                    name: 'setup',
                    type: 'set',
                    output: 'setup',
                    value: true
                },
                {
                    name: 'sendLeft',
                    type: 'set',
                    output: 'sent{traffic.sequence}',
                    value: {
                        sequence: '{traffic.sequence}',
                        operation: '{traffic.operation}'
                    }
                },
                {
                    name: 'cleanup',
                    type: 'set',
                    output: 'cleanup',
                    value: true
                }
            ]
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--explain'
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const preflight = JSON.parse(result.stdout);

        expect(preflight.ok).toBe(true);
        expect(preflight.trafficPlan).toMatchObject({
            enabled: true,
            replay: false,
            seed: 20260601,
            decisionCount: 3,
            stepCount: 5
        });
        expect(preflight.summary.generatedOperationCount).toBe(5);
        expect(preflight.operations.map((operation: { name: string; }) => operation.name)).toEqual([
            'setup',
            'sendLeft',
            'sendLeft',
            'sendLeft',
            'cleanup'
        ]);
    });

    it('supports strict profile validation for known step types', async () => {
        const workingDirectory = await writeTempConfig({
            steps: [
                {
                    name: 'badSet',
                    type: 'set',
                    value: 'missing output'
                }
            ]
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--explain',
            '--strict'
        ]);

        expect(result.code).toBe(1);
        expect(result.stderr).toBe('');

        const preflight = JSON.parse(result.stdout);

        expect(preflight.profile).toBe('strict');
        expect(preflight.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'STRICT_SET_OUTPUT',
                severity: 'error'
            })
        ]));
    });

    it('runs config file with SET and ASSERT steps', async () => {
        const workingDirectory = await writeTempConfig({
            variables: {
                tokenType: 'Bearer',
                token: 'abc-123'
            },
            execution: {
                failFast: true
            },
            steps: [
                {
                    name: 'deriveAuth',
                    type: 'set',
                    output: 'auth',
                    value: {
                        body: {
                            token_type: '{tokenType}',
                            access_token: '{token}'
                        }
                    }
                },
                {
                    name: 'deriveAuthHeader',
                    type: 'set',
                    output: 'authHeader',
                    value: '{auth.body.token_type} {auth.body.access_token}'
                },
                {
                    name: 'assertAuthHeader',
                    type: 'assert',
                    actual: '{authHeader}',
                    expect: {
                        body: 'Bearer abc-123'
                    }
                }
            ]
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json'
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);

        expect(report.summary.failure).toBe(0);
        expect(report.summary.success).toBe(3);
        expect(report.outputs.authHeader).toBe('Bearer abc-123');
        expect(report.resultsByName.assertAuthHeader[0].status).toBe('SUCCESS');
    });

    it('runs safe output transforms for SET values and extracted outputs', async () => {
        const workingDirectory = await writeTempConfig({
            execution: {
                failFast: true
            },
            steps: [
                {
                    name: 'loginResult',
                    type: 'set',
                    output: 'loginResult',
                    value: {
                        body: {
                            access_token: 'secret token/123',
                            token_type: 'Bearer',
                            user: {
                                idText: '42'
                            },
                            revision: 46,
                            onlineMemberCount: 13,
                            enabledText: 'true',
                            payload: {
                                roomId: 'room-1'
                            },
                            payloadJson: '["room.join",true]',
                            firstSessionId: 'session-a',
                            secondSessionId: 'session-b',
                            fallback: 'fallback-value'
                        }
                    },
                    outputs: {
                        accessToken: {
                            path: 'body.access_token',
                            secret: true,
                            redactAs: 'accessToken'
                        },
                        authHeader: {
                            concat: [
                                { path: 'body.token_type' },
                                ' ',
                                { path: 'body.access_token' }
                            ],
                            secret: true,
                            redactAs: 'authHeader'
                        },
                        encodedToken: {
                            urlEncode: { path: 'body.access_token' },
                            secret: true,
                            redactAs: 'encodedToken'
                        },
                        userId: {
                            number: { path: 'body.user.idText' }
                        },
                        nextRevision: {
                            add: [
                                { path: 'body.revision' },
                                1
                            ]
                        },
                        maximumRevision: {
                            max: [
                                44,
                                { path: 'body.revision' },
                                45
                            ]
                        },
                        convergedRevision: {
                            if: {
                                condition: {
                                    equals: [
                                        { path: 'body.onlineMemberCount' },
                                        13
                                    ]
                                },
                                then: { path: 'body.revision' },
                                else: {
                                    add: [
                                        { path: 'body.revision' },
                                        1
                                    ]
                                }
                            }
                        },
                        pendingRevision: {
                            if: {
                                condition: {
                                    equals: [
                                        { path: 'body.onlineMemberCount' },
                                        12
                                    ]
                                },
                                then: { path: 'body.revision' },
                                else: {
                                    add: [
                                        { path: 'body.revision' },
                                        1
                                    ]
                                }
                            }
                        },
                        enabled: {
                            boolean: { path: 'body.enabledText' }
                        },
                        parsedPayload: {
                            jsonParse: { path: 'body.payloadJson' }
                        },
                        payloadJson: {
                            jsonStringify: { path: 'body.payload' }
                        },
                        fallbackValue: {
                            coalesce: [
                                { path: 'body.missing' },
                                '',
                                { path: 'body.fallback' }
                            ]
                        },
                        firstSessionReports: {
                            operator: 'lexicallyBefore',
                            values: [
                                { path: 'body.firstSessionId' },
                                { path: 'body.secondSessionId' }
                            ]
                        },
                        secondSessionReports: {
                            operator: 'lexicallyBefore',
                            values: [
                                { path: 'body.secondSessionId' },
                                { path: 'body.firstSessionId' }
                            ]
                        },
                        templatedToken: {
                            template: 'token={result.actual.body.access_token}',
                            secret: true,
                            redactAs: 'templatedToken'
                        }
                    }
                },
                {
                    name: 'deriveTraceId',
                    type: 'set',
                    output: 'traceId',
                    transform: {
                        concat: [
                            'trace-',
                            { uuid: true },
                            '-',
                            { timestamp: true }
                        ]
                    }
                },
                {
                    name: 'assertTransforms',
                    type: 'assert',
                    actual: {
                        authHeader: '{authHeader}',
                        encodedToken: '{encodedToken}',
                        userId: '{userId}',
                        nextRevision: '{nextRevision}',
                        maximumRevision: '{maximumRevision}',
                        convergedRevision: '{convergedRevision}',
                        pendingRevision: '{pendingRevision}',
                        enabled: '{enabled}',
                        parsedPayload: '{parsedPayload}',
                        fallbackValue: '{fallbackValue}',
                        firstSessionReports: '{firstSessionReports}',
                        secondSessionReports: '{secondSessionReports}'
                    },
                    expect: {
                        body: {
                            authHeader: 'Bearer secret token/123',
                            encodedToken: 'secret%20token%2F123',
                            userId: 42,
                            nextRevision: 47,
                            maximumRevision: 46,
                            convergedRevision: 46,
                            pendingRevision: 47,
                            enabled: true,
                            parsedPayload: ['room.join', true],
                            fallbackValue: 'fallback-value',
                            firstSessionReports: true,
                            secondSessionReports: false
                        }
                    }
                }
            ]
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json'
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).not.toContain('secret token/123');

        const report = JSON.parse(result.stdout);

        expect(report.summary).toMatchObject({
            failure: 0,
            success: 3
        });
        expect(report.outputs).toMatchObject({
            accessToken: '<redacted:accessToken>',
            authHeader: 'Bearer <redacted:accessToken>',
            encodedToken: '<redacted:encodedToken>',
            userId: 42,
            nextRevision: 47,
            maximumRevision: 46,
            convergedRevision: 46,
            pendingRevision: 47,
            enabled: true,
            parsedPayload: ['room.join', true],
            payloadJson: '{"roomId":"room-1"}',
            fallbackValue: 'fallback-value',
            firstSessionReports: true,
            secondSessionReports: false,
            templatedToken: 'token=<redacted:accessToken>'
        });
        expect(report.outputs.traceId).toMatch(/^trace-[0-9a-f-]{36}-\d+$/);
        expect(report.resultsByName.assertTransforms[0].status).toBe('SUCCESS');
    });

    it('executes steps only when their safe transform condition is true', async () => {
        const workingDirectory = await writeTempConfig({
            steps: [
                {
                    name: 'captureAdjacency',
                    type: 'set',
                    output: 'adjacency',
                    value: {
                        alice: ['bob'],
                        bob: ['alice'],
                        charlie: []
                    }
                },
                {
                    name: 'skipUnplannedEdge',
                    type: 'set',
                    output: 'unplannedEdgeWasExecuted',
                    transform: {
                        path: 'outputs.missingValue'
                    },
                    request: {
                        when: {
                            includes: [
                                {
                                    get: [
                                        { path: 'outputs.adjacency' },
                                        'alice'
                                    ]
                                },
                                'charlie'
                            ]
                        }
                    }
                },
                {
                    name: 'capturePlannedEdge',
                    type: 'set',
                    output: 'plannedEdgeWasExecuted',
                    value: true,
                    request: {
                        when: {
                            includes: [
                                {
                                    get: [
                                        { path: 'outputs.adjacency' },
                                        'alice'
                                    ]
                                },
                                'bob'
                            ]
                        }
                    }
                },
                {
                    name: 'skipUnplannedSend',
                    type: 'ws.send',
                    connection: '{missingConnection}',
                    message: {
                        type: 'not-sent'
                    },
                    request: {
                        when: {
                            includes: [
                                {
                                    get: [
                                        { path: 'outputs.adjacency' },
                                        'alice'
                                    ]
                                },
                                'charlie'
                            ]
                        }
                    }
                },
                {
                    name: 'assertConditionalOutputs',
                    type: 'assert',
                    actual: {
                        plannedEdgeWasExecuted: '{plannedEdgeWasExecuted}'
                    },
                    expect: {
                        body: {
                            plannedEdgeWasExecuted: true
                        }
                    }
                }
            ]
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json'
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);

        expect(report.summary).toMatchObject({
            total: 5,
            success: 5,
            failure: 0
        });
        expect(report.outputs).toMatchObject({
            plannedEdgeWasExecuted: true
        });
        expect(report.outputs.unplannedEdgeWasExecuted).toBeUndefined();
        expect(report.resultsByName.skipUnplannedEdge[0]).toMatchObject({
            status: 'SUCCESS',
            action: 'skip',
            skipped: true,
            skippedAction: 'set'
        });
        expect(report.resultsByName.skipUnplannedSend[0]).toMatchObject({
            status: 'SUCCESS',
            action: 'skip',
            skipped: true,
            skippedAction: 'send'
        });
        expect(report.resultsByName.capturePlannedEdge[0]).toMatchObject({
            status: 'SUCCESS',
            transport: 'SET'
        });
    });

    it('reports redacted transform failures with operator details', async () => {
        const workingDirectory = await writeTempConfig({
            variables: {
                badJson: {
                    env: 'BLACK_BOX_BAD_JSON',
                    required: true,
                    secret: true
                }
            },
            steps: [
                {
                    name: 'parseSecretJson',
                    type: 'set',
                    output: 'parsed',
                    transform: {
                        jsonParse: '{badJson}'
                    }
                }
            ]
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json'
        ], {
            BLACK_BOX_BAD_JSON: 'not-json-secret'
        });

        expect(result.code).toBe(1);
        expect(result.stderr).toBe('');
        expect(result.stdout).not.toContain('not-json-secret');

        const report = JSON.parse(result.stdout);
        const failure = report.resultsByName.parseSecretJson[0];

        expect(report.summary.failure).toBe(1);
        expect(failure.status).toBe('FAILURE');
        expect(failure.result).toBe('Set transform failed.');
        expect(failure.details.transformError.details).toMatchObject({
            operator: 'jsonParse',
            input: '<redacted:badJson>'
        });
    });

    it('exits with code 1 when config assertion fails', async () => {
        const workingDirectory = await writeTempConfig({
            execution: {
                failFast: true
            },
            steps: [
                {
                    name: 'assertFails',
                    type: 'assert',
                    actual: {
                        id: 'not-an-integer'
                    },
                    expect: {
                        body: {
                            id: 'integer'
                        }
                    }
                }
            ]
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json'
        ]);

        expect(result.code).toBe(1);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);

        expect(report.summary.failure).toBe(1);
        expect(report.summary.firstFailure.name).toBe('assertFails');
        expect(report.resultsByName.assertFails[0].status).toBe('FAILURE');
    });

    it('supports failFast false from config file', async () => {
        const workingDirectory = await writeTempConfig({
            execution: {
                failFast: false
            },
            steps: [
                {
                    name: 'firstAssertFails',
                    type: 'assert',
                    actual: {
                        id: 'not-an-integer'
                    },
                    expect: {
                        body: {
                            id: 'integer'
                        }
                    }
                },
                {
                    name: 'setAfterFailure',
                    type: 'set',
                    output: 'afterFailure',
                    value: 'still-runs'
                }
            ]
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json'
        ]);

        expect(result.code).toBe(1);

        const report = JSON.parse(result.stdout);

        expect(report.summary.failure).toBe(1);
        expect(report.summary.success).toBe(1);
        expect(report.outputs.afterFailure).toBe('still-runs');
    });

    it('dry mode prints executable interactions from config file', async () => {
        const workingDirectory = await writeTempConfig({
            variables: {
                roomId: 'room-1'
            },
            connections: {
                aliceWs: {
                    type: 'ws',
                    url: 'ws://localhost:8080/ws'
                }
            },
            steps: [
                {
                    name: 'connectAlice',
                    type: 'ws.connect',
                    connection: 'aliceWs'
                },
                {
                    name: 'aliceSendsJoin',
                    type: 'ws.send',
                    connection: 'aliceWs',
                    request: {
                        send: {
                            type: 'room.join',
                            roomId: '{roomId}'
                        }
                    }
                }
            ]
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '-e',
            'dry'
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const interactions = JSON.parse(result.stdout);

        expect(Array.isArray(interactions)).toBe(true);
        expect(interactions.length).toBe(2);

        expect(interactions[0].WS.request.action).toBe('connect');
        expect(interactions[0].WS.request.connection).toBe('aliceWs');
        expect(interactions[0].WS.request.path).toBe('ws://localhost:8080/ws');

        expect(interactions[1].WS.request.action).toBe('send');
        expect(interactions[1].WS.request.send).toEqual({
            type: 'room.join',
            roomId: 'room-1'
        });
    });

    it('dry-run option returns report instead of executable interactions', async () => {
        const workingDirectory = await writeTempConfig({
            variables: {
                roomId: 'room-1'
            },
            connections: {
                aliceRtc: {
                    type: 'rtc',
                    provider: 'unknown-rtc-provider',
                    actor: 'alice',
                    peerId: 'alice',
                    roomId: '{roomId}'
                }
            },
            steps: [
                {
                    name: 'connectAlice',
                    type: 'rtc.connect',
                    connection: 'aliceRtc'
                }
            ]
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--dry-run'
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);

        expect(Array.isArray(report)).toBe(false);
        expect(report.summary.failure).toBe(0);
        expect(report.summary.success).toBe(1);
        expect(report.resultsByName.connectAlice[0].status).toBe('SUCCESS');
        expect(report.resultsByName.connectAlice[0].actual.dryRun).toBe(true);
        expect(report.resultsByName.connectAlice[0].actual.normalized.provider).toBe('unknown-rtc-provider');
        expect(report.resultsByName.connectAlice[0].actual.normalized.roomId).toBe('room-1');
    });

    it('dry-run RTC send exposes synthetic output fields for downstream asserts', async () => {
        const workingDirectory = await writeTempConfig({
            connections: {
                aliceRtc: {
                    type: 'rtc',
                    provider: 'unknown-rtc-provider',
                    actor: 'alice',
                    peerId: 'alice',
                    roomId: 'room-1'
                },
                bobRtc: {
                    type: 'rtc',
                    provider: 'unknown-rtc-provider',
                    actor: 'bob',
                    peerId: 'bob',
                    roomId: 'room-1'
                }
            },
            steps: [
                {
                    name: 'aliceSendsToBob',
                    type: 'rtc.send',
                    connection: 'aliceRtc',
                    request: {
                        send: {
                            topic: 'chat.message',
                            payload: {
                                text: 'hello bob'
                            }
                        },
                        outputs: {
                            sendStatus: 'sendResult.status',
                            deliveredPayload: 'matchedMessage.data.payload'
                        }
                    },
                    expect: {
                        connection: 'bobRtc',
                        message: {
                            topic: 'chat.message',
                            payload: {
                                text: 'hello bob'
                            }
                        }
                    }
                },
                {
                    name: 'assertDryRunOutputs',
                    type: 'assert',
                    actual: {
                        sendStatus: '{sendStatus}',
                        deliveredPayload: '{deliveredPayload}'
                    },
                    expect: {
                        body: {
                            sendStatus: 'sent',
                            deliveredPayload: {
                                text: 'hello bob'
                            }
                        }
                    }
                }
            ]
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--dry-run'
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);

        expect(report.summary.failure).toBe(0);
        expect(report.outputs.sendStatus).toBe('sent');
        expect(report.outputs.deliveredPayload).toEqual({
            text: 'hello bob'
        });
        expect(report.resultsByName.aliceSendsToBob[0].actual.dryRun).toBe(true);
        expect(report.resultsByName.aliceSendsToBob[0].actual.sendResult).toEqual({
            status: 'sent',
            dryRun: true
        });
    });

    it('short dry-run option returns report instead of executable interactions', async () => {
        const workingDirectory = await writeTempConfig({
            connections: {
                aliceRtc: {
                    type: 'rtc',
                    provider: 'unknown-rtc-provider',
                    actor: 'alice',
                    peerId: 'alice',
                    roomId: 'room-1'
                }
            },
            steps: [
                {
                    name: 'connectAlice',
                    type: 'rtc.connect',
                    connection: 'aliceRtc'
                }
            ]
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '-n'
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);

        expect(Array.isArray(report)).toBe(false);
        expect(report.summary.failure).toBe(0);
        expect(report.summary.success).toBe(1);
        expect(report.resultsByName.connectAlice[0].status).toBe('SUCCESS');
        expect(report.resultsByName.connectAlice[0].actual.dryRun).toBe(true);
    });

    it('applies command-line replacements over config variables', async () => {
        const workingDirectory = await writeTempConfig({
            variables: {
                token: 'from-config'
            },
            steps: [
                {
                    name: 'setToken',
                    type: 'set',
                    output: 'tokenValue',
                    value: '{token}'
                },
                {
                    name: 'assertToken',
                    type: 'assert',
                    actual: '{tokenValue}',
                    expect: {
                        body: 'from-cli'
                    }
                }
            ]
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '-r',
            'token:=from-cli'
        ]);

        expect(result.code).toBe(0);

        const report = JSON.parse(result.stdout);

        expect(report.summary.failure).toBe(0);
        expect(report.outputs.tokenValue).toBe('from-cli');
    });

    it('resolves environment variables and redacts secret values in reports', async () => {
        const workingDirectory = await writeTempConfig({
            variables: {
                apiToken: {
                    env: 'BLACK_BOX_TEST_API_TOKEN',
                    required: true,
                    secret: true
                }
            },
            steps: [
                {
                    name: 'deriveAuthHeader',
                    type: 'set',
                    output: 'authHeader',
                    value: 'Bearer {apiToken}'
                },
                {
                    name: 'assertRedactedHeader',
                    type: 'assert',
                    actual: '{authHeader}',
                    expect: {
                        body: 'Bearer secret-token-123'
                    }
                }
            ]
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json'
        ], {
            BLACK_BOX_TEST_API_TOKEN: 'secret-token-123'
        });

        expect(result.code).toBe(0);
        expect(result.stdout).not.toContain('secret-token-123');

        const report = JSON.parse(result.stdout);

        expect(report.summary.failure).toBe(0);
        expect(report.outputs.authHeader).toBe('Bearer <redacted:apiToken>');
        expect(report.resultsByName.assertRedactedHeader[0].actual).toBe('Bearer <redacted:apiToken>');
    });

    it('writes redacted report, event stream, and failure artifacts', async () => {
        const workingDirectory = await writeTempConfig({
            variables: {
                apiToken: {
                    env: 'BLACK_BOX_TEST_API_TOKEN',
                    required: true,
                    secret: true
                }
            },
            execution: {
                failFast: false
            },
            steps: [
                {
                    name: 'deriveAuthHeader',
                    type: 'set',
                    output: 'authHeader',
                    value: 'Bearer {apiToken}'
                },
                {
                    name: 'assertSecretHeaderFails',
                    type: 'assert',
                    actual: '{authHeader}',
                    expect: {
                        body: 'Bearer expected-token'
                    }
                }
            ]
        });
        const artifactDir = path.join(workingDirectory, 'artifacts');

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--artifact-dir',
            artifactDir
        ], {
            BLACK_BOX_TEST_API_TOKEN: 'secret-token-123'
        });

        expect(result.code).toBe(1);

        const reportText = await readFile(path.join(artifactDir, 'report.json'), 'utf8');
        const eventsText = await readFile(path.join(artifactDir, 'events.jsonl'), 'utf8');
        const failuresText = await readFile(path.join(artifactDir, 'failures.json'), 'utf8');
        const metadataText = await readFile(path.join(artifactDir, 'metadata.json'), 'utf8');
        const artifactIndexText = await readFile(path.join(artifactDir, 'artifact-index.json'), 'utf8');
        const artifactText = [
            reportText,
            eventsText,
            failuresText,
            metadataText,
            artifactIndexText
        ].join('\n');

        expect(artifactText).not.toContain('secret-token-123');

        const report = JSON.parse(reportText);
        const failures = JSON.parse(failuresText);
        const metadata = JSON.parse(metadataText);
        const artifactIndex = JSON.parse(artifactIndexText);
        const events = eventsText
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));

        expect(report.summary.failure).toBe(1);
        expect(failures.summary.failure).toBe(1);
        expect(failures.failures[0].name).toBe('assertSecretHeaderFails');
        expect(failures.failures[0].actual).toBe('Bearer <redacted:apiToken>');
        expect(events.some((event) => event.kind === 'step-result' && event.name === 'assertSecretHeaderFails'))
            .toBe(true);
        expect(artifactIndex.firstFailure).toMatchObject({
            name: 'assertSecretHeaderFails',
            kind: 'step-result'
        });
        expect(artifactIndex.stepResults.every((entry: { sequence?: number; }) => typeof entry.sequence === 'number'))
            .toBe(true);
        expect(metadata.summary.failure).toBe(1);
        expect(metadata.command.join(' ')).toContain('--artifact-dir');
    });

    it('writes artifact indexes and per-kind caps while preserving failures', async () => {
        const workingDirectory = await writeTempConfig({
            execution: {
                failFast: false,
                artifacts: {
                    maxEventsByKind: {
                        'step-result': 2
                    }
                }
            },
            steps: [
                {
                    name: 'setOne',
                    type: 'set',
                    output: 'one',
                    value: 'one'
                },
                {
                    name: 'setTwo',
                    type: 'set',
                    output: 'two',
                    value: 'two'
                },
                {
                    name: 'setThree',
                    type: 'set',
                    output: 'three',
                    value: 'three'
                },
                {
                    name: 'assertFailureIsPreserved',
                    type: 'assert',
                    actual: '{three}',
                    expect: {
                        body: 'not-three'
                    }
                }
            ]
        });
        const artifactDir = path.join(workingDirectory, 'indexed-artifacts');

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--artifact-dir',
            artifactDir
        ]);

        expect(result.code).toBe(1);

        const report = JSON.parse(await readFile(path.join(artifactDir, 'report.json'), 'utf8'));
        const events = (await readFile(path.join(artifactDir, 'events.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        const artifactIndex = JSON.parse(await readFile(path.join(artifactDir, 'artifact-index.json'), 'utf8'));
        const stepEventNames = events
            .filter((event) => event.kind === 'step-result')
            .map((event) => event.name);

        expect(report.artifact).toMatchObject({
            truncated: true,
            omittedEvents: 1,
            maxEventsByKind: {
                'step-result': 2
            }
        });
        expect(stepEventNames).toEqual([
            'setOne',
            'setTwo',
            'assertFailureIsPreserved'
        ]);
        expect(events.at(-1)).toMatchObject({
            kind: 'artifact-truncated',
            omittedByKind: {
                'step-result': 1
            }
        });
        expect(artifactIndex.firstFailure).toMatchObject({
            name: 'assertFailureIsPreserved'
        });
        expect(artifactIndex.stepResults).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'setThree',
                emitted: false
            }),
            expect.objectContaining({
                name: 'assertFailureIsPreserved',
                emitted: true,
                status: 'FAILURE'
            })
        ]));
        expect(artifactIndex.compaction.repeatedSuccessSummaries).toEqual([
            expect.objectContaining({
                name: 'setThree',
                count: 1
            })
        ]);
    });

    it('keeps delimiter-containing producer tuples distinct in compact success summaries', async () => {
        const workingDirectory = await writeTempConfig({
            execution: {
                dryRun: true,
                artifacts: {
                    maxEventsByKind: {
                        'step-result': 1
                    }
                }
            },
            steps: [
                {
                    name: 'retainedProducer',
                    type: 'crdt',
                    action: 'open',
                    connection: 'east'
                },
                {
                    name: 'producer|CRDT',
                    type: 'crdt',
                    action: 'ship',
                    connection: 'east'
                },
                {
                    name: 'producer',
                    type: 'crdt',
                    action: 'CRDT|ship',
                    connection: 'east'
                }
            ]
        });
        const artifactDir = path.join(workingDirectory, 'delimiter-artifacts');

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--artifact-dir',
            artifactDir
        ]);

        expect(result.code).toBe(0);

        const artifactIndex = JSON.parse(await readFile(path.join(artifactDir, 'artifact-index.json'), 'utf8'));

        expect(artifactIndex.compaction.repeatedSuccessSummaries).toEqual([
            {
                name: 'producer|CRDT',
                transport: 'CRDT',
                action: 'ship',
                connection: 'east',
                status: 'SUCCESS',
                count: 1,
                firstSequence: 2,
                lastSequence: 2
            },
            {
                name: 'producer',
                transport: 'CRDT',
                action: 'CRDT|ship',
                connection: 'east',
                status: 'SUCCESS',
                count: 1,
                firstSequence: 3,
                lastSequence: 3
            }
        ]);
    });

    it('injects opt-in runner correlation headers and RTC payload fields into artifacts', async () => {
        const server = await tryStartHeaderEchoServer();
        if (!server) {
            return;
        }

        try {
            const workingDirectory = await writeTempConfig({
                execution: {
                    correlation: {
                        runnerRunId: 'bb-correlation-run',
                        injectHeaders: true,
                        injectPayloads: true
                    }
                },
                connections: {
                    api: {
                        type: 'http',
                        baseUrl: server.baseUrl
                    },
                    aliceRtc: {
                        type: 'rtc',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'correlation-room',
                        remotePeerId: 'bob'
                    },
                    bobRtc: {
                        type: 'rtc',
                        provider: 'rallar-memory',
                        actor: 'bob',
                        peerId: 'bob',
                        roomId: 'correlation-room',
                        remotePeerId: 'alice'
                    }
                },
                steps: [
                    {
                        name: 'echoHeaders',
                        type: 'http',
                        connection: 'api',
                        request: {
                            path: '/headers'
                        },
                        expect: {
                            status: 200,
                            body: {
                                headers: {
                                    'x-rallar-black-box-run-id': 'bb-correlation-run'
                                }
                            }
                        }
                    },
                    {
                        name: 'connectAlice',
                        type: 'rtc.connect',
                        connection: 'aliceRtc'
                    },
                    {
                        name: 'connectBob',
                        type: 'rtc.connect',
                        connection: 'bobRtc'
                    },
                    {
                        name: 'aliceSendsToBob',
                        type: 'rtc.send',
                        connection: 'aliceRtc',
                        request: {
                            send: {
                                topic: 'correlation.test',
                                toPeerId: 'bob',
                                payload: {
                                    text: 'hello'
                                }
                            }
                        },
                        expect: {
                            connection: 'bobRtc',
                            withinMs: 1000,
                            consume: true,
                            message: {
                                topic: 'correlation.test',
                                toPeerId: 'bob',
                                payload: {
                                    text: 'hello'
                                },
                                blackBoxRunner: {
                                    runnerRunId: 'bb-correlation-run'
                                }
                            }
                        }
                    },
                    {
                        name: 'closeAlice',
                        type: 'rtc.close',
                        connection: 'aliceRtc'
                    },
                    {
                        name: 'closeBob',
                        type: 'rtc.close',
                        connection: 'bobRtc'
                    }
                ]
            });
            const artifactDir = path.join(workingDirectory, 'correlation-artifacts');

            const result = await runScenarioCli([
                '-w',
                workingDirectory,
                '-c',
                'config.json',
                '--artifact-dir',
                artifactDir
            ]);

            expect(result.code).toBe(0);
            expect(result.stderr).toBe('');

            const report = JSON.parse(result.stdout);
            const eventsText = await readFile(path.join(artifactDir, 'events.jsonl'), 'utf8');
            const metadataText = await readFile(path.join(artifactDir, 'metadata.json'), 'utf8');
            const artifactReportText = await readFile(path.join(artifactDir, 'report.json'), 'utf8');
            const events = eventsText
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line));
            const metadata = JSON.parse(metadataText);
            const artifactReport = JSON.parse(artifactReportText);
            const headerResult = report.resultsByName.echoHeaders[0];
            const sendResult = report.resultsByName.aliceSendsToBob[0];

            expect(report.runnerRunId).toBe('bb-correlation-run');
            expect(report.correlation.injection).toMatchObject({
                headers: true,
                payloads: true
            });
            expect(headerResult.runnerRunId).toBe('bb-correlation-run');
            expect(headerResult.actual.body.headers['x-rallar-black-box-run-id']).toBe('bb-correlation-run');
            expect(headerResult.actual.body.headers['x-rallar-black-box-step-id']).toBe(headerResult.runnerStepId);
            expect(headerResult.correlation.injected.headers).toBe(true);
            expect(sendResult.actual.sent.blackBoxRunner).toMatchObject({
                runnerRunId: 'bb-correlation-run',
                runnerStepId: sendResult.runnerStepId
            });
            expect(sendResult.actual.matchedMessage.data.blackBoxRunner).toMatchObject({
                runnerRunId: 'bb-correlation-run',
                runnerStepId: sendResult.runnerStepId
            });
            expect(sendResult.correlation.injected.payload).toBe(true);
            expect(events).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    kind: 'step-result',
                    name: 'aliceSendsToBob',
                    runnerRunId: 'bb-correlation-run',
                    runnerStepId: sendResult.runnerStepId
                })
            ]));
            expect(metadata.correlation.runnerRunId).toBe('bb-correlation-run');
            expect(artifactReport.resultsByName.echoHeaders[0].runnerStepId).toBe(headerResult.runnerStepId);
        }
        finally {
            await server.close();
        }
    });

    it('records runner correlation IDs while leaving wire data unchanged by default', async () => {
        const server = await tryStartHeaderEchoServer();
        if (!server) {
            return;
        }

        try {
            const workingDirectory = await writeTempConfig({
                execution: {
                    correlation: {
                        runnerRunId: 'bb-record-only',
                        injectHeaders: false,
                        injectPayloads: false
                    }
                },
                connections: {
                    api: {
                        type: 'http',
                        baseUrl: server.baseUrl
                    },
                    aliceRtc: {
                        type: 'rtc',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'correlation-opt-out-room',
                        remotePeerId: 'bob'
                    },
                    bobRtc: {
                        type: 'rtc',
                        provider: 'rallar-memory',
                        actor: 'bob',
                        peerId: 'bob',
                        roomId: 'correlation-opt-out-room',
                        remotePeerId: 'alice'
                    }
                },
                steps: [
                    {
                        name: 'echoHeaders',
                        type: 'http',
                        connection: 'api',
                        request: {
                            path: '/headers'
                        },
                        expect: {
                            status: 200
                        }
                    },
                    {
                        name: 'connectAlice',
                        type: 'rtc.connect',
                        connection: 'aliceRtc'
                    },
                    {
                        name: 'connectBob',
                        type: 'rtc.connect',
                        connection: 'bobRtc'
                    },
                    {
                        name: 'aliceSendsToBob',
                        type: 'rtc.send',
                        connection: 'aliceRtc',
                        request: {
                            send: {
                                topic: 'correlation.optout',
                                toPeerId: 'bob',
                                payload: {
                                    text: 'plain'
                                }
                            }
                        },
                        expect: {
                            connection: 'bobRtc',
                            withinMs: 1000,
                            consume: true,
                            message: {
                                topic: 'correlation.optout',
                                toPeerId: 'bob',
                                payload: {
                                    text: 'plain'
                                }
                            }
                        }
                    },
                    {
                        name: 'closeAlice',
                        type: 'rtc.close',
                        connection: 'aliceRtc'
                    },
                    {
                        name: 'closeBob',
                        type: 'rtc.close',
                        connection: 'bobRtc'
                    }
                ]
            });

            const result = await runScenarioCli([
                '-w',
                workingDirectory,
                '-c',
                'config.json'
            ]);

            expect(result.code).toBe(0);
            expect(result.stderr).toBe('');

            const report = JSON.parse(result.stdout);
            const headerResult = report.resultsByName.echoHeaders[0];
            const sendResult = report.resultsByName.aliceSendsToBob[0];

            expect(report.runnerRunId).toBe('bb-record-only');
            expect(headerResult.runnerStepId).toContain('echoHeaders');
            expect(headerResult.actual.body.headers['x-rallar-black-box-run-id']).toBeUndefined();
            expect(headerResult.actual.body.headers['x-rallar-black-box-step-id']).toBeUndefined();
            expect(headerResult.correlation.injected.headers).toBe(false);
            expect(sendResult.runnerStepId).toContain('aliceSendsToBob');
            expect(sendResult.actual.sent.blackBoxRunner).toBeUndefined();
            expect(sendResult.actual.matchedMessage.data.blackBoxRunner).toBeUndefined();
            expect(sendResult.correlation.injected.payload).toBe(false);
        }
        finally {
            await server.close();
        }
    });

    it('runs scale iterations and writes aggregate artifacts', async () => {
        const workingDirectory = await writeTempConfig({
            steps: [
                {
                    name: 'setValue',
                    type: 'set',
                    output: 'value',
                    value: 'ok'
                },
                {
                    name: 'assertValue',
                    type: 'assert',
                    actual: '{value}',
                    expect: {
                        body: 'ok'
                    }
                }
            ]
        });
        const artifactDir = path.join(workingDirectory, 'scale-artifacts');

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--iterations',
            '2',
            '--artifact-dir',
            artifactDir
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);

        expect(report.summary.runs).toBe(2);
        expect(report.summary.passedRuns).toBe(2);
        expect(report.summary.failedRuns).toBe(0);
        expect(report.summary.total).toBe(4);
        expect(report.resultsByName.setValue).toHaveLength(2);
        expect(report.resultsByName.assertValue).toHaveLength(2);
        expect(report.resultsByName.setValue[0].runIndex).toBe(1);
        expect(report.resultsByName.setValue[1].runIndex).toBe(2);
        expect(report.outputsByRun['1'].value).toBe('ok');
        expect(report.outputsByRun['2'].value).toBe('ok');
        expect(report.metrics.byTransport.SET).toBe(2);
        expect(report.metrics.byTransport.ASSERT).toBe(2);
        expect(report.metrics.latencyMs.runDuration.count).toBe(2);

        const reportText = await readFile(path.join(artifactDir, 'report.json'), 'utf8');
        const eventsText = await readFile(path.join(artifactDir, 'events.jsonl'), 'utf8');
        const metadataText = await readFile(path.join(artifactDir, 'metadata.json'), 'utf8');
        const artifactReport = JSON.parse(reportText);
        const metadata = JSON.parse(metadataText);
        const events = eventsText
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));

        expect(artifactReport.summary.runs).toBe(2);
        expect(metadata.summary.runs).toBe(2);
        expect(events.filter((event) => event.kind === 'step-result')).toHaveLength(4);
        expect(events.every((event) => event.kind !== 'step-result' || event.runIndex === 1 || event.runIndex === 2))
            .toBe(true);
    });

    it('evaluates post-run assertions and writes assertion artifacts', async () => {
        const workingDirectory = await writeTempConfig({
            execution: {
                thresholds: {
                    'summary.failure': {
                        max: 0
                    },
                    'metrics.byTransport.SET': {
                        gte: 1
                    },
                    'metrics.latencyMs.stepDuration.count': {
                        min: 2
                    }
                }
            },
            postRunAssertions: [
                {
                    name: 'artifact stream is complete',
                    path: 'artifact.truncated',
                    equals: false
                }
            ],
            steps: [
                {
                    name: 'setValue',
                    type: 'set',
                    output: 'value',
                    value: 'ok'
                },
                {
                    name: 'assertValue',
                    type: 'assert',
                    actual: '{value}',
                    expect: {
                        body: 'ok'
                    }
                }
            ]
        });
        const artifactDir = path.join(workingDirectory, 'post-run-artifacts');

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--artifact-dir',
            artifactDir
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);

        expect(report.summary.ok).toBe(true);
        expect(report.summary.postRunAssertions).toEqual({
            total: 4,
            success: 4,
            failure: 0
        });
        expect(report.postRunAssertions.results.map((entry: { status: string; }) => entry.status))
            .toEqual(['SUCCESS', 'SUCCESS', 'SUCCESS', 'SUCCESS']);
        expect(report.metrics.byTransport.SET).toBe(1);
        expect(report.artifact.truncated).toBe(false);

        const eventsText = await readFile(path.join(artifactDir, 'events.jsonl'), 'utf8');
        const artifactReportText = await readFile(path.join(artifactDir, 'report.json'), 'utf8');
        const events = eventsText
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        const artifactReport = JSON.parse(artifactReportText);

        expect(artifactReport.postRunAssertions.summary.failure).toBe(0);
        expect(events.filter((event) => event.kind === 'post-run-assertion')).toHaveLength(4);
    });

    it('exits with code 1 when a post-run threshold fails without step failures', async () => {
        const workingDirectory = await writeTempConfig({
            execution: {
                thresholds: {
                    'metrics.byTransport.SET': {
                        gte: 2
                    }
                }
            },
            steps: [
                {
                    name: 'setValue',
                    type: 'set',
                    output: 'value',
                    value: 'ok'
                }
            ]
        });
        const artifactDir = path.join(workingDirectory, 'post-run-failure-artifacts');

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--artifact-dir',
            artifactDir
        ]);

        expect(result.code).toBe(1);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);
        const failuresText = await readFile(path.join(artifactDir, 'failures.json'), 'utf8');
        const eventsText = await readFile(path.join(artifactDir, 'events.jsonl'), 'utf8');
        const failures = JSON.parse(failuresText);
        const events = eventsText
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));

        expect(report.summary.failure).toBe(0);
        expect(report.summary.ok).toBe(false);
        expect(report.summary.postRunAssertions).toEqual({
            total: 1,
            success: 0,
            failure: 1
        });
        expect(report.summary.firstPostRunAssertionFailure).toMatchObject({
            path: 'metrics.byTransport.SET',
            operator: 'gte',
            expected: 2,
            actual: 1
        });
        expect(failures.failures).toEqual([]);
        expect(failures.postRunAssertionFailures).toHaveLength(1);
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'post-run-assertion',
                status: 'FAILURE',
                path: 'metrics.byTransport.SET'
            })
        ]));
    });

    it('runs same-connection soak loops and writes bounded artifacts', async () => {
        const workingDirectory = await writeTempConfig({
            variables: {
                roomId: 'soak-room'
            },
            execution: {
                failFast: true,
                soak: {
                    iterations: 3,
                    delayMs: 1,
                    maxArtifactEvents: 5,
                    setupSteps: [
                        'connectAlice',
                        'connectBob'
                    ],
                    loopSteps: [
                        'aliceSendsToBob',
                        'bobSendsToAlice'
                    ],
                    cleanupSteps: [
                        'closeAlice',
                        'closeBob'
                    ]
                },
                postRunAssertions: [
                    {
                        name: 'all soak sends succeeded',
                        path: 'metrics.soak.sends.successRatio',
                        gte: 1
                    },
                    {
                        name: 'no warning diagnostics',
                        path: 'metrics.soak.diagnostics.bySeverity.warning',
                        lte: 0
                    },
                    {
                        name: 'artifact truncation recorded',
                        path: 'artifact.truncated',
                        equals: true
                    }
                ]
            },
            connections: {
                aliceRtc: {
                    type: 'rtc',
                    provider: 'rallar-memory',
                    actor: 'alice',
                    peerId: 'alice',
                    roomId: '{roomId}',
                    remotePeerId: 'bob'
                },
                bobRtc: {
                    type: 'rtc',
                    provider: 'rallar-memory',
                    actor: 'bob',
                    peerId: 'bob',
                    roomId: '{roomId}',
                    remotePeerId: 'alice'
                }
            },
            steps: [
                {
                    name: 'connectAlice',
                    type: 'rtc.connect',
                    connection: 'aliceRtc'
                },
                {
                    name: 'connectBob',
                    type: 'rtc.connect',
                    connection: 'bobRtc'
                },
                {
                    name: 'aliceSendsToBob',
                    type: 'rtc.send',
                    connection: 'aliceRtc',
                    request: {
                        send: {
                            topic: 'soak.alice',
                            toPeerId: 'bob',
                            payload: {
                                text: 'ping bob'
                            }
                        }
                    },
                    expect: {
                        connection: 'bobRtc',
                        withinMs: 1000,
                        consume: true,
                        message: {
                            topic: 'soak.alice',
                            toPeerId: 'bob',
                            payload: {
                                text: 'ping bob'
                            }
                        }
                    }
                },
                {
                    name: 'bobSendsToAlice',
                    type: 'rtc.send',
                    connection: 'bobRtc',
                    request: {
                        send: {
                            topic: 'soak.bob',
                            toPeerId: 'alice',
                            payload: {
                                text: 'ping alice'
                            }
                        }
                    },
                    expect: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        consume: true,
                        message: {
                            topic: 'soak.bob',
                            toPeerId: 'alice',
                            payload: {
                                text: 'ping alice'
                            }
                        }
                    }
                },
                {
                    name: 'closeAlice',
                    type: 'rtc.close',
                    connection: 'aliceRtc'
                },
                {
                    name: 'closeBob',
                    type: 'rtc.close',
                    connection: 'bobRtc'
                }
            ]
        });
        const artifactDir = path.join(workingDirectory, 'soak-artifacts');

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--artifact-dir',
            artifactDir
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);

        expect(report.summary.failure).toBe(0);
        expect(report.summary.soak).toMatchObject({
            sameConnection: true,
            iterations: 3,
            setupStepCount: 2,
            loopStepCount: 2,
            cleanupStepCount: 2,
            maxArtifactEvents: 5
        });
        expect(report.resultsByName.connectAlice).toHaveLength(1);
        expect(report.resultsByName.connectBob).toHaveLength(1);
        expect(report.resultsByName.aliceSendsToBob).toHaveLength(3);
        expect(report.resultsByName.bobSendsToAlice).toHaveLength(3);
        expect(report.resultsByName.closeAlice).toHaveLength(1);
        expect(report.resultsByName.closeBob).toHaveLength(1);
        expect(report.metrics.soak.sameConnection).toBe(true);
        expect(report.metrics.soak.iterationsObserved).toBe(3);
        expect(report.metrics.soak.sends.attempted).toBe(6);
        expect(report.metrics.soak.sends.successRatio).toBe(1);
        expect(report.metrics.soak.cleanup.closeSuccess).toBe(2);
        expect(report.metrics.soak.reconnects).toBe(0);
        expect(report.summary.postRunAssertions).toEqual({
            total: 3,
            success: 3,
            failure: 0
        });

        const eventsText = await readFile(path.join(artifactDir, 'events.jsonl'), 'utf8');
        const events = eventsText
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));

        expect(events).toHaveLength(6);
        expect(events.at(-1)).toMatchObject({
            kind: 'artifact-truncated',
            emittedEvents: 5
        });
    });

    it('caps soak loop execution with messageCount', async () => {
        const workingDirectory = await writeTempConfig({
            execution: {
                soak: {
                    messageCount: 5,
                    loopSteps: [
                        'loopA',
                        'loopB'
                    ]
                }
            },
            steps: [
                {
                    name: 'loopA',
                    type: 'set',
                    output: 'loopAValue',
                    value: 'a'
                },
                {
                    name: 'loopB',
                    type: 'set',
                    output: 'loopBValue',
                    value: 'b'
                }
            ]
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json'
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);

        expect(report.summary.total).toBe(5);
        expect(report.summary.soak).toMatchObject({
            iterations: 3,
            requestedMessageCount: 5,
            loopStepCount: 2
        });
        expect(report.resultsByName.loopA).toHaveLength(3);
        expect(report.resultsByName.loopB).toHaveLength(2);
        expect(report.resultsByName.loopA.map((result: { repeatIndex: number; }) => result.repeatIndex))
            .toEqual([1, 2, 3]);
        expect(report.resultsByName.loopB.map((result: { repeatIndex: number; }) => result.repeatIndex))
            .toEqual([1, 2]);
    });

    it('expands inline loop steps with deterministic pacing metadata', async () => {
        const workingDirectory = await writeTempConfig({
            steps: [
                {
                    name: 'positionLoop',
                    type: 'loop',
                    count: 3,
                    intervalMs: 1,
                    steps: [
                        {
                            name: 'frame{loop.index}',
                            type: 'set',
                            output: 'frame{loop.index}',
                            value: {
                                index: '{loop.index}',
                                iteration: '{loop.iteration}',
                                stepIndex: '{loop.stepIndex}',
                                count: '{loop.count}',
                                elapsedMs: '{loop.elapsedMs}'
                            }
                        }
                    ]
                }
            ]
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json'
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);

        expect(report.summary).toMatchObject({
            total: 5,
            success: 5,
            failure: 0
        });
        expect(report.outputs.frame1).toEqual({
            index: 1,
            iteration: 1,
            stepIndex: 1,
            count: 3,
            elapsedMs: 0
        });
        expect(report.outputs.frame2.iteration).toBe(2);
        expect(report.outputs.frame3.elapsedMs).toBe(2);
        expect(report.resultsByName.positionLoopDelay).toHaveLength(2);
        expect(report.resultsByName.positionLoopDelay.map((entry: { delayMs: number; }) => entry.delayMs))
            .toEqual([1, 1]);
        expect(report.resultsList.map((entry: { name: string; }) => entry.name))
            .toEqual(['frame1', 'positionLoopDelay', 'frame2', 'positionLoopDelay', 'frame3']);
    });

    it('preserves runtime placeholders while expanding inline loops in parallel groups', async () => {
        const workingDirectory = await writeTempConfig({
            variables: {
                runId: {
                    env: 'RALLAR_TEST_RUN_ID',
                    default: 'local'
                },
                applicationId: {
                    env: 'RALLAR_TEST_APPLICATION_ID',
                    default: 'app-{runId}'
                }
            },
            steps: [
                {
                    name: 'parallelLoop',
                    type: 'parallel',
                    groups: [
                        {
                            name: 'lane',
                            steps: [
                                {
                                    name: 'runtimeLoop',
                                    type: 'loop',
                                    count: 1,
                                    steps: [
                                        {
                                            name: 'captureToken{loop.iteration}',
                                            type: 'set',
                                            output: 'runtimeToken',
                                            value: 'token'
                                        },
                                        {
                                            name: 'captureResolvedValue{loop.iteration}',
                                            type: 'set',
                                            output: 'resolvedValue',
                                            value: '{applicationId}:{runtimeToken}:{loop.iteration}'
                                        }
                                    ]
                                }
                            ]
                        }
                    ]
                }
            ]
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json'
        ], {
            RALLAR_TEST_RUN_ID: undefined,
            RALLAR_TEST_APPLICATION_ID: undefined
        });

        expect(result.stderr).toBe('');
        expect(result.code).toBe(0);

        const report = JSON.parse(result.stdout);

        expect(report.summary.failure).toBe(0);
        expect(report.outputs.resolvedValue).toBe('app-local:token:1');
    });

    it('expands seeded traffic plans and replays the recorded plan', async () => {
        const workingDirectory = await writeTempConfig({
            execution: {
                trafficPlan: {
                    seed: 20260528,
                    count: 5,
                    operations: [
                        {
                            name: 'alpha',
                            weight: 2,
                            steps: [
                                {
                                    name: 'trafficAlpha{traffic.sequence}',
                                    type: 'set',
                                    output: 'traffic{traffic.sequence}',
                                    value: {
                                        operation: '{traffic.operation}',
                                        sequence: '{traffic.sequence}',
                                        randomInt: '{traffic.randomInt}'
                                    }
                                }
                            ]
                        },
                        {
                            name: 'beta',
                            weight: 1,
                            steps: [
                                {
                                    name: 'trafficBeta{traffic.sequence}',
                                    type: 'set',
                                    output: 'traffic{traffic.sequence}',
                                    value: {
                                        operation: '{traffic.operation}',
                                        sequence: '{traffic.sequence}',
                                        randomInt: '{traffic.randomInt}'
                                    }
                                }
                            ]
                        }
                    ]
                }
            },
            steps: []
        });
        const artifactDir = path.join(workingDirectory, 'traffic-artifacts');

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--artifact-dir',
            artifactDir
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);
        const expandedPlan = JSON.parse(await readFile(path.join(artifactDir, 'expanded-plan.json'), 'utf8'));

        expect(report.summary.trafficPlan).toMatchObject({
            seed: 20260528,
            replay: false,
            decisionCount: 5,
            stepCount: 5
        });
        expect(expandedPlan.decisions).toHaveLength(5);
        expect(expandedPlan.steps).toHaveLength(5);
        expect(expandedPlan.steps[0].name).toMatch(/^traffic/);
        expect(expandedPlan.runnerRunId).toBe(report.runnerRunId);
        expect(expandedPlan.correlation.runnerRunId).toBe(report.runnerRunId);
        expect(expandedPlan.replayRecipe.execution.correlation.runnerRunId).toBe(report.runnerRunId);
        expect(report.outputs.traffic1.sequence).toBe(1);

        await writeFile(
            path.join(workingDirectory, 'replay.json'),
            JSON.stringify(
                {
                    execution: {
                        trafficPlan: {
                            replayFrom: 'traffic-artifacts/expanded-plan.json'
                        }
                    },
                    steps: []
                },
                null,
                2
            )
        );

        const replay = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'replay.json'
        ]);
        const replayReport = JSON.parse(replay.stdout);

        expect(replay.code).toBe(0);
        expect(replayReport.summary.trafficPlan).toMatchObject({
            seed: 20260528,
            replay: true,
            decisionCount: 5,
            stepCount: 5
        });
        expect(replayReport.resultsList.map((entry: { name: string; }) => entry.name))
            .toEqual(report.resultsList.map((entry: { name: string; }) => entry.name));
        expect(replayReport.outputs).toEqual(report.outputs);
    });

    it('records traffic plan rate, burst, and max-in-flight pacing in expanded plans', async () => {
        const workingDirectory = await writeTempConfig({
            execution: {
                trafficPlan: {
                    seed: 20260601,
                    count: 5,
                    rateHz: 20,
                    jitterMs: 0,
                    burstSize: 2,
                    maxInFlight: 2,
                    operations: [
                        {
                            name: 'position',
                            weight: 1,
                            steps: [
                                {
                                    name: 'position{traffic.sequence}',
                                    type: 'set',
                                    output: 'position{traffic.sequence}',
                                    value: {
                                        sequence: '{traffic.sequence}',
                                        operation: '{traffic.operation}'
                                    }
                                }
                            ]
                        }
                    ]
                }
            },
            steps: []
        });
        const artifactDir = path.join(workingDirectory, 'traffic-pacing-artifacts');

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json',
            '--artifact-dir',
            artifactDir
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);
        const expandedPlan = JSON.parse(await readFile(path.join(artifactDir, 'expanded-plan.json'), 'utf8'));

        expect(report.summary.trafficPlan).toMatchObject({
            seed: 20260601,
            replay: false,
            decisionCount: 5,
            stepCount: 7
        });
        expect(expandedPlan.generator.pacing).toMatchObject({
            rateHz: 20,
            intervalMs: 50,
            jitterMs: 0,
            burstSize: 2,
            maxInFlight: 2
        });
        expect(expandedPlan.decisions.map((decision: { delayMs: number; }) => decision.delayMs))
            .toEqual([0, 50, 0, 50, 0]);
        expect(expandedPlan.steps.map((step: { name: string; }) => step.name))
            .toEqual([
                'position1',
                'position2',
                'trafficDelay',
                'position3',
                'position4',
                'trafficDelay',
                'position5'
            ]);
        expect(report.resultsByName.trafficDelay.map((entry: { delayMs: number; }) => entry.delayMs))
            .toEqual([50, 50]);

        await writeFile(
            path.join(workingDirectory, 'replay-pacing.json'),
            JSON.stringify(
                {
                    execution: {
                        trafficPlan: {
                            replayFrom: 'traffic-pacing-artifacts/expanded-plan.json'
                        }
                    },
                    steps: []
                },
                null,
                2
            )
        );

        const replay = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'replay-pacing.json'
        ]);
        const replayReport = JSON.parse(replay.stdout);

        expect(replay.code).toBe(0);
        expect(replayReport.summary.trafficPlan).toMatchObject({
            seed: 20260601,
            replay: true,
            decisionCount: 5,
            stepCount: 7
        });
        expect(replayReport.resultsList.map((entry: { name: string; }) => entry.name))
            .toEqual(report.resultsList.map((entry: { name: string; }) => entry.name));
        expect(replayReport.outputs).toEqual(report.outputs);
    });

    it('runs bounded parallel step groups with deterministic report ordering', async () => {
        const workingDirectory = await writeTempConfig({
            steps: [
                {
                    name: 'parallelSets',
                    type: 'parallel',
                    maxConcurrency: 2,
                    groups: [
                        {
                            name: 'left',
                            steps: [
                                {
                                    name: 'setLeft',
                                    type: 'set',
                                    output: 'left',
                                    value: 'left-value'
                                }
                            ]
                        },
                        {
                            name: 'right',
                            steps: [
                                {
                                    name: 'setRight',
                                    type: 'set',
                                    output: 'right',
                                    value: 'right-value'
                                }
                            ]
                        }
                    ]
                }
            ]
        });

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'config.json'
        ]);

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');

        const report = JSON.parse(result.stdout);

        expect(report.summary).toMatchObject({
            total: 3,
            success: 3,
            failure: 0
        });
        expect(report.resultsByName.parallelSets[0].actual).toMatchObject({
            groupCount: 2,
            maxConcurrency: 2,
            success: 2,
            failure: 0
        });
        expect(report.outputs).toMatchObject({
            left: 'left-value',
            right: 'right-value'
        });
        expect(report.resultsList.map((entry: { name: string; }) => entry.name))
            .toEqual(['parallelSets', 'setLeft', 'setRight']);
    });

    it('returns useful error when config file is missing', async () => {
        const workingDirectory = await mkdtemp(
            path.join(tmpdir(), 'scenario-black-box-missing-config-')
        );

        const result = await runScenarioCli([
            '-w',
            workingDirectory,
            '-c',
            'does-not-exist.json'
        ]);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('does-not-exist.json');
    });
});
