// deno-lint-ignore-file no-explicit-any

import { resolveVariableByEnv } from './resolve-variable-by-env.ts'

type JsonRecord = Record<string, unknown>

export type BlackBoxRunnerLivePreflightStatus = 'passed' | 'failed' | 'skipped'

export type BlackBoxRunnerLivePreflightCheckKind =
    | 'env'
    | 'rallar-api-base-url'
    | 'rallar-api-config'
    | 'cors-origin'
    | 'auth-login'
    | 'group-permission'
    | 'ws-ticket'
    | 'ws-upgrade'
    | 'ice-config'
    | 'control-server'
    | 'playwright'

export type BlackBoxRunnerLivePreflightCheck = Readonly<{
    id: string
    kind: BlackBoxRunnerLivePreflightCheckKind
    label: string
    status: BlackBoxRunnerLivePreflightStatus
    target?: string
    code?: string
    message?: string
    durationMs?: number
    details?: JsonRecord
}>

export type BlackBoxRunnerLivePreflightIssue = Readonly<{
    severity: 'error'
    code: string
    message: string
    checkId: string
    target?: string
}>

export type BlackBoxRunnerLivePreflightReport = Readonly<{
    schemaVersion: 1
    generatedAtEpochMs: number
    mode: 'live-environment'
    ok: boolean
    entryId?: string
    profile?: string
    recipe?: string
    vocabulary: readonly string[]
    requirements: Readonly<{
        env: readonly Readonly<{ name: string; present: boolean }>[]
        rallarApiBaseUrl?: string
        controlServerBaseUrl?: string
        credentials: readonly Readonly<{ id: string; usernameSource: string; passwordSource: string }>[]
        checks: readonly BlackBoxRunnerLivePreflightCheckKind[]
    }>
    summary: Readonly<{
        total: number
        passed: number
        failed: number
        skipped: number
    }>
    checks: readonly BlackBoxRunnerLivePreflightCheck[]
    issues: readonly BlackBoxRunnerLivePreflightIssue[]
    skipReasons: readonly string[]
}>

export type BlackBoxRunnerLivePreflightHttpServiceRequirement = Readonly<{
    name: string
    env: string
    default?: string
    path?: string
}>

export type BlackBoxRunnerLivePreflightMatrixRequirement = Readonly<{
    env?: readonly string[]
    httpServices?: readonly BlackBoxRunnerLivePreflightHttpServiceRequirement[]
    playwright?: boolean
    livePreflight?: JsonRecord
}>

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type WebSocketLike = {
    close?: () => void
    addEventListener?: (type: 'open' | 'error' | 'close', listener: (event: any) => void) => void
    onopen?: ((event: any) => void) | null
    onerror?: ((event: any) => void) | null
    onclose?: ((event: any) => void) | null
}

type WebSocketConstructorLike = new (url: string) => WebSocketLike

type CredentialPair = Readonly<{
    id: string
    username: string
    password: string
    usernameSource: string
    passwordSource: string
}>

type AuthSession = Readonly<{
    id: string
    username: string
    clientId: string
    sessionId: string
    accessToken: string
}>

export type BlackBoxRunnerLivePreflightInput = Readonly<{
    entryId?: string
    profile?: string
    recipe?: string
    config?: JsonRecord
    requires?: BlackBoxRunnerLivePreflightMatrixRequirement
    environment?: Record<string, string | undefined>
    timeoutMs?: number
    fetchImplementation?: FetchLike
    webSocketImplementation?: WebSocketConstructorLike
    checkPlaywright?: () => Promise<boolean>
    now?: () => number
}>

const VOCABULARY: readonly BlackBoxRunnerLivePreflightCheckKind[] = [
    'env',
    'rallar-api-base-url',
    'rallar-api-config',
    'cors-origin',
    'auth-login',
    'group-permission',
    'ws-ticket',
    'ws-upgrade',
    'ice-config',
    'control-server',
    'playwright',
]

class LivePreflightCheckError extends Error {
    readonly code: string;
    readonly details: JsonRecord;

    constructor(
        code: string,
        message: string,
        details: JsonRecord = {},
    ) {
        super(message)
        this.code = code;
        this.details = details;
    }
}

export function shouldRunBlackBoxRunnerLivePreflight(
    input: Pick<BlackBoxRunnerLivePreflightInput, 'config' | 'requires'>,
): boolean {
    const requires = input.requires
    const configText = JSON.stringify(input.config ?? {})
    return Boolean(
        requires?.env?.length ||
            requires?.httpServices?.length ||
            requires?.playwright === true ||
            Object.keys(asRecord(requires?.livePreflight)).length > 0 ||
            configText.includes('RALLAR_API_BASE_URL') ||
            configText.includes('rallarApiBaseUrl') ||
            configText.includes('rallar-browser') ||
            configText.includes('rallar-remote-browser') ||
            configText.includes('/api/auth/ws-ticket') ||
            configText.includes('/api/state/apps/'),
    )
}

