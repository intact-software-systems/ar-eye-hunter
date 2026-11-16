import { decodeApiConfigResponse } from '@shared-web/browser/connection/decode-api-config-response.ts';
import {
    ADMIN_ROOM_TOPOLOGY_PLANS_MAX_LIMIT,
    type AdminRoomTopologyPlan,
    type AdminRoomTopologyPlansResponse
} from '@shared/api/admin-rooms/admin-room-topology-plans.ts';
import { decodeAdminRoomTopologyPlans } from '@shared/api/admin-rooms/decode-admin-room-topology-plans.ts';
import type { ApiConfigResponse } from '@shared/api/api-config.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { GroupTopologyPolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import type { Either } from '@shared/resilience/Either.ts';

import { requestJson } from '../topology-replay/api-v1-rtc-topology-proof-api.mts';

export namespace TopologyChurnApi {
    export interface Config {
        readonly memberPassword: string;
        readonly administrator: Credentials;
    }

    export interface Credentials {
        readonly username: string;
        readonly password: string;
    }
}

/** A principal as one client: its own address, so per-IP login limits never couple two members. */
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

/** The HTTP calls of the churn scenario; every unexpected status or undecodable body throws. */
export class TopologyChurnApi {
    readonly #config: TopologyChurnApi.Config;

    constructor(config: TopologyChurnApi.Config) {
        this.#config = config;
    }

    async readApiConfig(apiBaseUrl: string): Promise<ApiConfigResponse> {
        const body = await requestJson(apiBaseUrl, '/api/config', { method: 'GET' });
        return requireRight(decodeApiConfigResponse(body, new URL(apiBaseUrl)));
    }

    async registerMember(member: TopologyChurnMember): Promise<void> {
        await requestJson(member.apiBaseUrl, toApiMutationRequestPath('/api/auth/register', crypto.randomUUID()), {
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
        const path = toGroupCollectionPath(input.roomRef);
        await requestJson(input.creator.member.apiBaseUrl, toApiMutationRequestPath(path, crypto.randomUUID()), {
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
        const body = await requestJson(session.member.apiBaseUrl, toGroupPath(roomRef), {
            method: 'GET',
            headers: toSessionHeaders(session)
        });
        validateAuthoritativeGroupSnapshot(body, roomRef);
        return body;
    }

    /** Every live publication of the room exactly once, in storage-key order. */
    async readRoomTopologyPlans(
        administrator: TopologyChurnSession,
        roomRef: GroupRef
    ): Promise<readonly AdminRoomTopologyPlan[]> {
        const plans: AdminRoomTopologyPlan[] = [];
        let afterPublicationId: string | null = null;
        do {
            const page: AdminRoomTopologyPlansResponse = requireRight(decodeAdminRoomTopologyPlans(
                await requestJson(administrator.member.apiBaseUrl, toTopologyPlansPath(roomRef, afterPublicationId), {
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
        const body = await requestJson(
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
        await requestJson(session.member.apiBaseUrl, toApiMutationRequestPath(mutation.path, crypto.randomUUID()), {
            method: mutation.method,
            headers: toSessionHeaders(session),
            body: mutation.body
        });
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

function toGroupCollectionPath(roomRef: GroupRef): string {
    return `/api/state/apps/${encodeURIComponent(roomRef.applicationId)}` +
        `/workspaces/${encodeURIComponent(roomRef.workspaceId)}/groups`;
}

function toGroupPath(roomRef: GroupRef): string {
    return `${toGroupCollectionPath(roomRef)}/${encodeURIComponent(roomRef.groupId)}`;
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
