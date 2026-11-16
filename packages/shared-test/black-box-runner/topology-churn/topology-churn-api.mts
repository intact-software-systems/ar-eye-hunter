import { toStateGroupHttpPath, toStateScopeHttpPath } from '@shared-web/browser/api/state-http-path.ts';
import { decodeApiConfigResponse } from '@shared-web/browser/connection/decode-api-config-response.ts';
import {
    ADMIN_ROOM_TOPOLOGY_PLANS_MAX_LIMIT,
    type AdminRoomTopologyPlan,
    type AdminRoomTopologyPlansResponse
} from '@shared/api/admin-rooms/admin-room-topology-plans.ts';
import { decodeAdminRoomTopologyPlans } from '@shared/api/admin-rooms/decode-admin-room-topology-plans.ts';
import type { ApiConfigResponse } from '@shared/api/api-config.ts';
import {
    validateAuthoritativeGroupSnapshot,
    validateAuthoritativeOverlayTopologySnapshot
} from '@shared/api/authoritative-state-validation.ts';
import type { GroupTopologyPolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { Either } from '@shared/resilience/Either.ts';

import {
    requestJson,
    type ProofJsonObject,
    type RequestOptions
} from '../topology-replay/api-v1-rtc-topology-proof-api.mts';

export namespace TopologyChurnApi {
    export interface Config {
        readonly memberPassword: string;
        readonly administrator: Credentials;
        /** Each request is aborted after this long, so a hung request fails the run instead of hanging it. */
        readonly requestTimeoutMs: number;
    }

    export interface Credentials {
        readonly username: string;
        readonly password: string;
    }
}

export interface TopologyChurnMember {
    readonly username: string;
    readonly clientIp: string;
    readonly apiBaseUrl: string;
}

export interface TopologyChurnSession {
    readonly member: TopologyChurnMember;
    readonly clientId: string;
    readonly sessionId: string;
    readonly accessToken: string;
}

export interface CreateTopologyChurnRoomInput {
    readonly creator: TopologyChurnSession;
    readonly roomRef: GroupRef;
    readonly topology: Partial<GroupTopologyPolicy>;
}

export interface TopologyChurnPresenceInput {
    readonly session: TopologyChurnSession;
    readonly roomRef: GroupRef;
    readonly leaseExpiresAtEpochMs: number;
}

interface TopologyChurnMutation {
    readonly method: 'POST' | 'PUT';
    readonly path: string;
    readonly body: object;
}

export class TopologyChurnApi {
    readonly #config: TopologyChurnApi.Config;

    constructor(config: TopologyChurnApi.Config) {
        this.#config = config;
    }

    async readApiConfig(apiBaseUrl: string): Promise<ApiConfigResponse> {
        const body = await this.#request(apiBaseUrl, '/api/config', { method: 'GET' });
        return requireRight(decodeApiConfigResponse(body, new URL(apiBaseUrl)));
    }

    async registerMember(member: TopologyChurnMember): Promise<void> {
        await this.#request(member.apiBaseUrl, toApiMutationRequestPath('/api/auth/register', crypto.randomUUID()), {
            method: 'POST',
            headers: { 'x-forwarded-for': member.clientIp },
            body: { username: member.username, password: this.#config.memberPassword, displayName: member.username },
            expectedStatus: 201
        });
    }

    async loginMember(member: TopologyChurnMember): Promise<TopologyChurnSession> {
        return await this.#login(member, this.#config.memberPassword);
    }

    async loginAdministrator(apiBaseUrl: string, clientIp: string): Promise<TopologyChurnSession> {
        const { username, password } = this.#config.administrator;
        return await this.#login({ username, clientIp, apiBaseUrl }, password);
    }

    async createRoom(input: CreateTopologyChurnRoomInput): Promise<void> {
        const path = `${toStateScopeHttpPath(input.roomRef)}/groups`;
        await this.#request(input.creator.member.apiBaseUrl, toApiMutationRequestPath(path, crypto.randomUUID()), {
            method: 'POST',
            headers: toSessionHeaders(input.creator),
            body: {
                groupId: input.roomRef.groupId,
                displayName: `Topology churn ${input.roomRef.groupId}`,
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: input.creator.clientId,
                lifecyclePolicy: { topology: input.topology }
            },
            expectedStatus: 201
        });
    }

    async joinRoom(session: TopologyChurnSession, roomRef: GroupRef): Promise<void> {
        await this.#mutate(session, { method: 'POST', path: `${toGroupPath(roomRef)}/join`, body: {} });
    }

    async connectPresence(input: TopologyChurnPresenceInput): Promise<void> {
        await this.#mutate(input.session, {
            method: 'PUT',
            path: toPresencePath(input),
            body: {
                generationId: toPresenceGenerationId(input.session),
                connectionGenerationId: `connection-${input.session.sessionId}`,
                publicationKey: null,
                principalId: input.session.clientId,
                expiresAtEpochMs: input.leaseExpiresAtEpochMs
            }
        });
    }

    async sendHeartbeat(input: TopologyChurnPresenceInput): Promise<void> {
        await this.#mutate(input.session, {
            method: 'POST',
            path: `${toPresencePath(input)}/heartbeat`,
            body: {
                generationId: toPresenceGenerationId(input.session),
                publicationKey: null,
                principalId: input.session.clientId,
                expiresAtEpochMs: input.leaseExpiresAtEpochMs
            }
        });
    }

    async disconnectPresence(session: TopologyChurnSession, roomRef: GroupRef): Promise<void> {
        await this.#mutate(session, {
            method: 'POST',
            path: `${toPresencePath({ session, roomRef })}/disconnect`,
            body: { generationId: toPresenceGenerationId(session), principalId: session.clientId }
        });
    }

    async readRoom(session: TopologyChurnSession, roomRef: GroupRef): Promise<GroupSnapshot> {
        const body = await this.#request(session.member.apiBaseUrl, toGroupPath(roomRef), {
            method: 'GET',
            headers: toSessionHeaders(session)
        });
        validateAuthoritativeGroupSnapshot(body, roomRef);
        return body;
    }

    async readAcceptedLayout(session: TopologyChurnSession, roomRef: GroupRef): Promise<RallarOverlayTopologySnapshot> {
        const body = await this.#request(session.member.apiBaseUrl, `${toGroupPath(roomRef)}/topology`, {
            method: 'GET',
            headers: toSessionHeaders(session)
        });
        const acceptedSnapshot = body.acceptedSnapshot;
        if (acceptedSnapshot === null || acceptedSnapshot === undefined) {
            throw new TypeError(`The room ${roomRef.groupId} has accepted no layout.`);
        }
        validateAuthoritativeOverlayTopologySnapshot(acceptedSnapshot, roomRef);
        return acceptedSnapshot;
    }

    async readRoomTopologyPlans(
        administrator: TopologyChurnSession,
        roomRef: GroupRef
    ): Promise<readonly AdminRoomTopologyPlan[]> {
        const plans: AdminRoomTopologyPlan[] = [];
        let afterPublicationId: string | null = null;
        do {
            const page: AdminRoomTopologyPlansResponse = requireRight(decodeAdminRoomTopologyPlans(
                await this.#request(administrator.member.apiBaseUrl, toTopologyPlansPath(roomRef, afterPublicationId), {
                    method: 'GET',
                    headers: toSessionHeaders(administrator)
                })
            ));
            plans.push(...page.plans);
            afterPublicationId = page.nextAfterPublicationId;
        }
        while (afterPublicationId !== null);
        return plans;
    }

    async #login(member: TopologyChurnMember, password: string): Promise<TopologyChurnSession> {
        const body = await this.#request(
            member.apiBaseUrl,
            toApiMutationRequestPath('/api/auth/login', crypto.randomUUID()),
            {
                method: 'POST',
                headers: { 'x-forwarded-for': member.clientIp },
                body: { username: member.username, password }
            }
        );
        const { clientId, sessionId, accessToken } = body;
        if (typeof clientId !== 'string' || typeof sessionId !== 'string' || typeof accessToken !== 'string') {
            throw new TypeError(`Login of ${member.username} answered no client, session or access token.`);
        }
        return { member, clientId, sessionId, accessToken };
    }

    async #mutate(session: TopologyChurnSession, mutation: TopologyChurnMutation): Promise<void> {
        await this.#request(session.member.apiBaseUrl, toApiMutationRequestPath(mutation.path, crypto.randomUUID()), {
            method: mutation.method,
            headers: toSessionHeaders(session),
            body: mutation.body
        });
    }

    async #request(baseUrl: string, path: string, options: RequestOptions): Promise<ProofJsonObject> {
        try {
            return await requestJson(baseUrl, path, {
                ...options,
                signal: AbortSignal.timeout(this.#config.requestTimeoutMs)
            });
        }
        catch (error) {
            if (error instanceof DOMException && error.name === 'TimeoutError') {
                throw new Error(`${options.method} ${path} timed out after ${this.#config.requestTimeoutMs} ms.`);
            }
            throw error;
        }
    }
}

