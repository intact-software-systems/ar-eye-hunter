import type {
    AdminSupportExplainClientRequest,
    AdminSupportFact,
    AdminSupportNarrativeResponse,
    AdminSupportSuggestedAction,
    AdminSupportTimelineItem,
    AdminSupportWarning
} from '@shared/api/admin-support-types.ts';
import type {
    ClientEvent,
    ClientPresenceSnapshot,
    ClientPrincipalRef,
    ClientSession,
    ClientSnapshot
} from '@shared/api/client-types.ts';
import type { AdminSupportWsStatus } from '../admin-support-contracts.ts';
import { adminSupportNarrativeBase, type AdminSupportNarrativeBase } from './admin-support-narrative-base.ts';

interface ProjectClientAdminSupportInput extends AdminSupportNarrativeBase {
    readonly request: AdminSupportExplainClientRequest;
    readonly hasClientStateService: boolean;
    readonly snapshot: ClientSnapshot | undefined;
    readonly presence: ClientPresenceSnapshot | undefined;
    readonly recentEvents: readonly ClientEvent[];
    readonly wsStatus: AdminSupportWsStatus | undefined;
}

export function projectClientAdminSupportNarrative(
    input: ProjectClientAdminSupportInput
): AdminSupportNarrativeResponse {
    const ref: ClientPrincipalRef = {
        ...input.request.scope,
        principalId: input.request.principalId
    };
    const session = findClientSession(
        input.snapshot,
        input.request.clientInstanceId,
        input.request.sessionId
    );
    const facts = clientFacts({
        snapshot: input.snapshot,
        presence: input.presence,
        recentEvents: input.recentEvents,
        session,
        sessionId: input.request.sessionId,
        clientInstanceId: input.request.clientInstanceId,
        wsStatus: input.wsStatus
    });
    const warnings = clientWarnings({
        hasClientStateService: input.hasClientStateService,
        snapshot: input.snapshot,
        session,
        sessionId: input.request.sessionId,
        wsStatus: input.wsStatus
    });
    return {
        ...adminSupportNarrativeBase(input, {
            kind: 'client',
            scope: input.request.scope,
            principalId: input.request.principalId,
            clientInstanceId: input.request.clientInstanceId,
            sessionId: input.request.sessionId
        }),
        facts,
        timeline: clientTimeline(input.recentEvents),
        warnings,
        likelyCauses: clientLikelyCauses({
            snapshot: input.snapshot,
            session,
            sessionId: input.request.sessionId,
            wsStatus: input.wsStatus
        }),
        suggestedActions: clientSuggestedActions(
            input.snapshot,
            session,
            input.request.sessionId
        ),
        rawRefs: [`client:${toClientRef(ref)}`]
    };
}

interface ClientFactsInput {
    readonly snapshot: ClientSnapshot | undefined;
    readonly presence: ClientPresenceSnapshot | undefined;
    readonly recentEvents: readonly ClientEvent[];
    readonly session: ClientSession | undefined;
    readonly sessionId: string | undefined;
    readonly clientInstanceId: string | undefined;
    readonly wsStatus: AdminSupportWsStatus | undefined;
}

interface ClientWarningsInput {
    readonly hasClientStateService: boolean;
    readonly snapshot: ClientSnapshot | undefined;
    readonly session: ClientSession | undefined;
    readonly sessionId: string | undefined;
    readonly wsStatus: AdminSupportWsStatus | undefined;
}

function clientFacts(input: ClientFactsInput): readonly AdminSupportFact[] {
    const facts: AdminSupportFact[] = [
        {
            label: 'client.snapshot',
            source: 'client-state',
            value: input.snapshot ? 'found' : 'missing',
            certainty: input.snapshot ? 'exact' : 'unavailable'
        }
    ];

    if (input.snapshot) {
        facts.push(
            {
                label: 'client.principal.status',
                source: 'client-state',
                value: input.snapshot.principal.status,
                certainty: 'exact'
            },
            {
                label: 'client.isOnline',
                source: 'client-state',
                value: input.snapshot.isOnline,
                certainty: 'exact'
            },
            {
                label: 'client.activeSessionCount',
                source: 'client-state',
                value: input.snapshot.activeSessionCount,
                certainty: 'exact'
            }
        );
        if (input.clientInstanceId) {
            const instance = input.snapshot.instances.find(
                (candidate) => candidate.clientInstanceId === input.clientInstanceId
            );
            facts.push({
                label: 'client.instance.status',
                source: 'client-state',
                value: instance?.status ?? 'missing',
                certainty: instance ? 'exact' : 'unavailable'
            });
        }
    }

    if (input.presence) {
        facts.push(
            {
                label: 'client.presence.isOnline',
                source: 'client-state',
                value: input.presence.isOnline,
                certainty: 'exact'
            },
            {
                label: 'client.presence.activeSessionCount',
                source: 'client-state',
                value: input.presence.activeSessions.length,
                certainty: 'exact'
            }
        );
    }

    if (input.sessionId || input.clientInstanceId) {
        facts.push({
            label: 'client.session.status',
            source: 'client-state',
            value: input.session?.status ?? 'missing',
            certainty: input.session ? 'exact' : 'unavailable'
        });
    }

    if (input.wsStatus) {
        facts.push({
            label: 'client.websocket.openConnectionCount',
            source: 'websocket',
            value: input.wsStatus.openConnectionCount,
            certainty: 'exact'
        });
        if (input.sessionId) {
            facts.push({
                label: 'client.session.currentProcessOpen',
                source: 'websocket',
                value: Boolean(
                    input.session?.connectionId &&
                        input.wsStatus.openConnectionIds.includes(input.session.connectionId)
                ),
                certainty: input.session?.connectionId ? 'exact' : 'inferred'
            });
        }
    }

    facts.push({
        label: 'client.recentEventCount',
        source: 'client-state-events',
        value: input.recentEvents.length,
        certainty: 'exact'
    });

    return facts;
}

