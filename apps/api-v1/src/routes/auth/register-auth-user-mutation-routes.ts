import { Hono, type Context } from 'jsr:@hono/hono@4.11.9';

import { readRateLimiter, readRequestClientKey } from '@shared-server/http/rate-limit-service.ts';
import type { LoginRequest, RegisterRequest, RegisterResponse } from '@shared/api/api-config.ts';
import type { ApiMutationFailureJsonObject } from '@shared/api/mutation/api-mutation-failure.ts';
import { RateLimiter, RateLimiterPolicy } from '@shared/resilience/Resilience.ts';

import * as apiLoginService from '../../services/api-login-service.ts';
import { authenticationRequired, authorizationDenied } from '../../services/request-auth-service.ts';
import { toApiMutationFailureResponse, toApiMutationRateLimitResponse } from '../api-mutation-route-failure.ts';
import type { ConfigRouteDependencies } from '../config-route.ts';
import { readAuthMutationRequest, requireAuthMutationResult, toJsonResponse } from './auth-mutation-route-support.ts';

interface AuthUserRouteRateLimitPolicies {
    readonly loginIp: RateLimiterPolicy;
    readonly loginUsername: RateLimiterPolicy;
    readonly registrationIp: RateLimiterPolicy;
    readonly registrationUsername: RateLimiterPolicy;
}

interface AuthUserRouteRuntime {
    readonly dependencies: ConfigRouteDependencies;
    readonly rateLimits: AuthUserRouteRateLimitPolicies;
}

interface RegisterUserThroughAppInboxInput {
    readonly context: Context;
    readonly requestId: string;
    readonly request: RegisterRequest;
    readonly dependencies: ConfigRouteDependencies;
}

export function registerAuthUserMutationRoutes(
    app: Hono,
    dependencies: ConfigRouteDependencies
): void {
    const runtime = {
        dependencies,
        rateLimits: toAuthUserRouteRateLimitPolicies(dependencies.authentication.rateLimits)
    };
    app.post(
        '/api/auth/login/requests/:requestId',
        (context) => issueLoginResponse(context, runtime)
    );
    app.post(
        '/api/auth/register/requests/:requestId',
        (context) => registerUserResponse(context, runtime)
    );
}

async function issueLoginResponse(
    context: Context,
    runtime: AuthUserRouteRuntime
): Promise<Response> {
    try {
        const clientKey = readRequestClientKey(context.req);
        return await RateLimiter.tryToExecuteOrDefault<Response>(
            readRateLimiter('auth-login-ip', clientKey, runtime.rateLimits.loginIp),
            async () => {
                const { requestId, body } = await readAuthMutationRequest(context);
                const loginRequest = readLoginRequest(body);
                return await RateLimiter.tryToExecuteOrDefault<Response>(
                    readRateLimiter(
                        'auth-login-user',
                        `${clientKey}:${loginRequest.username ?? ''}`,
                        runtime.rateLimits.loginUsername
                    ),
                    () => issueLoginSession(requestId, loginRequest, runtime.dependencies),
                    toApiMutationRateLimitResponse(
                        context,
                        'Too many login attempts for this user',
                        runtime.dependencies.authentication.rateLimits.windowMs
                    )
                );
            },
            toApiMutationRateLimitResponse(
                context,
                'Too many login attempts',
                runtime.dependencies.authentication.rateLimits.windowMs
            )
        );
    }
    catch (error) {
        return toApiMutationFailureResponse(
            context,
            error instanceof Error ? error : new Error(String(error))
        );
    }
}

async function issueLoginSession(
    requestId: string,
    request: LoginRequest,
    dependencies: ConfigRouteDependencies
): Promise<Response> {
    const loginResponse = await apiLoginService.login({
        request,
        userRepository: dependencies.authUserRepository,
        staticClients: dependencies.authentication.staticClients
    });
    if (!loginResponse) {
        return toApiMutationFailureResponse(
            { json: (value, status) => toJsonResponse(value, status) },
            authenticationRequired('Unauthorized: Invalid username or password')
        );
    }

    return toJsonResponse(requireAuthMutationResult(
        await dependencies.appAuthInbox.issueSession({
            requestId,
            clientId: loginResponse.clientId,
            username: loginResponse.username,
            authority: loginResponse.authority,
            ttlMs: dependencies.authentication.sessionTtlMs
        })
    ));
}