export function blackBoxRunnerLivePreflightSkipReasons(
    report: Pick<BlackBoxRunnerLivePreflightReport, 'skipReasons'>,
): readonly string[] {
    return report.skipReasons
}

export async function runBlackBoxRunnerLivePreflight(
    input: BlackBoxRunnerLivePreflightInput,
): Promise<BlackBoxRunnerLivePreflightReport> {
    const now = input.now ?? (() => Date.now())
    const checks: BlackBoxRunnerLivePreflightCheck[] = []
    const issues: BlackBoxRunnerLivePreflightIssue[] = []
    const environment = input.environment ?? {}
    const requires = input.requires ?? {}
    const config = input.config ?? {}
    const spec = livePreflightSpec(config, requires)
    const requiredEnv = uniqueValues([
        ...Array.from(requires.env ?? []),
        ...stringList(spec.requiredEnv),
    ])
    const timeoutMs = positiveInteger(spec.timeoutMs) ?? input.timeoutMs ?? 1500
    const fetchImplementation = input.fetchImplementation ?? globalThis.fetch?.bind(globalThis)
    const webSocketImplementation = input.webSocketImplementation ??
        (globalThis as unknown as { WebSocket?: WebSocketConstructorLike }).WebSocket
    const credentialPairs = toCredentialPairs(config, environment)
    const rallarApiBaseUrl = toRallarApiBaseUrl(config, requires, environment)
    const controlServerBaseUrl = toControlServerBaseUrl(config, requires, environment)
    const requestedChecks = requestedLiveChecks(config, requires, spec, {
        rallarApiBaseUrl,
        controlServerBaseUrl,
        credentialPairs,
        environment,
    })

    requiredEnv.forEach(name => {
        const present = hasEnv(environment, name)
        const check = {
            id: `env:${name}`,
            kind: 'env' as const,
            label: `Environment variable ${name}`,
            status: present ? 'passed' as const : 'failed' as const,
            target: name,
            ...(present ? {} : {
                code: 'MISSING_ENV',
                message: `Missing environment variable ${name}.`,
            }),
        }
        checks.push(check)
        if (!present) {
            issues.push(toIssue(check, 'MISSING_ENV', `Missing environment variable ${name}.`))
        }
    })

    const hasMissingRequiredEnv = requiredEnv.some(name => !hasEnv(environment, name))

    if (requestedChecks.includes('rallar-api-base-url')) {
        if (rallarApiBaseUrl) {
            recordPassed(checks, 'rallar-api-base-url', 'rallar-api-base-url', 'Rallar API base URL', rallarApiBaseUrl)
        } else {
            recordFailed(
                checks,
                issues,
                'rallar-api-base-url',
                'rallar-api-base-url',
                'Rallar API base URL',
                'RALLAR_API_BASE_URL_MISSING',
                'Rallar API base URL is missing.',
            )
        }
    }

    const dependencyBlocked = hasMissingRequiredEnv || !rallarApiBaseUrl
    if (dependencyBlocked) {
        requestedChecks
            .filter(kind => kind !== 'env' && kind !== 'rallar-api-base-url' && kind !== 'playwright')
            .forEach(kind => {
                recordSkipped(
                    checks,
                    kind,
                    toCheckId(kind),
                    toCheckLabel(kind),
                    hasMissingRequiredEnv
                        ? 'Skipped because required environment variables are missing.'
                        : 'Skipped because the Rallar API base URL is missing.',
                )
            })
    } else if (rallarApiBaseUrl) {
        if (requestedChecks.includes('rallar-api-config')) {
            await recordAsyncCheck(
                checks,
                issues,
                'rallar-api-config',
                'rallar-api-config',
                'Rallar API /api/config',
                urlJoin(rallarApiBaseUrl, '/api/config'),
                now,
                async () => {
                    const response = await fetchResponse(fetchImplementation, urlJoin(rallarApiBaseUrl, '/api/config'), {
                        method: 'GET',
                    }, timeoutMs)
                    assertStatus(response, [200], 'RALLAR_API_CONFIG_UNAVAILABLE', '/api/config did not return HTTP 200.')
                    await readJson(response)
                    return {
                        status: response.status,
                    }
                },
            )
        }

        const corsOrigin = stringValue(spec.corsOrigin) ?? envValue(environment, 'RALLAR_PREFLIGHT_CORS_ORIGIN')
        if (requestedChecks.includes('cors-origin')) {
            if (!corsOrigin) {
                recordSkipped(checks, 'cors-origin', 'cors-origin', 'Configured CORS origin', 'No CORS origin configured.')
            } else {
                const configUrl = urlJoin(rallarApiBaseUrl, '/api/config')
                await recordAsyncCheck(
                    checks,
                    issues,
                    'cors-origin',
                    'cors-origin',
                    'Configured CORS origin',
                    configUrl,
                    now,
                    async () => {
                        const response = await fetchResponse(fetchImplementation, configUrl, {
                            method: 'GET',
                            headers: {
                                Origin: corsOrigin,
                            },
                        }, timeoutMs)
                        const allowed = response.headers.get('access-control-allow-origin')
                        if (allowed !== '*' && allowed !== corsOrigin) {
                            throw new LivePreflightCheckError(
                                'CORS_ORIGIN_NOT_ALLOWED',
                                `CORS origin ${corsOrigin} was not allowed by /api/config.`,
                                {
                                    origin: corsOrigin,
                                    allowOrigin: allowed,
                                },
                            )
                        }
                        return {
                            origin: corsOrigin,
                            allowOrigin: allowed,
                        }
                    },
                )
            }
        }
        const sessions: AuthSession[] = [], missingPair = 'No configured credential pair found.'
        if (requestedChecks.includes('auth-login')) {
            if (credentialPairs.length <= 0) {
                recordSkipped(checks, 'auth-login', 'auth-login', 'Configured user credentials', missingPair)
            } else {
                for (const pair of credentialPairs) {
                    const loginPath = mutationPath('/api/auth/login', crypto.randomUUID())
                    const result = await recordAsyncCheck(
                        checks,
                        issues,
                        'auth-login',
                        `auth-login:${pair.id}`,
                        `Rallar auth login for ${pair.id}`,
                        urlJoin(rallarApiBaseUrl, loginPath),
                        now,
                        async () => {
                            const response = await fetchResponse(fetchImplementation, urlJoin(rallarApiBaseUrl, loginPath), {
                                method: 'POST',
                                headers: jsonHeaders(),
                                body: JSON.stringify({
                                    username: pair.username,
                                    password: pair.password,
                                }),
                            }, timeoutMs)
                            assertStatus(response, [200], 'BAD_AUTH', `Login failed for configured user ${pair.id}.`)
                            const body = await readJson(response)
                            const accessToken = stringValue(body.accessToken)
                            const clientId = stringValue(body.clientId)
                            const sessionId = stringValue(body.sessionId)
                            if (!accessToken || !clientId || !sessionId) {
                                throw new LivePreflightCheckError(
                                    'BAD_AUTH_RESPONSE',
                                    `Login response for configured user ${pair.id} did not include session fields.`,
                                )
                            }
                            return {
                                session: {
                                    id: pair.id,
                                    username: pair.username,
                                    clientId,
                                    sessionId,
                                    accessToken,
                                },
                                details: {
                                    username: pair.username,
                                    clientId,
                                    sessionId,
                                },
                            }
                        },
                    )
                    if (isRecord(result.value?.session)) {
                        sessions.push(result.value.session as AuthSession)
                    }
                }
            }
        }

        const primarySession = sessions[0]
        if (requestedChecks.includes('group-permission')) {
            if (!primarySession) {
                recordSkipped(checks, 'group-permission', 'group-permission', 'Group create/join permission', 'No authenticated session available.')
            } else {
                await recordAsyncCheck(
                    checks,
                    issues,
                    'group-permission',
                    'group-permission',
                    'Group create/join permission',
                    rallarApiBaseUrl,
                    now,
                    async () => {
                        const group = toPreflightGroup(input, environment, spec)
                        const createPath = `/api/state/apps/${encodeURIComponent(group.applicationId)}/workspaces/${
                            encodeURIComponent(group.workspaceId)
                        }/groups`
                        const createMutationPath = mutationPath(createPath, crypto.randomUUID())
                        const createResponse = await fetchResponse(fetchImplementation, urlJoin(rallarApiBaseUrl, createMutationPath), {
                            method: 'POST',
                            headers: authHeaders(primarySession),
                            body: JSON.stringify({
                                groupId: group.groupId,
                                displayName: group.groupName,
                                kind: 'room',
                                joinMode: 'open',
                                createdByPrincipalId: primarySession.clientId,
                            }),
                        }, timeoutMs)
                        assertStatus(
                            createResponse,
                            [200, 201, 409],
                            'GROUP_CREATE_FORBIDDEN',
                            'Group create permission check failed.',
                        )

                        const joinPath = `${createPath}/${encodeURIComponent(group.groupId)}/members/${
                            encodeURIComponent(primarySession.clientId)
                        }`
                        const joinMutationPath = mutationPath(joinPath, crypto.randomUUID())
                        const joinResponse = await fetchResponse(fetchImplementation, urlJoin(rallarApiBaseUrl, joinMutationPath), {
                            method: 'PUT',
                            headers: authHeaders(primarySession),
                            body: JSON.stringify({
                                status: 'active',
                            }),
                        }, timeoutMs)
                        assertStatus(joinResponse, [200, 201], 'GROUP_JOIN_FORBIDDEN', 'Group join permission check failed.')
                        return {
                            groupId: group.groupId,
                            applicationId: group.applicationId,
                            workspaceId: group.workspaceId,
                        }
                    },
                )
            }
        }

        let wsTicket: JsonRecord | undefined
        if (requestedChecks.includes('ws-ticket')) {
            if (!primarySession) {
                recordSkipped(checks, 'ws-ticket', 'ws-ticket', 'WebSocket ticket', 'No authenticated session available.')
            } else {
                const wsTicketPath = mutationPath('/api/auth/ws-ticket', crypto.randomUUID())
                const result = await recordAsyncCheck(
                    checks,
                    issues,
                    'ws-ticket',
                    'ws-ticket',
                    'WebSocket ticket',
                    urlJoin(rallarApiBaseUrl, wsTicketPath),
                    now,
                    async () => {
                        const response = await fetchResponse(fetchImplementation, urlJoin(rallarApiBaseUrl, wsTicketPath), {
                            method: 'POST',
                            headers: authHeaders(primarySession),
                            body: JSON.stringify({}),
                        }, timeoutMs)
                        assertStatus(response, [200], 'WS_TICKET_UNAVAILABLE', 'WebSocket ticket request failed.')
                        const body = await readJson(response)
                        if (!stringValue(body.ticket) || !stringValue(body.sessionId)) {
                            throw new LivePreflightCheckError('BAD_WS_TICKET_RESPONSE', 'WebSocket ticket response was missing ticket fields.')
                        }
                        return {
                            sessionId: body.sessionId,
                            expiresAtEpochMs: body.expiresAtEpochMs,
                            ticket: body.ticket,
                            details: {
                                sessionId: body.sessionId,
                                expiresAtEpochMs: body.expiresAtEpochMs,
                            },
                        }
                    },
                )
                wsTicket = result.value
            }
        }

        if (requestedChecks.includes('ws-upgrade')) {
            if (!primarySession || !wsTicket) {
                recordSkipped(checks, 'ws-upgrade', 'ws-upgrade', 'WebSocket upgrade', 'No WebSocket ticket available.')
            } else if (!webSocketImplementation) {
                recordFailed(
                    checks,
                    issues,
                    'ws-upgrade',
                    'ws-upgrade',
                    'WebSocket upgrade',
                    'WEBSOCKET_UNAVAILABLE',
                    'No WebSocket implementation is available for live preflight.',
                )
            } else {
                await recordAsyncCheck(
                    checks,
                    issues,
                    'ws-upgrade',
                    'ws-upgrade',
                    'WebSocket upgrade',
                    toRedactedWsUrl(rallarApiBaseUrl, String(wsTicket.sessionId)),
                    now,
                    async () => await openWebSocket(
                        webSocketImplementation,
                        toWsUrl(rallarApiBaseUrl, String(wsTicket.sessionId), String(wsTicket.ticket)),
                        timeoutMs,
                    ),
                )
            }
        }

        if (requestedChecks.includes('ice-config')) {
            if (!primarySession) {
                recordSkipped(checks, 'ice-config', 'ice-config', 'ICE config availability', 'No authenticated session available.')
            } else {
                await recordAsyncCheck(
                    checks,
                    issues,
                    'ice-config',
                    'ice-config',
                    'ICE config availability',
                    urlJoin(rallarApiBaseUrl, '/api/webrtc/ice'),
                    now,
                    async () => {
                        const response = await fetchResponse(fetchImplementation, urlJoin(rallarApiBaseUrl, '/api/webrtc/ice'), {
                            method: 'GET',
                            headers: authHeaders(primarySession),
                        }, timeoutMs)
                        assertStatus(response, [200], 'ICE_CONFIG_UNAVAILABLE', 'ICE config request failed.')
                        const body = await readJson(response)
                        if (!Array.isArray(body.iceServers)) {
                            throw new LivePreflightCheckError('BAD_ICE_CONFIG_RESPONSE', 'ICE config response did not include iceServers.')
                        }
                        return {
                            iceServerCount: body.iceServers.length,
                        }
                    },
                )
            }
        }
    }

    if (requestedChecks.includes('control-server')) {
        if (!controlServerBaseUrl) {
            recordFailed(
                checks,
                issues,
                'control-server',
                'control-server',
                'Rallar black-box control server',
                'CONTROL_SERVER_URL_MISSING',
                'Rallar black-box control server URL is missing.',
            )
        } else if (hasMissingRequiredEnv) {
            recordSkipped(checks, 'control-server', 'control-server', 'Rallar black-box control server', 'Skipped because required environment variables are missing.')
        } else {
            await recordAsyncCheck(
                checks,
                issues,
                'control-server',
                'control-server',
                'Rallar black-box control server',
                controlServerBaseUrl,
                now,
                async () => {
                    const response = await fetchResponse(fetchImplementation, controlServerBaseUrl, {
                        method: 'GET',
                    }, timeoutMs)
                    if (response.status >= 500) {
                        throw new LivePreflightCheckError(
                            'CONTROL_SERVER_UNAVAILABLE',
                            `Control server returned HTTP ${response.status}.`,
                            {
                                status: response.status,
                            },
                        )
                    }
                    return {
                        status: response.status,
                    }
                },
            )
        }
    }

    if (requestedChecks.includes('playwright')) {
        await recordAsyncCheck(
            checks,
            issues,
            'playwright',
            'playwright',
            'Playwright CLI',
            undefined,
            now,
            async () => {
                if (!input.checkPlaywright) {
                    throw new LivePreflightCheckError('PLAYWRIGHT_CHECK_UNAVAILABLE', 'No Playwright checker is available.')
                }
                const available = await input.checkPlaywright()
                if (!available) {
                    throw new LivePreflightCheckError(
                        'PLAYWRIGHT_UNAVAILABLE',
                        'Playwright CLI is unavailable; run npm install and install Playwright browsers for live browser recipes.',
                    )
                }
                return {}
            },
        )
    }

    const summary = summarizeChecks(checks)
    return {
        schemaVersion: 1,
        generatedAtEpochMs: now(),
        mode: 'live-environment',
        ok: issues.length <= 0,
        ...(input.entryId ? { entryId: input.entryId } : {}),
        ...(input.profile ? { profile: input.profile } : {}),
        ...(input.recipe ? { recipe: input.recipe } : {}),
        vocabulary: VOCABULARY,
        requirements: {
            env: requiredEnv.map(name => ({
                name,
                present: hasEnv(environment, name),
            })),
            ...(rallarApiBaseUrl ? { rallarApiBaseUrl } : {}),
            ...(controlServerBaseUrl ? { controlServerBaseUrl } : {}),
            credentials: credentialPairs.map(pair => ({
                id: pair.id,
                usernameSource: pair.usernameSource,
                passwordSource: pair.passwordSource,
            })),
            checks: requestedChecks,
        },
        summary,
        checks,
        issues,
        skipReasons: issues.map(issue => issue.message),
    }
}

