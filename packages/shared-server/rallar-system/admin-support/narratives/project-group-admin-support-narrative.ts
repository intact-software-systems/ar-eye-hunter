import type {
    AdminSupportExplainGroupRequest,
    AdminSupportFact,
    AdminSupportNarrativeResponse,
    AdminSupportSuggestedAction,
    AdminSupportTimelineItem,
    AdminSupportWarning
} from '@shared/api/admin-support-types.ts';
import type { GroupEvent, GroupPresenceSession, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { adminSupportNarrativeBase, type AdminSupportNarrativeBase } from './admin-support-narrative-base.ts';

interface ProjectGroupAdminSupportInput extends AdminSupportNarrativeBase {
    readonly request: AdminSupportExplainGroupRequest;
    readonly hasGroupStateService: boolean;
    readonly hasTopologyQuery: boolean;
    readonly snapshot: GroupSnapshot | undefined;
    readonly recentEvents: readonly GroupEvent[];
    readonly topologyView: unknown;
}

export function projectGroupAdminSupportNarrative(
    input: ProjectGroupAdminSupportInput
): AdminSupportNarrativeResponse {
    const session = findGroupSession(
        input.snapshot,
        input.request.principalId,
        input.request.sessionId
    );
    const facts = groupFacts({
        snapshot: input.snapshot,
        recentEvents: input.recentEvents,
        topologyView: input.topologyView,
        principalId: input.request.principalId,
        sessionId: input.request.sessionId,
        session
    });
    const warnings = groupWarnings({
        hasGroupStateService: input.hasGroupStateService,
        hasTopologyQuery: input.hasTopologyQuery,
        snapshot: input.snapshot,
        principalId: input.request.principalId,
        sessionId: input.request.sessionId,
        session,
        topologyView: input.topologyView
    });
    return {
        ...adminSupportNarrativeBase(input, {
            kind: 'group',
            groupRef: input.request.groupRef,
            principalId: input.request.principalId,
            sessionId: input.request.sessionId
        }),
        facts,
        timeline: groupTimeline(input.recentEvents),
        warnings,
        likelyCauses: groupLikelyCauses(
            input.snapshot,
            session,
            input.request.sessionId
        ),
        suggestedActions: groupSuggestedActions(
            input.snapshot,
            session,
            input.request.sessionId
        ),
        rawRefs: [`group:${toGroupRef(input.request.groupRef)}`]
    };
}

interface GroupFactsInput {
    readonly snapshot: GroupSnapshot | undefined;
    readonly recentEvents: readonly GroupEvent[];
    readonly topologyView: unknown;
    readonly principalId: string | undefined;
    readonly sessionId: string | undefined;
    readonly session: GroupPresenceSession | undefined;
}

interface GroupWarningsInput {
    readonly hasGroupStateService: boolean;
    readonly hasTopologyQuery: boolean;
    readonly snapshot: GroupSnapshot | undefined;
    readonly principalId: string | undefined;
    readonly sessionId: string | undefined;
    readonly session: GroupPresenceSession | undefined;
    readonly topologyView: unknown;
}

function groupFacts(input: GroupFactsInput): readonly AdminSupportFact[] {
    const facts: AdminSupportFact[] = [
        {
            label: 'group.snapshot',
            source: 'group-state',
            value: input.snapshot ? 'found' : 'missing',
            certainty: input.snapshot ? 'exact' : 'unavailable'
        }
    ];

    if (input.snapshot) {
        facts.push(
            {
                label: 'group.status',
                source: 'group-state',
                value: input.snapshot.group.status,
                certainty: 'exact'
            },
            {
                label: 'group.memberCount',
                source: 'group-state',
                value: input.snapshot.memberCount,
                certainty: 'exact'
            },
            {
                label: 'group.onlineMemberCount',
                source: 'group-state',
                value: input.snapshot.onlineMemberCount,
                certainty: 'exact'
            },
            {
                label: 'group.activeSessionCount',
                source: 'group-state',
                value: input.snapshot.activeSessions.length,
                certainty: 'exact'
            }
        );
        if (input.principalId) {
            const member = input.snapshot.members.find(
                (candidate) => candidate.principalId === input.principalId
            );
            facts.push({
                label: 'group.member.status',
                source: 'group-state',
                value: member?.status ?? 'missing',
                certainty: member ? 'exact' : 'unavailable'
            });
        }
    }

    if (input.sessionId || input.principalId) {
        facts.push({
            label: 'group.session.match',
            source: 'group-state',
            value: input.session ? 'found' : 'missing',
            certainty: input.session ? 'exact' : 'unavailable'
        });
    }

    facts.push(
        {
            label: 'group.topology',
            source: 'group-topology',
            value: summarizeTopologyView(input.topologyView),
            certainty: input.topologyView ? 'exact' : 'unavailable'
        },
        {
            label: 'group.recentEventCount',
            source: 'group-state-events',
            value: input.recentEvents.length,
            certainty: 'exact'
        }
    );

    return facts;
}

function groupTimeline(events: readonly GroupEvent[]): readonly AdminSupportTimelineItem[] {
    return events.map((event) => ({
        atEpochMs: event.occurredAtEpochMs,
        source: 'group-state-events',
        eventType: event.eventType,
        summary: `Group event ${event.eventType}.`,
        rawRef: `group-event:${event.eventId}`
    }));
}

function groupWarnings(input: GroupWarningsInput): readonly AdminSupportWarning[] {
    const warnings: AdminSupportWarning[] = [];
    if (!input.hasGroupStateService) {
        warnings.push({
            code: 'group-readers-unconfigured',
            message: 'Group state readers are not configured for support explanation.',
            source: 'admin-support'
        });
    }
    if (input.hasGroupStateService && !input.snapshot) {
        warnings.push({
            code: 'group-snapshot-missing',
            message: 'No group snapshot was found for the requested group.',
            source: 'group-state'
        });
    }
    if ((input.principalId || input.sessionId) && !input.session) {
        warnings.push({
            code: 'group-session-missing',
            message: 'No active group presence session matched the requested principal or session id.',
            source: 'group-state'
        });
    }
    if (!input.hasTopologyQuery) {
        warnings.push({
            code: 'topology-reader-unconfigured',
            message: 'Group topology reader is not configured for support explanation.',
            source: 'group-topology'
        });
    }
    else if (!input.topologyView) {
        warnings.push({
            code: 'topology-view-missing',
            message: 'No topology view was found for the requested group.',
            source: 'group-topology'
        });
    }
    return warnings;
}

function groupLikelyCauses(
    snapshot: GroupSnapshot | undefined,
    session: GroupPresenceSession | undefined,
    sessionId: string | undefined
): readonly string[] {
    const causes = [];
    if (!snapshot) {
        causes.push('Group has no durable state snapshot.');
    }
    if (sessionId && !session) {
        causes.push('Requested group session is no longer active.');
    }
    return causes;
}

function groupSuggestedActions(
    snapshot: GroupSnapshot | undefined,
    session: GroupPresenceSession | undefined,
    sessionId: string | undefined
): readonly AdminSupportSuggestedAction[] {
    const actions: AdminSupportSuggestedAction[] = [];
    if (!snapshot) {
        actions.push({
            code: 'verify-group-ref',
            label: 'Verify application/workspace scope and group id',
            severity: 'info'
        });
    }
    if (sessionId && !session) {
        actions.push({
            code: 'refresh-group-presence',
            label: 'Refresh group presence before retrying room traffic',
            severity: 'warning'
        });
    }
    return actions;
}

function findGroupSession(
    snapshot: GroupSnapshot | undefined,
    principalId: string | undefined,
    sessionId: string | undefined
): GroupPresenceSession | undefined {
    if (!snapshot) {
        return undefined;
    }
    return snapshot.activeSessions.find(
        (session) =>
            (principalId === undefined || session.principalId === principalId) &&
            (sessionId === undefined || session.sessionId === sessionId)
    );
}

function summarizeTopologyView(input: unknown): Readonly<Record<string, unknown>> {
    const view = readRecord(input);
    const snapshot = readRecord(view?.snapshot);
    const config = readRecord(view?.config);
    const effective = readRecord(config?.effective);
    const activeSessionIds = Array.isArray(snapshot?.activeSessionIds)
        ? snapshot.activeSessionIds
        : undefined;
    const participantCount = typeof snapshot?.participantCount === 'number'
        ? snapshot.participantCount
        : activeSessionIds?.length;
    return {
        present: Boolean(view),
        topologyKind: readTimingString(effective?.topologyKind) ??
            readTimingString(snapshot?.topology) ??
            readTimingString(snapshot?.kind),
        ...(participantCount !== undefined ? { participantCount } : {})
    };
}

function toGroupRef(ref: GroupRef): string {
    return `${ref.applicationId}/${ref.workspaceId}/${ref.groupId}`;
}

function readRecord(input: unknown): Record<string, unknown> | undefined {
    return input && typeof input === 'object' ? input as Record<string, unknown> : undefined;
}

function readTimingString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