async function registerUserResponse(
    context: Context,
    runtime: AuthUserRouteRuntime
): Promise<Response> {
    try {
        const clientKey = readRequestClientKey(context.req);
        return await RateLimiter.tryToExecuteOrDefault<Response>(
            readRateLimiter('auth-register-ip', clientKey, runtime.rateLimits.registrationIp),
            async () => {
                const { requestId, body } = await readAuthMutationRequest(context);
                const request = readRegisterRequest(body);
                return await RateLimiter.tryToExecuteOrDefault<Response>(
                    readRateLimiter(
                        'auth-register-user',
                        `${clientKey}:${request.username ?? ''}`,
                        runtime.rateLimits.registrationUsername
                    ),
                    () =>
                        registerUserThroughAppInbox({
                            context,
                            requestId,
                            request,
                            dependencies: runtime.dependencies
                        }),
                    toApiMutationRateLimitResponse(
                        context,
                        'Too many registration attempts for this user',
                        runtime.dependencies.authentication.rateLimits.windowMs
                    )
                );
            },
            toApiMutationRateLimitResponse(
                context,
                'Too many registration attempts',
                runtime.dependencies.authentication.rateLimits.windowMs
            )
        );
    }
    catch (error) {
        return toApiMutationFailureResponse(
            context,
            error instanceof Error ? error : new Error(String(error))
        );
    }
}

async function registerUserThroughAppInbox(
    input: RegisterUserThroughAppInboxInput
): Promise<Response> {
    await requireRegistrationAdminIfNeeded(input.context.req, input.dependencies);
    return toJsonResponse<RegisterResponse>(
        requireAuthMutationResult(
            await input.dependencies.appAuthInbox.registerUser({
                requestId: input.requestId,
                request: input.request,
                staticClients: input.dependencies.authentication.staticClients
            })
        ),
        201
    );
}

async function requireRegistrationAdminIfNeeded(
    req: { header(name: string): string | undefined; },
    dependencies: ConfigRouteDependencies
): Promise<void> {
    if (dependencies.authentication.registrationMode !== 'admin') {
        return;
    }
    const authSession = await dependencies.requireApiAuthSession(req);
    if (!dependencies.authentication.adminClientIds.includes(authSession.clientId)) {
        throw authorizationDenied('Forbidden: admin auth session required to register users');
    }
}

function readLoginRequest(body: ApiMutationFailureJsonObject): LoginRequest {
    return {
        username: readAuthRequestString(body, 'username'),
        password: readAuthRequestString(body, 'password')
    };
}

function readRegisterRequest(body: ApiMutationFailureJsonObject): RegisterRequest {
    const displayName = body.displayName;
    if (displayName !== undefined && typeof displayName !== 'string') {
        throw new TypeError('displayName must be a string');
    }
    return {
        username: readAuthRequestString(body, 'username'),
        password: readAuthRequestString(body, 'password'),
        ...(displayName === undefined ? {} : { displayName })
    };
}

function readAuthRequestString(
    body: ApiMutationFailureJsonObject,
    property: 'username' | 'password'
): string {
    const value = body[property];
    if (value === undefined) {
        return '';
    }
    if (typeof value !== 'string') {
        throw new TypeError(`${property} must be a string`);
    }
    return value;
}

function toAuthUserRouteRateLimitPolicies(
    configuration: ConfigRouteDependencies['authentication']['rateLimits']
): AuthUserRouteRateLimitPolicies {
    return {
        loginIp: new RateLimiterPolicy(configuration.windowMs, configuration.loginIp),
        loginUsername: new RateLimiterPolicy(
            configuration.windowMs,
            configuration.loginUsername
        ),
        registrationIp: new RateLimiterPolicy(
            configuration.windowMs,
            configuration.registrationIp
        ),
        registrationUsername: new RateLimiterPolicy(
            configuration.windowMs,
            configuration.registrationUsername
        )
    };
}