function mutationPath(path: string, requestId: string): string {
    return `${path}/requests/${encodeURIComponent(requestId)}`
}

function livePreflightSpec(config: JsonRecord, requires: BlackBoxRunnerLivePreflightMatrixRequirement): JsonRecord {
    return {
        ...asRecord(asRecord(config.execution).livePreflight),
        ...asRecord(requires.livePreflight),
    }
}

function requestedLiveChecks(
    config: JsonRecord,
    requires: BlackBoxRunnerLivePreflightMatrixRequirement,
    spec: JsonRecord,
    resolved: Readonly<{
        rallarApiBaseUrl?: string
        controlServerBaseUrl?: string
        credentialPairs: readonly CredentialPair[]
        environment: Record<string, string | undefined>
    }>,
): readonly BlackBoxRunnerLivePreflightCheckKind[] {
    const configText = JSON.stringify(config)
    const checks: BlackBoxRunnerLivePreflightCheckKind[] = []
    const hasRallarApiService = (requires.httpServices ?? [])
        .some(service => service.env === 'RALLAR_API_BASE_URL' || /rallar api/i.test(service.name))

    if (requires.env?.length) {
        checks.push('env')
    }
    if (hasRallarApiService || resolved.rallarApiBaseUrl || spec.rallarApi === true) {
        checks.push('rallar-api-base-url', 'rallar-api-config')
    }
    if (stringValue(spec.corsOrigin) || envValue(resolved.environment, 'RALLAR_PREFLIGHT_CORS_ORIGIN') || spec.cors === true) {
        checks.push('cors-origin')
    }
    if (resolved.credentialPairs.length > 0 || spec.auth === true) {
        checks.push('auth-login')
    }
    if (spec.group === true || configText.includes('/api/state/apps/') || configText.includes('"roomRef"')) {
        checks.push('group-permission')
    }
    if (spec.ws === true || configText.includes('/api/auth/ws-ticket') || hasBrowserBackedProvider(configText)) {
        checks.push('ws-ticket', 'ws-upgrade')
    }
    if (spec.ice === true || hasBrowserBackedProvider(configText)) {
        checks.push('ice-config')
    }
    if (resolved.controlServerBaseUrl || spec.controlServer === true) {
        checks.push('control-server')
    }
    if (requires.playwright === true) {
        checks.push('playwright')
    }

    return uniqueCheckKinds(checks.filter(kind => kind !== 'env' || Boolean(requires.env?.length)))
}

