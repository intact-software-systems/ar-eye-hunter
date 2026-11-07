import { writeFile } from 'node:fs/promises';

import type { WsOutboxProvenance } from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { parseAuthoritativeClientSnapshot } from '@shared/api/authoritative-state-validation.ts';
import { decodeFriendsView, type FriendsView } from '@shared/api/friends/friends-view.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { decodeViewInvalidationMessage } from '@shared/api/views/view-invalidation.ts';
import assert from 'node:assert/strict';
import type {
    ManagedApiServerLifecycleControls,
    ManagedApiServerPlan
} from '../../managed-api/with-managed-api-server-plans.mts';
import { ApiV1RtcTopologyProofApi, type ProofSession } from '../../topology-replay/api-v1-rtc-topology-proof-api.mts';
import { waitForProofCondition } from '../cluster-proof-socket.mts';
import { ViewPushProofPostgres } from './view-push-proof-postgres.mts';
import { ViewPushProofSocket } from './view-push-proof-socket.mts';

export namespace ViewPushClusterScenario {
    export interface Input {
        readonly plans: readonly ManagedApiServerPlan[];
        readonly controls: ManagedApiServerLifecycleControls;
        readonly databaseUrl: string;
        readonly artifactDir: string;
    }
}

export class ViewPushClusterScenario {
    readonly #input: ViewPushClusterScenario.Input;
    readonly #api = new ApiV1RtcTopologyProofApi({
        alice: { username: 'alice', password: 'secret' },
        bob: { username: 'bob', password: 'secret' },
        admin: { username: 'admin', password: 'admin' }
    });
    #phase = 'setup';
    readonly #database: ViewPushProofPostgres;
    readonly #sockets: ViewPushProofSocket[] = [];
    readonly #scope: GroupRef = {
        applicationId: 'view-push-proof',
        workspaceId: crypto.randomUUID(),
        groupId: 'same-group'
    };

    constructor(input: ViewPushClusterScenario.Input) {
        this.#input = input;
        this.#database = new ViewPushProofPostgres(input.databaseUrl);
    }

    async run(): Promise<void> {
        try {
            await this.#writeEvidence(await this.#runScenario());
        }
        catch (error) {
            await writeFile(
                `${this.#input.artifactDir}/view-push-cluster-failure.json`,
                JSON.stringify(
                    {
                        phase: this.#phase,
                        sockets: this.#sockets.map((socket) => ({
                            frameCount: socket.frames.length,
                            closeCodes: socket.closeCodes,
                            readyState: socket.socket.readyState
                        }))
                    },
                    null,
                    2
                ),
                'utf8'
            );
            throw error;
        }
        finally {
            for (const socket of this.#sockets) {
                socket.close();
            }
            await this.#database.close();
        }
    }

    async #runScenario(): Promise<ClusterEvidence> {
        const [primary, secondary, tertiary] = this.#input.plans;
        const recipient = await this.#login('alice', secondary!);
        const recovering = await this.#login('alice', tertiary!);
        const outsider = await this.#login('bob', tertiary!);
        await this.#createSharedGroup(recipient, outsider);
        const target = await this.#open(recipient);
        const disconnected = await this.#open(recovering);
        const unrelated = await this.#open(outsider);
        await this.#connectRoom(recipient, target);
        await this.#connectRoom(recovering, disconnected);
        await this.#connectRoom(outsider, unrelated);
        const initial = await this.#readView(recipient);
        this.#phase = 'cross-process-delivery';
        const live = await this.#changeVisibility(recipient, !initial.shareOnline);
        const frame = await target.waitForFrame((message) => message.id.traceId === live.requestId);
        await disconnected.waitForFrame((message) => message.id.traceId === live.requestId);
        const proof = await this.#database.waitForPublication(live.requestId);
        assert.deepEqual(frame.id.msgId, proof.messageId);
        assert.deepEqual(decodeViewInvalidationMessage(frame), {
            version: 1,
            resource: 'friends',
            scope: null,
            principalId: recipient.clientId,
            changeId: decodeViewInvalidationMessage(frame).changeId
        });
        await this.#assertVisibility(recipient, !initial.shareOnline);
        await assertNoPrivateViews(unrelated);
        this.#phase = 'process-restart-recovery';
        await this.#recoverProcess({ session: recovering, socket: disconnected, shareOnline: initial.shareOnline });
        const recoveredOutsider = await this.#open(outsider);
        await this.#connectRoom(outsider, recoveredOutsider);
        this.#phase = 'subscriber-loss-recovery';
        const listener = await this.#recoverListener({
            session: recipient,
            socket: target,
            shareOnline: !initial.shareOnline
        });
        await assertNoPrivateViews(recoveredOutsider);
        return {
            producer: primary!.port,
            recipient: secondary!.port,
            recovering: tertiary!.port,
            live: { requestId: live.requestId, messageId: proof.messageId, target: proof.target },
            listener,
            outsiderFrames: unrelated.frames.length + recoveredOutsider.frames.length
        };
    }

    async #writeEvidence(evidence: ClusterEvidence): Promise<void> {
        await writeFile(
            `${this.#input.artifactDir}/view-push-cluster-proof.json`,
            JSON.stringify(
                {
                    status: 'passed',
                    ...evidence,
                    noRescuingMutation: true,
                    queueWorkers: this.#input.plans.map((plan) => plan.env.RALLAR_API_QUEUE_WORKERS)
                },
                null,
                2
            ),
            'utf8'
        );
    }

    async #login(principal: 'alice' | 'bob', receiver: ManagedApiServerPlan): Promise<ProofSession> {
        return await this.#api.login({
            label: `${principal}-${receiver.port}`,
            principal,
            apiBaseUrl: this.#input.plans[0]!.baseUrl,
            wsBaseUrl: receiver.baseUrl.replace(/^http/, 'ws')
        });
    }

    async #createSharedGroup(owner: ProofSession, outsider: ProofSession): Promise<void> {
        const group = { ...this.#scope, proofId: this.#scope.workspaceId };
        await this.#api.createGroup({ ...group, owner });
        await this.#api.activateMember({ ...group, actor: outsider, memberClientId: outsider.clientId });
    }

    async #open(session: ProofSession): Promise<ViewPushProofSocket> {
        const socket = await ViewPushProofSocket.open({
            api: this.#api,
            session,
            scope: {
                applicationId: this.#scope.applicationId,
                workspaceId: this.#scope.workspaceId
            }
        });
        this.#sockets.push(socket);
        return socket;
    }

    async #connectRoom(session: ProofSession, socket: ViewPushProofSocket): Promise<void> {
        const scopePath = `/api/state/apps/${this.#scope.applicationId}/workspaces/${this.#scope.workspaceId}`;
        const response = await fetch(`${session.apiBaseUrl}${scopePath}/clients/${session.clientId}`, {
            headers: authHeaders(session)
        });
        assert.deepEqual(response.status, 200);
        const snapshot = parseAuthoritativeClientSnapshot(await response.text(), this.#scope);
        const connected = snapshot.activeSessions.find((candidate) => candidate.sessionId === session.sessionId);
        assert.ok(connected, 'Current websocket has canonical client presence');
        const requestId = `view-push-presence-${crypto.randomUUID()}`;
        const presence = await fetch(
            `${session.apiBaseUrl}${scopePath}/groups/${this.#scope.groupId}/sessions/${session.sessionId}/requests/${requestId}`,
            {
                method: 'PUT',
                headers: { ...authHeaders(session), 'Content-Type': 'application/json', 'x-request-id': requestId },
                body: JSON.stringify({
                    generationId: crypto.randomUUID(),
                    connectionGenerationId: connected.generationId,
                    publicationKey: null,
                    principalId: session.clientId
                })
            }
        );
        assert.deepEqual(presence.status, 200, 'Live room presence joins the authenticated socket generation');
        await presence.body?.cancel();
        await socket.waitForFrame((frame) =>
            frame.route.topicId === AppTopics.groupStateEvent && frame.id.traceId === requestId
        );
    }

    async #recoverProcess(input: RecoveryInput): Promise<void> {
        const node = this.#input.plans[2]!;
        input.socket.assertOpen();
        await this.#assertVisibility({ ...input.session, apiBaseUrl: node.baseUrl }, !input.shareOnline);
        await this.#input.controls.stop(node.port);
        await waitForProofCondition(() => input.socket.closeCodes.length === 1, 'C socket closes during process stop');
        const change = await this.#changeVisibility(input.session, input.shareOnline);
        await this.#database.waitForPublication(change.requestId);
        await this.#input.controls.restart(node.port, { ...node, logPath: `${node.logPath}.restarted` });
        const socket = await this.#open(input.session);
        socket.assertOpen();
        await this.#assertVisibility({ ...input.session, apiBaseUrl: node.baseUrl }, input.shareOnline);
    }

    async #recoverListener(input: RecoveryInput): Promise<ListenerEvidence> {
        const node = this.#input.plans[1]!;
        await this.#assertVisibility({ ...input.session, apiBaseUrl: node.baseUrl }, !input.shareOnline);
        const applicationName = new URL(node.env.DATABASE_URL!).searchParams.get('application_name')!;
        const previousPid = await this.#database.readListener(applicationName);
        const frameBaseline = input.socket.frames.length;
        await this.#input.controls.suspend(node.port);
        let requestId: string;
        try {
            await this.#database.terminateListener(previousPid);
            ({ requestId } = await this.#changeVisibility(input.session, input.shareOnline));
            await this.#database.waitForPublication(requestId);
        }
        finally {
            await this.#input.controls.resume(node.port);
        }
        await input.socket.waitForFrame((frame) => frame.route.topicId === AppTopics.viewResync, frameBaseline);
        input.socket.assertOpen();
        const replacementPid = await this.#database.readListener(applicationName);
        assert.deepEqual(
            replacementPid === previousPid,
            false,
            'Subscriber must reconnect after actual notification loss'
        );
        await this.#assertVisibility({ ...input.session, apiBaseUrl: node.baseUrl }, input.shareOnline);
        return {
            previousPid,
            replacementPid,
            requestId,
            frameBaseline,
            socketCloseCount: input.socket.closeCodes.length
        };
    }

    async #changeVisibility(session: ProofSession, shareOnline: boolean): Promise<{ readonly requestId: string; }> {
        const requestId = `view-push-${crypto.randomUUID()}`;
        const response = await fetch(`${session.apiBaseUrl}/api/friends/requests/${requestId}`, {
            method: 'POST',
            headers: { ...authHeaders(session), 'Content-Type': 'application/json', 'x-request-id': requestId },
            body: JSON.stringify({ action: 'visibility', shareOnline })
        });
        assert.deepEqual(response.status, 200, 'Visibility mutation applies through AppInbox');
        await response.body?.cancel();
        return { requestId };
    }

    async #readView(session: ProofSession): Promise<FriendsView> {
        const response = await fetch(
            `${session.apiBaseUrl}/api/friends/apps/${this.#scope.applicationId}/workspaces/${this.#scope.workspaceId}`,
            {
                headers: authHeaders(session)
            }
        );
        assert.deepEqual(response.status, 200);
        return decodeFriendsView(await response.json());
    }

    async #assertVisibility(session: ProofSession, expected: boolean): Promise<void> {
        assert.deepEqual(
            (await this.#readView(session)).shareOnline,
            expected,
            'Canonical GET recovers committed visibility'
        );
    }
}

interface RecoveryInput {
    readonly session: ProofSession;
    readonly socket: ViewPushProofSocket;
    readonly shareOnline: boolean;
}

interface ListenerEvidence {
    readonly previousPid: number;
    readonly replacementPid: number;
    readonly requestId: string;
    readonly frameBaseline: number;
    readonly socketCloseCount: number;
}

function authHeaders(session: ProofSession): Record<string, string> {
    return { Authorization: `Bearer ${session.accessToken}`, 'x-client-id': session.clientId };
}

interface ClusterEvidence {
    readonly producer: number;
    readonly recipient: number;
    readonly recovering: number;
    readonly live: {
        readonly requestId: string;
        readonly messageId: string;
        readonly target: WsOutboxProvenance['target'];
    };
    readonly listener: ListenerEvidence;
    readonly outsiderFrames: number;
}

async function assertNoPrivateViews(socket: ViewPushProofSocket): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500));
    socket.assertOpen();
    assert.deepEqual(socket.frames.filter((message) => message.route.topicId === AppTopics.viewInvalidated), []);
}