function clientTimeline(events: readonly ClientEvent[]): readonly AdminSupportTimelineItem[] {
    return events.map((event) => ({
        atEpochMs: event.occurredAtEpochMs,
        source: 'client-state-events',
        eventType: event.eventType,
        summary: `Client event ${event.eventType}.`,
        rawRef: `client-event:${event.eventId}`
    }));
}

function clientWarnings(input: ClientWarningsInput): readonly AdminSupportWarning[] {
    const warnings: AdminSupportWarning[] = [];
    if (!input.hasClientStateService) {
        warnings.push({
            code: 'client-readers-unconfigured',
            message: 'Client state readers are not configured for support explanation.',
            source: 'admin-support'
        });
    }
    if (input.hasClientStateService && !input.snapshot) {
        warnings.push({
            code: 'client-snapshot-missing',
            message: 'No client snapshot was found for the requested principal.',
            source: 'client-state'
        });
    }
    if (input.sessionId && !input.session) {
        warnings.push({
            code: 'client-session-missing',
            message: 'No active client session matched the requested session id.',
            source: 'client-state'
        });
    }
    if (input.wsStatus) {
        warnings.push({
            code: 'process-local-realtime',
            message: 'WebSocket connection status is process-local and may not include other API workers.',
            source: 'websocket'
        });
        if (
            input.session?.connectionId &&
            !input.wsStatus.openConnectionIds.includes(input.session.connectionId)
        ) {
            warnings.push({
                code: 'client-session-not-open-in-process',
                message: 'The matched client session connection is not open in this API process.',
                source: 'websocket'
            });
        }
    }
    return warnings;
}

interface ClientLikelyCausesInput {
    readonly snapshot: ClientSnapshot | undefined;
    readonly session: ClientSession | undefined;
    readonly sessionId: string | undefined;
    readonly wsStatus: AdminSupportWsStatus | undefined;
}

function clientLikelyCauses(input: ClientLikelyCausesInput): readonly string[] {
    const { snapshot, session, sessionId, wsStatus } = input;
    const causes = [];
    if (!snapshot) {
        causes.push('Client principal has no durable state snapshot.');
    }
    if (sessionId && !session) {
        causes.push('Requested client session is no longer active or belongs to another instance.');
    }
    if (
        session?.connectionId &&
        wsStatus &&
        !wsStatus.openConnectionIds.includes(session.connectionId)
    ) {
        causes.push('Client session state is active but the local WebSocket is not open.');
    }
    return causes;
}

function clientSuggestedActions(
    snapshot: ClientSnapshot | undefined,
    session: ClientSession | undefined,
    sessionId: string | undefined
): readonly AdminSupportSuggestedAction[] {
    const actions: AdminSupportSuggestedAction[] = [];
    if (!snapshot) {
        actions.push({
            code: 'verify-client-scope',
            label: 'Verify application/workspace scope and principal id',
            severity: 'info'
        });
    }
    if (sessionId && !session) {
        actions.push({
            code: 'refresh-client-session',
            label: 'Refresh client session state before retrying realtime operations',
            severity: 'warning'
        });
    }
    return actions;
}

function findClientSession(
    snapshot: ClientSnapshot | undefined,
    clientInstanceId: string | undefined,
    sessionId: string | undefined
): ClientSession | undefined {
    if (!snapshot) {
        return undefined;
    }
    return snapshot.activeSessions.find(
        (session) =>
            (clientInstanceId === undefined || session.clientInstanceId === clientInstanceId) &&
            (sessionId === undefined || session.sessionId === sessionId)
    );
}

function toClientRef(ref: ClientPrincipalRef): string {
    return `${ref.applicationId}/${ref.workspaceId}/${ref.principalId}`;
}