function hasBrowserBackedProvider(configText: string): boolean {
    return configText.includes('rallar-browser') || configText.includes('rallar-remote-browser')
}

function toRallarApiBaseUrl(
    config: JsonRecord,
    requires: BlackBoxRunnerLivePreflightMatrixRequirement,
    environment: Record<string, string | undefined>,
): string | undefined {
    const service = (requires.httpServices ?? [])
        .find(candidate => candidate.env === 'RALLAR_API_BASE_URL' || /rallar api/i.test(candidate.name))
    return normalizeBaseUrl(
        envValue(environment, service?.env) ??
            resolveVariableByEnv(config, 'RALLAR_API_BASE_URL', environment) ??
            service?.default,
    )
}

function toControlServerBaseUrl(
    config: JsonRecord,
    requires: BlackBoxRunnerLivePreflightMatrixRequirement,
    environment: Record<string, string | undefined>,
): string | undefined {
    const service = (requires.httpServices ?? [])
        .find(candidate =>
            candidate.env === 'RALLAR_BLACK_BOX_CONTROL_BASE_URL' ||
            /control server/i.test(candidate.name)
        )
    return normalizeBaseUrl(
        envValue(environment, service?.env) ??
            resolveVariableByEnv(config, 'RALLAR_BLACK_BOX_CONTROL_BASE_URL', environment) ??
            service?.default,
    )
}

