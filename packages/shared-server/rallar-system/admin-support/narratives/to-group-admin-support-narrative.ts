import type {
    AdminSupportExplainGroupRequest,
    AdminSupportFact,
    AdminSupportNarrativeResponse,
    AdminSupportSuggestedAction,
    AdminSupportTimelineItem,
    AdminSupportWarning
} from '@shared/api/admin-support/admin-support-types.ts';
import type { GroupTopologyManagementView } from '@shared/api/graph-topology-management-types.ts';
import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupEvent, GroupPresenceSession, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { isLiveGroupPresenceSession } from '../../group-state/policy/group-policy-primitives.ts';
import { adminSupportNarrativeBase, type AdminSupportNarrativeBase } from './admin-support-narrative-base.ts';
import { groupLifecycleFacts, isGroupFormationSeriesParked } from './group-lifecycle-facts.ts';
import { toGroupRoomFacts } from './to-group-room-facts.ts';

interface GroupAdminSupportNarrativeInput extends AdminSupportNarrativeBase {
    readonly request: AdminSupportExplainGroupRequest;
    readonly hasGroupStateService: boolean;
    readonly hasTopologyQuery: boolean;
    readonly snapshot: GroupSnapshot | undefined;
    readonly recentEvents: readonly GroupEvent[];
    readonly topologyView: GroupTopologyManagementView | undefined;
    /** Null when unreadable or unconfigured; the facts it feeds degrade rather than lie. */
    readonly policy: GroupLifecyclePolicy | null;
}

type GroupTopologySummary =
    | Readonly<{ present: false; }>
    | Readonly<{ present: true; topologyKind: string; participantCount: number | null; }>;

export function toGroupAdminSupportNarrative(
    input: GroupAdminSupportNarrativeInput
): AdminSupportNarrativeResponse {
    const session = input.snapshot?.activeSessions.find((session) =>
        isLiveGroupPresenceSession(session, input.generatedAtEpochMs) &&
        (input.request.principalId === undefined || session.principalId === input.request.principalId) &&
        (input.request.sessionId === undefined || session.sessionId === input.request.sessionId)
    );
    const facts = toGroupFacts({
        policy: input.policy,
        nowEpochMs: input.generatedAtEpochMs,
        snapshot: input.snapshot,
        recentEvents: input.recentEvents,
        topologyView: input.topologyView,
        principalId: input.request.principalId,
        sessionId: input.request.sessionId,
        session
    });
    const warnings = toGroupWarnings({
        policy: input.policy,
        nowEpochMs: input.generatedAtEpochMs,
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
        timeline: toGroupTimeline(input.recentEvents),
        warnings,
        likelyCauses: toGroupLikelyCauses(
            input.snapshot,
            session,
            input.request.sessionId
        ),
        suggestedActions: toGroupSuggestedActions(
            input.snapshot,
            session,
            input.request.sessionId
        ),
        rawRefs: [`group:${toGroupReferenceText(input.request.groupRef)}`]
    };
}

interface GroupFactsInput {
    readonly policy: GroupLifecyclePolicy | null;
    readonly nowEpochMs: number;
    readonly snapshot: GroupSnapshot | undefined;
    readonly recentEvents: readonly GroupEvent[];
    readonly topologyView: GroupTopologyManagementView | undefined;
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
    readonly topologyView: GroupTopologyManagementView | undefined;
    readonly policy: GroupLifecyclePolicy | null;
    readonly nowEpochMs: number;
}

function toGroupFacts(input: GroupFactsInput): readonly AdminSupportFact[] {
    const facts: AdminSupportFact[] = [
        {
            label: 'group.snapshot',
            source: 'group-state',
            value: input.snapshot ? 'found' : 'missing',
            certainty: input.snapshot ? 'exact' : 'unavailable'
        }
    ];

    if (input.snapshot) {
        facts.push(...toGroupRoomFacts({
            snapshot: input.snapshot,
            policy: input.policy,
            nowEpochMs: input.nowEpochMs
        }));
        facts.push(...groupLifecycleFacts({
            group: input.snapshot.group,
            plannedSnapshot: input.topologyView?.snapshot ?? null,
            acceptedSnapshot: input.topologyView?.acceptedSnapshot ?? null,
            replanQueued: input.topologyView?.pending != null,
            policy: input.policy,
            nowEpochMs: input.nowEpochMs
        }));
    }
    facts.push(...toRequestedMemberFacts(input));

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
            value: toTopologySummary(input.topologyView),
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

function toRequestedMemberFacts(input: GroupFactsInput): readonly AdminSupportFact[] {
    if (!input.snapshot || !input.principalId) {
        return [];
    }
    const member = input.snapshot.members.find((candidate) => candidate.principalId === input.principalId);
    return [{
        label: 'group.member.status',
        source: 'group-state',
        value: member?.status ?? 'missing',
        certainty: member ? 'exact' : 'unavailable'
    }];
}

function toGroupTimeline(events: readonly GroupEvent[]): readonly AdminSupportTimelineItem[] {
    return events.map((event) => ({
        atEpochMs: event.occurredAtEpochMs,
        source: 'group-state-events',
        eventType: event.eventType,
        summary: `Group event ${event.eventType}.`,
        rawRef: `group-event:${event.eventId}`
    }));
}

function toGroupWarnings(input: GroupWarningsInput): readonly AdminSupportWarning[] {
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
    warnings.push(...toGroupLifecycleWarnings(input));
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

function toGroupLifecycleWarnings(input: GroupWarningsInput): readonly AdminSupportWarning[] {
    const warnings: AdminSupportWarning[] = [];
    const group = input.snapshot?.group;
    if (group !== undefined && isGroupFormationSeriesParked(group, input.policy)) {
        warnings.push({
            code: 'group-formation-series-parked',
            message: `Formation parked in dormant after ${group.formationAttemptCount} attempt(s); ` +
                'a reset clears the series before another can start.',
            source: 'group-state'
        });
    }
    if (group?.transportState === 'halted') {
        warnings.push({
            code: 'group-transport-halted',
            message: 'Transport is halted, so application data is refused; a reset halts as well as a pause. ' +
                'Resume clears the halt, which is not sufficient on its own before activation.',
            source: 'group-state'
        });
    }
    return warnings;
}

function toGroupLikelyCauses(
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

function toGroupSuggestedActions(
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

function toTopologySummary(
    topologyView: GroupTopologyManagementView | undefined
): GroupTopologySummary {
    if (!topologyView) {
        return { present: false };
    }
    // The layout carrying traffic: the accepted slot once a promotion
    // produced one; the planned slot may run ahead as a held candidate and
    // must not be reported as the group's exact topology (decision 24).
    const trafficSnapshot = topologyView.acceptedSnapshot ?? topologyView.snapshot;
    return {
        present: true,
        topologyKind: topologyView.config.effective.topologyKind,
        participantCount: trafficSnapshot?.activeSessionIds.length ?? null
    };
}

function toGroupReferenceText(ref: GroupRef): string {
    return `${ref.applicationId}/${ref.workspaceId}/${ref.groupId}`;
}