function toSessionHeaders(session: TopologyChurnSession): Readonly<Record<string, string>> {
    return {
        Authorization: `Bearer ${session.accessToken}`,
        'x-client-id': session.clientId,
        'x-forwarded-for': session.member.clientIp
    };
}

/** The connect, heartbeat and disconnect of one session must name the same presence generation. */
function toPresenceGenerationId(session: TopologyChurnSession): string {
    return `generation-${session.sessionId}`;
}

function toGroupPath(roomRef: GroupRef): string {
    return toStateGroupHttpPath(roomRef, roomRef.groupId);
}

function toPresencePath(input: Pick<TopologyChurnPresenceInput, 'session' | 'roomRef'>): string {
    return `${toGroupPath(input.roomRef)}/sessions/${encodeURIComponent(input.session.sessionId)}`;
}

function toTopologyPlansPath(roomRef: GroupRef, afterPublicationId: string | null): string {
    const query = new URLSearchParams({ limit: String(ADMIN_ROOM_TOPOLOGY_PLANS_MAX_LIMIT) });
    if (afterPublicationId !== null) {
        query.set('afterPublicationId', afterPublicationId);
    }
    return `/api/admin/operations/rooms/apps/${encodeURIComponent(roomRef.applicationId)}` +
        `/workspaces/${encodeURIComponent(roomRef.workspaceId)}/groups/${encodeURIComponent(roomRef.groupId)}` +
        `/topology-plans?${query.toString()}`;
}

function requireRight<T>(decoded: Either<string, T>): T {
    return decoded.fold((message) => {
        throw new TypeError(message);
    }, (value) => value);
}