function toCredentialPairs(config: JsonRecord, environment: Record<string, string | undefined>): readonly CredentialPair[] {
    const candidates = [
        {
            id: 'alice',
            usernameEnv: 'RALLAR_ALICE_USERNAME',
            passwordEnv: 'RALLAR_ALICE_PASSWORD',
        },
        {
            id: 'bob',
            usernameEnv: 'RALLAR_BOB_USERNAME',
            passwordEnv: 'RALLAR_BOB_PASSWORD',
        },
        {
            id: 'default',
            usernameEnv: 'RALLAR_BB_USERNAME',
            passwordEnv: 'RALLAR_BB_PASSWORD',
        },
    ]

    return candidates.flatMap(candidate => {
        const username = resolveVariableByEnv(config, candidate.usernameEnv, environment)
        const password = resolveVariableByEnv(config, candidate.passwordEnv, environment)
        return username && password
            ? [{
                id: candidate.id,
                username,
                password,
                usernameSource: candidate.usernameEnv,
                passwordSource: candidate.passwordEnv,
            }]
            : []
    })
}

function toPreflightGroup(
    input: BlackBoxRunnerLivePreflightInput,
    environment: Record<string, string | undefined>,
    spec: JsonRecord,
): Readonly<{ applicationId: string; workspaceId: string; groupId: string; groupName: string }> {
    const config = input.config ?? {}
    const groupId = stringValue(spec.groupId) ??
        envValue(environment, 'RALLAR_BB_PREFLIGHT_GROUP_ID') ??
        toPreflightGroupId(input.entryId, envValue(environment, 'RALLAR_BB_RUN_ID'))
    return {
        applicationId: stringValue(spec.applicationId) ??
            resolveVariableByEnv(config, 'RALLAR_BB_APPLICATION_ID', environment) ??
            'black-box-app',
        workspaceId: stringValue(spec.workspaceId) ??
            resolveVariableByEnv(config, 'RALLAR_BB_WORKSPACE_ID', environment) ??
            'default',
        groupId,
        groupName: stringValue(spec.groupName) ??
            resolveVariableByEnv(config, 'RALLAR_BB_GROUP_NAME', environment) ??
            groupId,
    }
}

