import type {
    AdminSupportExplainGroupRequest,
    AdminSupportFact,
    AdminSupportNarrativeResponse,
    AdminSupportSuggestedAction,
    AdminSupportTimelineItem,
    AdminSupportWarning
} from '@shared/api/admin-support/admin-support-types.ts';
import type { GroupTopologyManagementView } from '@shared/api/graph-topology-management-types.ts';
import type { GroupEvent, GroupPresenceSession, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { adminSupportNarrativeBase, type AdminSupportNarrativeBase } from './admin-support-narrative-base.ts';
import { groupLifecycleFacts } from './group-lifecycle-facts.ts';

interface ProjectGroupAdminSupportInput extends AdminSupportNarrativeBase {
    readonly request: AdminSupportExplainGroupRequest;
    readonly hasGroupStateService: boolean;
    readonly hasTopologyQuery: boolean;
    readonly snapshot: GroupSnapshot | undefined;
    readonly recentEvents: readonly GroupEvent[];
    readonly topologyView: GroupTopologyManagementView | undefined;
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
        facts.push(...groupLifecycleFacts(input.snapshot.group, input.topologyView?.snapshot ?? null));
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
    const group = input.snapshot?.group;
    if (group?.lifecycleState === 'dormant' && group.formationAttemptCount > 0) {
        // The series is spent: `start` is denied until a `reset` clears it
        // (product decision 37). Nothing is claimed here about admission --
        // decision 38 keeps whatever posture the policy asked for, so a closed
        // lobby stays closed, and this narrative cannot read that policy.
        warnings.push({
            code: 'group-formation-series-parked',
            message: `Formation parked in dormant after ${group.formationAttemptCount} attempt(s); ` +
                'a reset clears the series before another can start.',
            source: 'group-state'
        });
    }
    if (group?.transportState === 'halted') {
        // The valve is orthogonal to the stage (product decision 25), but it is
        // only half the data gate: `resume` clears the halt and the forward
        // gate can still refuse data before activation. `reset` also halts
        // (product decision 36), so a halt is not evidence of a pause.
        warnings.push({
            code: 'group-transport-halted',
            message: 'Transport is halted, so application data is refused; a reset halts as well as a pause. ' +
                'Resume clears the halt, which is not sufficient on its own before activation.',
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

function summarizeTopologyView(
    topologyView: GroupTopologyManagementView | undefined
): Readonly<{ present: boolean; topologyKind?: string; participantCount?: number; }> {
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
        ...(trafficSnapshot
            ? { participantCount: trafficSnapshot.activeSessionIds.length }
            : {})
    };
}

function toGroupRef(ref: GroupRef): string {
    return `${ref.applicationId}/${ref.workspaceId}/${ref.groupId}`;
}