function toPreflightGroupId(entryId: string | undefined, runId: string | undefined): string {
    return ['bb-live-preflight', entryId, runId]
        .filter((value): value is string => Boolean(value))
        .join('-')
}

async function recordAsyncCheck(
    checks: BlackBoxRunnerLivePreflightCheck[],
    issues: BlackBoxRunnerLivePreflightIssue[],
    kind: BlackBoxRunnerLivePreflightCheckKind,
    id: string,
    label: string,
    target: string | undefined,
    now: () => number,
    action: () => Promise<JsonRecord>,
): Promise<{ value?: JsonRecord }> {
    const startedAt = now()
    try {
        const value = await action()
        const durationMs = now() - startedAt
        const details = isRecord(value.details)
            ? value.details
            : value
        checks.push({
            id,
            kind,
            label,
            status: 'passed',
            ...(target ? { target } : {}),
            durationMs,
            ...(Object.keys(details).length > 0 ? { details } : {}),
        })
        return {
            value,
        }
    } catch (error) {
        const durationMs = now() - startedAt
        const code = error instanceof LivePreflightCheckError
            ? error.code
            : 'LIVE_PREFLIGHT_CHECK_FAILED'
        const message = error instanceof Error ? error.message : String(error)
        const check = {
            id,
            kind,
            label,
            status: 'failed' as const,
            ...(target ? { target } : {}),
            code,
            message,
            durationMs,
            ...(error instanceof LivePreflightCheckError && Object.keys(error.details).length > 0
                ? { details: error.details }
                : {}),
        }
        checks.push(check)
        issues.push(toIssue(check, code, message))
        return {}
    }
}

function recordPassed(
    checks: BlackBoxRunnerLivePreflightCheck[],
    kind: BlackBoxRunnerLivePreflightCheckKind,
    id: string,
    label: string,
    target?: string,
): void {
    checks.push({
        id,
        kind,
        label,
        status: 'passed',
        ...(target ? { target } : {}),
    })
}

function recordSkipped(
    checks: BlackBoxRunnerLivePreflightCheck[],
    kind: BlackBoxRunnerLivePreflightCheckKind,
    id: string,
    label: string,
    message: string,
): void {
    checks.push({
        id,
        kind,
        label,
        status: 'skipped',
        message,
    })
}

function recordFailed(
    checks: BlackBoxRunnerLivePreflightCheck[],
    issues: BlackBoxRunnerLivePreflightIssue[],
    kind: BlackBoxRunnerLivePreflightCheckKind,
    id: string,
    label: string,
    code: string,
    message: string,
    target?: string,
): void {
    const check = {
        id,
        kind,
        label,
        status: 'failed' as const,
        code,
        message,
        ...(target ? { target } : {}),
    }
    checks.push(check)
    issues.push(toIssue(check, code, message))
}

function toIssue(check: BlackBoxRunnerLivePreflightCheck, code: string, message: string): BlackBoxRunnerLivePreflightIssue {
    return {
        severity: 'error',
        code,
        message,
        checkId: check.id,
        ...(check.target ? { target: check.target } : {}),
    }
}

async function fetchResponse(
    fetchImplementation: FetchLike | undefined,
    url: string,
    init: RequestInit,
    timeoutMs: number,
): Promise<Response> {
    if (!fetchImplementation) {
        throw new LivePreflightCheckError('FETCH_UNAVAILABLE', 'No fetch implementation is available for live preflight.')
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
        return await fetchImplementation(url, {
            ...init,
            signal: controller.signal,
        })
    } catch (error) {
        throw new LivePreflightCheckError(
            'HTTP_SERVICE_UNAVAILABLE',
            error instanceof Error ? error.message : String(error),
        )
    } finally {
        clearTimeout(timeout)
    }
}

function assertStatus(response: Response, accepted: readonly number[], code: string, message: string): void {
    if (!accepted.includes(response.status)) {
        throw new LivePreflightCheckError(code, `${message} HTTP ${response.status}.`, {
            status: response.status,
        })
    }
}

async function readJson(response: Response): Promise<JsonRecord> {
    try {
        const value = await response.json()
        return asRecord(value)
    } catch (_error) {
        throw new LivePreflightCheckError('BAD_JSON_RESPONSE', 'Response was not valid JSON.')
    }
}

async function openWebSocket(
    WebSocketImplementation: WebSocketConstructorLike,
    url: string,
    timeoutMs: number,
): Promise<JsonRecord> {
    return await new Promise<JsonRecord>((resolve, reject) => {
        const socket = new WebSocketImplementation(url)
        let settled = false
        const timeout = setTimeout(() => {
            finish(() => reject(new LivePreflightCheckError('WS_UPGRADE_TIMEOUT', 'WebSocket upgrade timed out.')))
        }, timeoutMs)
        const finish = (complete: () => void): void => {
            if (settled) {
                return
            }
            settled = true
            clearTimeout(timeout)
            complete()
        }
        const closeSocket = (): void => {
            try {
                socket.close?.()
            } catch (_error) {
                // Closing is best-effort; the preflight already proved upgrade success.
            }
        }
        const onOpen = (): void => {
            finish(() => {
                closeSocket()
                resolve({
                    upgraded: true,
                })
            })
        }
        const onError = (): void => {
            finish(() => reject(new LivePreflightCheckError('WS_UPGRADE_FAILED', 'WebSocket upgrade failed.')))
        }
        const onClose = (): void => {
            if (!settled) {
                finish(() => reject(new LivePreflightCheckError('WS_UPGRADE_CLOSED', 'WebSocket closed before opening.')))
            }
        }

        if (socket.addEventListener) {
            socket.addEventListener('open', onOpen)
            socket.addEventListener('error', onError)
            socket.addEventListener('close', onClose)
        } else {
            socket.onopen = onOpen
            socket.onerror = onError
            socket.onclose = onClose
        }
    })
}

function authHeaders(session: AuthSession): Record<string, string> {
    return {
        ...jsonHeaders(),
        Authorization: `Bearer ${session.accessToken}`,
        'x-client-id': session.clientId,
    }
}

function jsonHeaders(): Record<string, string> {
    return {
        'Content-Type': 'application/json',
    }
}

function toWsUrl(apiBaseUrl: string, sessionId: string, ticket: string): string {
    const url = new URL(urlJoin(apiBaseUrl, `/api/ws/${encodeURIComponent(sessionId)}`))
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('ticket', ticket)
    return url.toString()
}

function toRedactedWsUrl(apiBaseUrl: string, sessionId: string): string {
    const url = new URL(urlJoin(apiBaseUrl, `/api/ws/${encodeURIComponent(sessionId)}`))
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('ticket', '<redacted:wsTicket>')
    return url.toString()
}

function urlJoin(base: string, path: string): string {
    const url = new URL(base)
    const basePath = url.pathname.replace(/\/+$/, '')
    url.pathname = `${basePath}${path.startsWith('/') ? path : '/' + path}`
    return url.toString()
}

function normalizeBaseUrl(value: unknown): string | undefined {
    const text = stringValue(value)
    if (!text) {
        return undefined
    }

    try {
        const url = new URL(text)
        url.pathname = url.pathname.replace(/\/+$/, '')
        url.search = ''
        url.hash = ''
        return url.toString().replace(/\/$/, '')
    } catch (_error) {
        return undefined
    }
}

function summarizeChecks(checks: readonly BlackBoxRunnerLivePreflightCheck[]): BlackBoxRunnerLivePreflightReport['summary'] {
    return checks.reduce((summary, check) => {
        summary.total += 1
        if (check.status === 'passed') {
            summary.passed += 1
        } else if (check.status === 'failed') {
            summary.failed += 1
        } else {
            summary.skipped += 1
        }
        return summary
    }, {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
    })
}

function uniqueCheckKinds(values: readonly BlackBoxRunnerLivePreflightCheckKind[]): readonly BlackBoxRunnerLivePreflightCheckKind[] {
    return values.filter((value, index) => values.indexOf(value) === index)
}

function uniqueValues(values: readonly string[]): readonly string[] {
    return [...new Set(values.filter(value => value.length > 0))].sort()
}

function stringList(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : typeof value === 'string' && value.length > 0
            ? [value]
            : []
}

function envValue(environment: Record<string, string | undefined>, name: string | undefined): string | undefined {
    if (!name) {
        return undefined
    }
    const value = environment[name]
    return value && value.length > 0 ? value : undefined
}

function hasEnv(environment: Record<string, string | undefined>, name: string): boolean {
    return envValue(environment, name) !== undefined
}

function asRecord(value: unknown): JsonRecord {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : {}
}

function isRecord(value: unknown): value is JsonRecord {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function toCheckId(kind: BlackBoxRunnerLivePreflightCheckKind): string {
    return kind
}

function toCheckLabel(kind: BlackBoxRunnerLivePreflightCheckKind): string {
    switch (kind) {
        case 'rallar-api-config':
            return 'Rallar API /api/config'
        case 'cors-origin':
            return 'Configured CORS origin'
        case 'auth-login':
            return 'Configured user credentials'
        case 'group-permission':
            return 'Group create/join permission'
        case 'ws-ticket':
            return 'WebSocket ticket'
        case 'ws-upgrade':
            return 'WebSocket upgrade'
        case 'ice-config':
            return 'ICE config availability'
        case 'control-server':
            return 'Rallar black-box control server'
        case 'playwright':
            return 'Playwright CLI'
        case 'rallar-api-base-url':
            return 'Rallar API base URL'
        case 'env':
            return 'Environment variable'
    }
}
