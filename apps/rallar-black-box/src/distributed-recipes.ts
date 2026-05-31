import type {
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedRoleAssignment,
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedRunRecipeSelection,
    RallarBlackBoxDistributedTargetPolicy,
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/types.ts';
import type {
    ControlAgentSnapshot,
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunCommandLink,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
} from './control-run-manager.ts';

export type DistributedRecipeRolePattern =
    | 'all-agents'
    | 'sender-receiver'
    | 'one-sender-many-receivers'
    | 'three-browser-matrix';

export type DistributedRecipeTargetPolicyMode =
    | 'all-online-group-members'
    | 'selected-agents'
    | 'role-map';

export type DistributedRecipeCatalogItem = Readonly<{
    itemId: string;
    title: string;
    description: string;
    recipe: RallarBlackBoxTestRecipe;
    providerMode: string;
    profiles: readonly string[];
    prerequisites: readonly string[];
    live: boolean;
    source: 'app-local';
}>;

export type DistributedRecipeTargetStatus =
    | 'matched'
    | 'stale'
    | 'offline'
    | 'different-group'
    | 'missing-identity';

export type DistributedRecipeTargetRow = Readonly<{
    agentId: string;
    connected: boolean;
    status: DistributedRecipeTargetStatus;
    targetable: boolean;
    reason: string;
    principalId?: string;
    sessionId?: string;
    groupId?: string;
    applicationId?: string;
    workspaceId?: string;
    lastHeartbeatAtEpochMs?: number;
    lastSeenAtEpochMs?: number;
}>;

export type BuildDistributedRunManifestInput = Readonly<{
    distributedRunId: string;
    controlRunId: string;
    displayName?: string;
    group: RallarBlackBoxDistributedGroupRef;
    recipes: readonly DistributedRecipeCatalogItem[];
    targetAgentIds: readonly string[];
    targetPolicyMode: DistributedRecipeTargetPolicyMode;
    rolePattern: DistributedRecipeRolePattern;
    ackTimeoutMs: number;
    startMode: 'manual' | 'auto-after-ready' | 'scheduled';
    startDeadlineEpochMs?: number;
    expectedParticipantCount?: number;
}>;

export type DistributedRunProgressStatus =
    | 'pending'
    | 'queued'
    | 'running'
    | 'ready'
    | 'passed'
    | 'failed'
    | 'cancelled'
    | 'missing';

export type DistributedRunTimelineItem = Readonly<{
    id: string;
    atEpochMs: number;
    kind: 'lifecycle' | 'command' | 'result' | 'event' | 'failure' | 'artifact';
    label: string;
    detail?: string;
    tone: string;
    agentId?: string;
    recipeId?: string;
    commandId?: string;
    phase?: ControlDistributedRunCommandLink['phase'];
}>;

export type DistributedRunAgentProgressRow = Readonly<{
    agentId: string;
    role?: string;
    readiness: DistributedRunProgressStatus;
    execution: DistributedRunProgressStatus;
    stageCommandCount: number;
    startCommandCount: number;
    completedCommandCount: number;
    failedCommandCount: number;
    resultCount: number;
    eventCount: number;
    averageLatencyMs?: number;
    lastActivityAtEpochMs?: number;
}>;

export type DistributedRunRecipeProgressRow = Readonly<{
    recipeId: string;
    profile?: string;
    role?: string;
    required: boolean;
    targetCount: number;
    queuedCount: number;
    runningCount: number;
    passedCount: number;
    failedCount: number;
    missingCount: number;
    averageLatencyMs?: number;
}>;

export type DistributedRunReadinessRow = Readonly<{
    agentId: string;
    role?: string;
    status: DistributedRunProgressStatus;
    commandId?: string;
    queuedAtEpochMs?: number;
    completedAtEpochMs?: number;
    latencyMs?: number;
    error?: string;
}>;

export type DistributedRunFailureRow = Readonly<{
    kind: 'run' | 'participant' | 'recipe' | 'command';
    key: string;
    message: string;
    code?: string;
    agentId?: string;
    recipeId?: string;
    commandId?: string;
    atEpochMs?: number;
}>;

export type DistributedRunEventRow = Readonly<{
    eventId: string;
    atEpochMs: number;
    kind: string;
    agentId: string;
    commandId?: string;
    topic?: string;
    summary: string;
}>;

export type DistributedRunLatencySummary = Readonly<{
    count: number;
    minMs?: number;
    p50Ms?: number;
    p95Ms?: number;
    maxMs?: number;
    averageMs?: number;
}>;

export type DistributedRunArtifactValidationStatus =
    | 'not-loaded'
    | 'valid'
    | 'missing-file'
    | 'invalid-json';

export type DistributedRunArtifactValidation = Readonly<{
    status: DistributedRunArtifactValidationStatus;
    fileCount: number;
    message: string;
}>;

export type DistributedRunMonitor = Readonly<{
    distributedRunId: string;
    state: string;
    commandCounts: Readonly<{
        total: number;
        stage: number;
        start: number;
        cancel: number;
        completed: number;
        failed: number;
        pending: number;
    }>;
    resultCounts: Readonly<{
        total: number;
        ok: number;
        failed: number;
    }>;
    latency: DistributedRunLatencySummary;
    artifact: DistributedRunArtifactValidation;
    timeline: readonly DistributedRunTimelineItem[];
    agentProgress: readonly DistributedRunAgentProgressRow[];
    recipeProgress: readonly DistributedRunRecipeProgressRow[];
    readiness: readonly DistributedRunReadinessRow[];
    failures: readonly DistributedRunFailureRow[];
    events: readonly DistributedRunEventRow[];
}>;

export type DistributedRunHistoryFilter = Readonly<{
    query?: string;
    groupId?: string;
    recipeId?: string;
    profile?: string;
    user?: string;
    status?: string;
    failureType?: string;
    fromEpochMs?: number;
    toEpochMs?: number;
}>;

export type DistributedRunCompareSummary = Readonly<{
    leftId: string;
    rightId: string;
    recipeDelta: Readonly<{
        leftOnly: readonly string[];
        rightOnly: readonly string[];
        changedProfiles: readonly string[];
    }>;
    participantDelta: Readonly<{
        leftOnly: readonly string[];
        rightOnly: readonly string[];
        shared: readonly string[];
    }>;
    failureDelta: Readonly<{
        leftCount: number;
        rightCount: number;
        leftOnly: readonly string[];
        rightOnly: readonly string[];
    }>;
    timingDelta: Readonly<{
        leftDurationMs?: number;
        rightDurationMs?: number;
        durationDeltaMs?: number;
        startedDeltaMs?: number;
        completedDeltaMs?: number;
    }>;
    receivedMessageDelta: Readonly<{
        leftCount: number;
        rightCount: number;
        delta: number;
        leftOnly: readonly string[];
        rightOnly: readonly string[];
    }>;
}>;

export const DISTRIBUTED_RECIPE_ROLE_PATTERN_OPTIONS: readonly Readonly<{
    value: DistributedRecipeRolePattern;
    label: string;
    description: string;
}>[] = [
    {
        value: 'all-agents',
        label: 'All agents same recipe',
        description: 'Every selected browser receives every selected recipe.',
    },
    {
        value: 'sender-receiver',
        label: 'Sender / receiver pair',
        description: 'First target is sender, second target is receiver.',
    },
    {
        value: 'one-sender-many-receivers',
        label: 'One sender, many receivers',
        description: 'First target is sender, remaining targets are receivers.',
    },
    {
        value: 'three-browser-matrix',
        label: 'Three-browser matrix',
        description: 'First target publishes, second relays, third and later observe.',
    },
];

export function distributedRecipeTargetRows(input: Readonly<{
    run: ControlRunSnapshot | undefined;
    group: RallarBlackBoxDistributedGroupRef;
    nowEpochMs?: number;
    staleAfterMs?: number;
}>): readonly DistributedRecipeTargetRow[] {
    const nowEpochMs = input.nowEpochMs ?? Date.now();
    const staleAfterMs = input.staleAfterMs ?? 30_000;
    return [...(input.run?.agents ?? [])]
        .sort((left, right) => left.agentId.localeCompare(right.agentId))
        .map(agent => distributedRecipeTargetRow(agent, input.group, nowEpochMs, staleAfterMs));
}

export function defaultDistributedRecipeTargetIds(
    rows: readonly DistributedRecipeTargetRow[],
): readonly string[] {
    return rows
        .filter(row => row.targetable)
        .map(row => row.agentId);
}

export function buildDistributedRunManifest(
    input: BuildDistributedRunManifestInput,
): RallarBlackBoxDistributedRunManifest {
    const recipeSelections = input.recipes.map((item, index) => ({
        recipeId: item.recipe.recipeId,
        recipe: item.recipe,
        role: recipeRoleForPattern(input.rolePattern, index, input.recipes.length),
        profile: item.profiles[0],
        required: true,
    } satisfies RallarBlackBoxDistributedRunRecipeSelection));
    const roles = rolesForPattern(input.rolePattern, input.targetAgentIds);
    const targetPolicy = buildTargetPolicy({
        mode: input.targetPolicyMode,
        agentIds: input.targetAgentIds,
        roles,
        expectedParticipantCount: input.expectedParticipantCount,
    });
    const roleAssignments = roleAssignmentsForPattern(input.rolePattern, input.targetAgentIds);

    return {
        schemaVersion: 1,
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        displayName: input.displayName,
        group: input.group,
        recipes: recipeSelections,
        targetPolicy,
        roleAssignments,
        ackTimeoutMs: input.ackTimeoutMs,
        startMode: input.startMode,
        startDeadlineEpochMs: input.startMode === 'scheduled'
            ? input.startDeadlineEpochMs
            : undefined,
        artifactPolicy: {
            retainArtifacts: true,
            includeDistributedMetadata: true,
            includeEventJsonl: true,
            includeResultJsonl: true,
            includeFailureBundle: true,
        },
        metadata: {
            createdBy: 'rallar-black-box-spa',
            rolePattern: input.rolePattern,
        },
    };
}

export function distributedRecipeStateTone(state: string): string {
    if (state === 'passed' || state === 'ready') {
        return 'good';
    }
    if (state === 'running' || state === 'waiting-for-ack' || state === 'staging') {
        return 'active';
    }
    if (state === 'failed' || state === 'timed-out') {
        return 'bad';
    }
    if (state === 'cancelled') {
        return 'warn';
    }
    return 'muted';
}

export function deriveDistributedRunMonitor(input: Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    controlRun?: ControlRunSnapshot;
    artifactBundle?: ControlDistributedRunArtifactBundle;
}>): DistributedRunMonitor {
    const linkedCommandIds = new Set(input.distributedRun.commandLinks.map(link => link.commandId));
    const commands = new Map((input.controlRun?.commands ?? [])
        .map(command => [command.envelope.commandId, command]));
    const linkedResults = (input.controlRun?.results ?? [])
        .filter(result => linkedCommandIds.has(result.commandId));
    const resultsByCommandId = new Map(linkedResults.map(result => [result.commandId, result]));
    const linkedEvents = distributedRunEvents(input.distributedRun, input.controlRun);
    const failures = distributedRunFailures(input.distributedRun, linkedResults, commands);
    const commandCounts = distributedRunCommandCounts(
        input.distributedRun.commandLinks,
        commands,
        resultsByCommandId,
    );
    const latencies = linkedResults
        .map(result => result.result?.durationMs)
        .filter(isFiniteNumber);
    const artifact = validateDistributedRunArtifact(input.artifactBundle);

    return {
        distributedRunId: input.distributedRun.distributedRunId,
        state: input.distributedRun.state,
        commandCounts,
        resultCounts: {
            total: linkedResults.length,
            ok: linkedResults.filter(result => result.ok).length,
            failed: linkedResults.filter(result => !result.ok).length,
        },
        latency: summarizeLatencies(latencies),
        artifact,
        timeline: distributedRunTimeline({
            distributedRun: input.distributedRun,
            commands,
            results: linkedResults,
            events: linkedEvents,
            failures,
            artifact,
        }),
        agentProgress: distributedRunAgentProgress({
            distributedRun: input.distributedRun,
            commands,
            resultsByCommandId,
            events: linkedEvents,
        }),
        recipeProgress: distributedRunRecipeProgress({
            distributedRun: input.distributedRun,
            commands,
            resultsByCommandId,
        }),
        readiness: distributedRunReadiness({
            distributedRun: input.distributedRun,
            commands,
            resultsByCommandId,
        }),
        failures,
        events: linkedEvents,
    };
}

export function filterDistributedRuns(
    runs: readonly ControlDistributedRunSnapshot[],
    filter: DistributedRunHistoryFilter,
): readonly ControlDistributedRunSnapshot[] {
    const query = normalizeFilterText(filter.query);
    const groupId = normalizeFilterText(filter.groupId);
    const recipeId = normalizeFilterText(filter.recipeId);
    const profile = normalizeFilterText(filter.profile);
    const user = normalizeFilterText(filter.user);
    const status = normalizeFilterText(filter.status);
    const failureType = normalizeFilterText(filter.failureType);

    return [...runs]
        .filter(run => {
            if (status && normalizeFilterText(run.state) !== status) {
                return false;
            }
            if (groupId && !normalizeFilterText(run.manifest.group.groupId).includes(groupId)) {
                return false;
            }
            if (recipeId && !run.manifest.recipes.some(selection =>
                normalizeFilterText(recipeSelectionId(selection)).includes(recipeId)
            )) {
                return false;
            }
            if (profile && !run.manifest.recipes.some(selection =>
                normalizeFilterText(selection.profile).includes(profile)
            )) {
                return false;
            }
            if (user && !normalizeFilterText(String(run.manifest.metadata?.createdBy ?? '')).includes(user)) {
                return false;
            }
            if (filter.fromEpochMs !== undefined && run.createdAtEpochMs < filter.fromEpochMs) {
                return false;
            }
            if (filter.toEpochMs !== undefined && run.createdAtEpochMs > filter.toEpochMs) {
                return false;
            }
            if (failureType && !distributedRunMatchesFailureType(run, failureType)) {
                return false;
            }
            if (!query) {
                return true;
            }
            return distributedRunSearchText(run).includes(query);
        })
        .sort((left, right) => right.updatedAtEpochMs - left.updatedAtEpochMs);
}

export function compareDistributedRuns(input: Readonly<{
    left: ControlDistributedRunSnapshot;
    right: ControlDistributedRunSnapshot;
    leftControlRun?: ControlRunSnapshot;
    rightControlRun?: ControlRunSnapshot;
}>): DistributedRunCompareSummary {
    const leftRecipes = recipeCompareMap(input.left);
    const rightRecipes = recipeCompareMap(input.right);
    const leftParticipants = new Set(input.left.targetAgentIds);
    const rightParticipants = new Set(input.right.targetAgentIds);
    const leftFailures = distributedRunFailureSignatures(input.left);
    const rightFailures = distributedRunFailureSignatures(input.right);
    const leftMessages = distributedRunReceivedMessageSignatures(input.left, input.leftControlRun);
    const rightMessages = distributedRunReceivedMessageSignatures(input.right, input.rightControlRun);
    const leftDurationMs = distributedRunDuration(input.left);
    const rightDurationMs = distributedRunDuration(input.right);

    return {
        leftId: input.left.distributedRunId,
        rightId: input.right.distributedRunId,
        recipeDelta: {
            leftOnly: setDifference([...leftRecipes.keys()], new Set(rightRecipes.keys())),
            rightOnly: setDifference([...rightRecipes.keys()], new Set(leftRecipes.keys())),
            changedProfiles: [...leftRecipes.entries()]
                .filter(([recipeId, leftProfile]) =>
                    rightRecipes.has(recipeId) && rightRecipes.get(recipeId) !== leftProfile
                )
                .map(([recipeId, leftProfile]) => `${recipeId}: ${leftProfile || '-'} -> ${rightRecipes.get(recipeId) || '-'}`),
        },
        participantDelta: {
            leftOnly: setDifference([...leftParticipants], rightParticipants),
            rightOnly: setDifference([...rightParticipants], leftParticipants),
            shared: [...leftParticipants]
                .filter(agentId => rightParticipants.has(agentId))
                .sort(),
        },
        failureDelta: {
            leftCount: leftFailures.length,
            rightCount: rightFailures.length,
            leftOnly: setDifference(leftFailures, new Set(rightFailures)),
            rightOnly: setDifference(rightFailures, new Set(leftFailures)),
        },
        timingDelta: {
            leftDurationMs,
            rightDurationMs,
            durationDeltaMs: leftDurationMs !== undefined && rightDurationMs !== undefined
                ? rightDurationMs - leftDurationMs
                : undefined,
            startedDeltaMs: input.left.startedAtEpochMs !== undefined && input.right.startedAtEpochMs !== undefined
                ? input.right.startedAtEpochMs - input.left.startedAtEpochMs
                : undefined,
            completedDeltaMs: input.left.completedAtEpochMs !== undefined && input.right.completedAtEpochMs !== undefined
                ? input.right.completedAtEpochMs - input.left.completedAtEpochMs
                : undefined,
        },
        receivedMessageDelta: {
            leftCount: leftMessages.length,
            rightCount: rightMessages.length,
            delta: rightMessages.length - leftMessages.length,
            leftOnly: setDifference(leftMessages, new Set(rightMessages)),
            rightOnly: setDifference(rightMessages, new Set(leftMessages)),
        },
    };
}

function distributedRecipeTargetRow(
    agent: ControlAgentSnapshot,
    group: RallarBlackBoxDistributedGroupRef,
    nowEpochMs: number,
    staleAfterMs: number,
): DistributedRecipeTargetRow {
    const identity = agent.identity;
    const lastActiveAtEpochMs = agent.lastHeartbeatAtEpochMs ?? agent.lastSeenAtEpochMs ?? identity?.updatedAtEpochMs;
    const stale = typeof lastActiveAtEpochMs === 'number' && nowEpochMs - lastActiveAtEpochMs > staleAfterMs;
    const base = {
        agentId: agent.agentId,
        connected: agent.connected,
        principalId: identity?.principalId ?? identity?.clientId ?? identity?.username,
        sessionId: identity?.sessionId,
        groupId: identity?.groupId,
        applicationId: identity?.applicationId,
        workspaceId: identity?.workspaceId,
        lastHeartbeatAtEpochMs: agent.lastHeartbeatAtEpochMs,
        lastSeenAtEpochMs: agent.lastSeenAtEpochMs,
    };

    if (!identity?.applicationId || !identity.workspaceId || !identity.groupId) {
        return {
            ...base,
            status: 'missing-identity',
            targetable: false,
            reason: 'Agent has not reported enough Rallar identity metadata.',
        };
    }

    if (
        identity.applicationId !== group.applicationId ||
        identity.workspaceId !== group.workspaceId ||
        identity.groupId !== group.groupId
    ) {
        return {
            ...base,
            status: 'different-group',
            targetable: false,
            reason: 'Agent identity does not match the selected global group.',
        };
    }

    if (!agent.connected) {
        return {
            ...base,
            status: 'offline',
            targetable: false,
            reason: 'Agent matches the group but is disconnected from the control server.',
        };
    }

    if (stale) {
        return {
            ...base,
            status: 'stale',
            targetable: false,
            reason: 'Agent matches the group but the last heartbeat is stale.',
        };
    }

    return {
        ...base,
        status: 'matched',
        targetable: true,
        reason: 'Agent is connected and reports the selected global group.',
    };
}

function buildTargetPolicy(input: Readonly<{
    mode: DistributedRecipeTargetPolicyMode;
    agentIds: readonly string[];
    roles: Readonly<Record<string, readonly string[]>>;
    expectedParticipantCount?: number;
}>): RallarBlackBoxDistributedTargetPolicy {
    const expected = input.expectedParticipantCount && input.expectedParticipantCount > 0
        ? { expectedParticipantCount: Math.floor(input.expectedParticipantCount) }
        : {};
    if (input.mode === 'all-online-group-members') {
        return {
            mode: input.mode,
            ...expected,
        };
    }
    if (input.mode === 'role-map') {
        return {
            mode: input.mode,
            roles: input.roles,
            ...expected,
        };
    }
    return {
        mode: input.mode,
        agentIds: input.agentIds,
        ...expected,
    };
}

function roleAssignmentsForPattern(
    pattern: DistributedRecipeRolePattern,
    agentIds: readonly string[],
): readonly RallarBlackBoxDistributedRoleAssignment[] | undefined {
    const roles = rolesForPattern(pattern, agentIds);
    const assignments = Object.entries(roles).flatMap(([role, ids]) =>
        ids.map(agentId => ({
            role,
            agentId,
            required: true,
        }))
    );
    return assignments.length > 0 ? assignments : undefined;
}

function rolesForPattern(
    pattern: DistributedRecipeRolePattern,
    agentIds: readonly string[],
): Readonly<Record<string, readonly string[]>> {
    if (pattern === 'all-agents') {
        return {};
    }
    if (pattern === 'sender-receiver') {
        return {
            sender: agentIds.slice(0, 1),
            receiver: agentIds.slice(1, 2),
        };
    }
    if (pattern === 'one-sender-many-receivers') {
        return {
            sender: agentIds.slice(0, 1),
            receiver: agentIds.slice(1),
        };
    }
    return {
        publisher: agentIds.slice(0, 1),
        relay: agentIds.slice(1, 2),
        observer: agentIds.slice(2),
    };
}

function recipeRoleForPattern(
    pattern: DistributedRecipeRolePattern,
    recipeIndex: number,
    recipeCount: number,
): string | undefined {
    if (pattern === 'all-agents' || recipeCount < 2) {
        return undefined;
    }
    if (pattern === 'sender-receiver' || pattern === 'one-sender-many-receivers') {
        return recipeIndex === 0 ? 'sender' : 'receiver';
    }
    const roles = ['publisher', 'relay', 'observer'];
    return roles[Math.min(recipeIndex, roles.length - 1)];
}

type ControlCommandSnapshot = ControlRunSnapshot['commands'][number];
type ControlResultSnapshot = ControlRunSnapshot['results'][number];
type ControlEventSnapshot = ControlRunSnapshot['events'][number];

function distributedRunCommandCounts(
    links: readonly ControlDistributedRunCommandLink[],
    commands: ReadonlyMap<string, ControlCommandSnapshot>,
    resultsByCommandId: ReadonlyMap<string, ControlResultSnapshot>,
): DistributedRunMonitor['commandCounts'] {
    const completed = links.filter(link =>
        resultsByCommandId.has(link.commandId) ||
        commands.get(link.commandId)?.completedAtEpochMs !== undefined
    ).length;
    const failed = links.filter(link => resultsByCommandId.get(link.commandId)?.ok === false).length;

    return {
        total: links.length,
        stage: links.filter(link => link.phase === 'stage').length,
        start: links.filter(link => link.phase === 'start').length,
        cancel: links.filter(link => link.phase === 'cancel').length,
        completed,
        failed,
        pending: Math.max(0, links.length - completed),
    };
}

function distributedRunEvents(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot | undefined,
): readonly DistributedRunEventRow[] {
    if (!controlRun) {
        return [];
    }
    const linkedCommandIds = new Set(distributedRun.commandLinks.map(link => link.commandId));
    return controlRun.events
        .filter(event =>
            (event.commandId !== undefined && linkedCommandIds.has(event.commandId)) ||
            payloadReferencesDistributedRun(event.payload, distributedRun.distributedRunId)
        )
        .sort((left, right) => left.atEpochMs - right.atEpochMs)
        .map((event, index) => ({
            eventId: event.eventId ?? `${event.agentId}-${event.commandId ?? 'event'}-${index}`,
            atEpochMs: event.atEpochMs,
            kind: event.kind,
            agentId: event.agentId,
            commandId: event.commandId,
            topic: payloadTopic(event.payload),
            summary: eventSummary(event),
        }));
}

function distributedRunFailures(
    distributedRun: ControlDistributedRunSnapshot,
    results: readonly ControlResultSnapshot[],
    commands: ReadonlyMap<string, ControlCommandSnapshot>,
): readonly DistributedRunFailureRow[] {
    const rows: DistributedRunFailureRow[] = [];
    if (distributedRun.error) {
        rows.push({
            kind: 'run',
            key: distributedRun.distributedRunId,
            code: distributedRun.error.code,
            message: distributedRun.error.message,
            atEpochMs: distributedRun.updatedAtEpochMs,
        });
    }

    distributedRun.rollup.failures.forEach(failure => {
        rows.push({
            kind: failure.kind,
            key: failure.key,
            code: failure.error?.code,
            message: failure.error?.message ?? failure.state,
            atEpochMs: distributedRun.updatedAtEpochMs,
            agentId: failure.kind === 'participant' ? failure.key : undefined,
            recipeId: failure.kind === 'recipe' ? failure.key : undefined,
        });
    });

    results
        .filter(result => !result.ok)
        .forEach(result => {
            const command = commands.get(result.commandId);
            rows.push({
                kind: 'command',
                key: result.commandId,
                commandId: result.commandId,
                agentId: result.agentId,
                recipeId: command?.envelope.command.kind === 'recipe.run'
                    ? command.envelope.command.recipe?.recipeId
                    : undefined,
                code: result.error?.code ?? result.result?.error?.code,
                message: result.error?.message ?? result.result?.error?.message ?? 'Command failed.',
                atEpochMs: result.result?.endedAtEpochMs ?? command?.completedAtEpochMs,
            });
        });

    return rows.sort((left, right) => (right.atEpochMs ?? 0) - (left.atEpochMs ?? 0));
}

function distributedRunTimeline(input: Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    commands: ReadonlyMap<string, ControlCommandSnapshot>;
    results: readonly ControlResultSnapshot[];
    events: readonly DistributedRunEventRow[];
    failures: readonly DistributedRunFailureRow[];
    artifact: DistributedRunArtifactValidation;
}>): readonly DistributedRunTimelineItem[] {
    const items: DistributedRunTimelineItem[] = [];
    addTimeline(items, {
        id: 'created',
        atEpochMs: input.distributedRun.createdAtEpochMs,
        kind: 'lifecycle',
        label: 'created',
        tone: 'muted',
    });
    addTimeline(items, {
        id: 'staged',
        atEpochMs: input.distributedRun.stagedAtEpochMs,
        kind: 'lifecycle',
        label: 'staged',
        tone: 'active',
    });
    addTimeline(items, {
        id: 'started',
        atEpochMs: input.distributedRun.startedAtEpochMs,
        kind: 'lifecycle',
        label: 'started',
        tone: 'active',
    });
    addTimeline(items, {
        id: 'cancelled',
        atEpochMs: input.distributedRun.cancelledAtEpochMs,
        kind: 'lifecycle',
        label: 'cancelled',
        tone: 'warn',
    });
    addTimeline(items, {
        id: 'completed',
        atEpochMs: input.distributedRun.completedAtEpochMs,
        kind: 'lifecycle',
        label: 'completed',
        tone: distributedRecipeStateTone(input.distributedRun.state),
    });

    input.distributedRun.commandLinks.forEach(link => {
        const command = input.commands.get(link.commandId);
        addTimeline(items, {
            id: `queued-${link.commandId}`,
            atEpochMs: link.queuedAtEpochMs,
            kind: 'command',
            label: `${link.phase} queued`,
            detail: command?.envelope.command.kind,
            tone: 'muted',
            agentId: link.agentId,
            recipeId: link.recipeId,
            commandId: link.commandId,
            phase: link.phase,
        });
        addTimeline(items, {
            id: `dispatched-${link.commandId}`,
            atEpochMs: command?.dispatchedAtEpochMs,
            kind: 'command',
            label: `${link.phase} dispatched`,
            detail: command?.envelope.command.kind,
            tone: 'active',
            agentId: link.agentId,
            recipeId: link.recipeId,
            commandId: link.commandId,
            phase: link.phase,
        });
        addTimeline(items, {
            id: `completed-${link.commandId}`,
            atEpochMs: command?.completedAtEpochMs,
            kind: 'command',
            label: `${link.phase} completed`,
            detail: command?.envelope.command.kind,
            tone: 'good',
            agentId: link.agentId,
            recipeId: link.recipeId,
            commandId: link.commandId,
            phase: link.phase,
        });
    });

    input.results.forEach(result => {
        addTimeline(items, {
            id: `result-${result.commandId}`,
            atEpochMs: result.result?.endedAtEpochMs,
            kind: 'result',
            label: result.ok ? 'result ok' : 'result failed',
            detail: result.result?.kind,
            tone: result.ok ? 'good' : 'bad',
            agentId: result.agentId,
            commandId: result.commandId,
        });
    });

    input.failures.forEach((failure, index) => {
        addTimeline(items, {
            id: `failure-${failure.key}-${index}`,
            atEpochMs: failure.atEpochMs,
            kind: 'failure',
            label: failure.code ?? failure.kind,
            detail: failure.message,
            tone: 'bad',
            agentId: failure.agentId,
            recipeId: failure.recipeId,
            commandId: failure.commandId,
        });
    });

    input.events.forEach(event => {
        addTimeline(items, {
            id: `event-${event.eventId}`,
            atEpochMs: event.atEpochMs,
            kind: 'event',
            label: event.kind,
            detail: event.summary,
            tone: 'muted',
            agentId: event.agentId,
            commandId: event.commandId,
        });
    });

    return items.sort((left, right) => left.atEpochMs - right.atEpochMs || left.id.localeCompare(right.id));
}

function addTimeline(
    items: DistributedRunTimelineItem[],
    item: Omit<DistributedRunTimelineItem, 'atEpochMs'> & { atEpochMs?: number },
): void {
    if (item.atEpochMs === undefined) {
        return;
    }
    items.push(item as DistributedRunTimelineItem);
}

function distributedRunAgentProgress(input: Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    commands: ReadonlyMap<string, ControlCommandSnapshot>;
    resultsByCommandId: ReadonlyMap<string, ControlResultSnapshot>;
    events: readonly DistributedRunEventRow[];
}>): readonly DistributedRunAgentProgressRow[] {
    const agentIds = new Set([
        ...input.distributedRun.targetAgentIds,
        ...input.distributedRun.commandLinks.map(link => link.agentId),
    ]);
    return [...agentIds].sort().map(agentId => {
        const links = input.distributedRun.commandLinks.filter(link => link.agentId === agentId);
        const stageLinks = links.filter(link => link.phase === 'stage');
        const startLinks = links.filter(link => link.phase === 'start');
        const linkedResults = links
            .map(link => input.resultsByCommandId.get(link.commandId))
            .filter((result): result is ControlResultSnapshot => result !== undefined);
        const linkedEvents = input.events.filter(event => event.agentId === agentId);
        const latencies = linkedResults
            .map(result => result.result?.durationMs)
            .filter(isFiniteNumber);
        const lastActivityAtEpochMs = maxNumber([
            ...links.map(link => link.queuedAtEpochMs),
            ...links.map(link => input.commands.get(link.commandId)?.dispatchedAtEpochMs),
            ...links.map(link => input.commands.get(link.commandId)?.completedAtEpochMs),
            ...linkedResults.map(result => result.result?.endedAtEpochMs),
            ...linkedEvents.map(event => event.atEpochMs),
        ]);

        return {
            agentId,
            role: agentRole(input.distributedRun, agentId),
            readiness: linkProgressStatus(stageLinks, input.commands, input.resultsByCommandId, 'ready'),
            execution: linkProgressStatus(startLinks, input.commands, input.resultsByCommandId, 'passed'),
            stageCommandCount: stageLinks.length,
            startCommandCount: startLinks.length,
            completedCommandCount: links.filter(link =>
                input.resultsByCommandId.has(link.commandId) ||
                input.commands.get(link.commandId)?.completedAtEpochMs !== undefined
            ).length,
            failedCommandCount: linkedResults.filter(result => !result.ok).length,
            resultCount: linkedResults.length,
            eventCount: linkedEvents.length,
            averageLatencyMs: average(latencies),
            lastActivityAtEpochMs,
        };
    });
}

function distributedRunRecipeProgress(input: Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    commands: ReadonlyMap<string, ControlCommandSnapshot>;
    resultsByCommandId: ReadonlyMap<string, ControlResultSnapshot>;
}>): readonly DistributedRunRecipeProgressRow[] {
    return input.distributedRun.manifest.recipes.map((selection, index) => {
        const recipeId = recipeSelectionId(selection, index);
        const links = input.distributedRun.commandLinks.filter(link =>
            link.recipeId === recipeId ||
            (link.recipeId === undefined && input.distributedRun.manifest.recipes.length === 1)
        );
        const startLinks = links.filter(link => link.phase === 'start');
        const progressLinks = startLinks.length > 0 ? startLinks : links.filter(link => link.phase === 'stage');
        const results = progressLinks
            .map(link => input.resultsByCommandId.get(link.commandId))
            .filter((result): result is ControlResultSnapshot => result !== undefined);
        const targetAgentsWithLinks = new Set(progressLinks.map(link => link.agentId));
        const latencies = results.map(result => result.result?.durationMs).filter(isFiniteNumber);

        return {
            recipeId,
            profile: selection.profile,
            role: selection.role,
            required: selection.required !== false,
            targetCount: input.distributedRun.targetAgentIds.length,
            queuedCount: progressLinks.filter(link =>
                input.commands.get(link.commandId)?.dispatchedAtEpochMs === undefined &&
                !input.resultsByCommandId.has(link.commandId)
            ).length,
            runningCount: progressLinks.filter(link =>
                input.commands.get(link.commandId)?.dispatchedAtEpochMs !== undefined &&
                !input.resultsByCommandId.has(link.commandId)
            ).length,
            passedCount: results.filter(result => result.ok).length,
            failedCount: results.filter(result => !result.ok).length,
            missingCount: Math.max(0, input.distributedRun.targetAgentIds.length - targetAgentsWithLinks.size),
            averageLatencyMs: average(latencies),
        };
    });
}

function distributedRunReadiness(input: Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    commands: ReadonlyMap<string, ControlCommandSnapshot>;
    resultsByCommandId: ReadonlyMap<string, ControlResultSnapshot>;
}>): readonly DistributedRunReadinessRow[] {
    return input.distributedRun.targetAgentIds.map(agentId => {
        const stageLinks = input.distributedRun.commandLinks
            .filter(link => link.phase === 'stage' && link.agentId === agentId);
        if (stageLinks.length === 0) {
            return {
                agentId,
                role: agentRole(input.distributedRun, agentId),
                status: 'missing',
                error: 'No stage command was queued for this target.',
            };
        }
        const failedLink = stageLinks.find(link => input.resultsByCommandId.get(link.commandId)?.ok === false);
        const pendingLink = stageLinks.find(link => !input.resultsByCommandId.has(link.commandId));
        const representative = failedLink ?? pendingLink ?? stageLinks[stageLinks.length - 1];
        const result = input.resultsByCommandId.get(representative.commandId);
        const command = input.commands.get(representative.commandId);
        const latencyMs = result?.result?.durationMs ??
            durationBetween(representative.queuedAtEpochMs, command?.completedAtEpochMs);

        return {
            agentId,
            role: agentRole(input.distributedRun, agentId),
            status: failedLink
                ? 'failed'
                : pendingLink
                ? command?.dispatchedAtEpochMs !== undefined ? 'running' : 'queued'
                : 'ready',
            commandId: representative.commandId,
            queuedAtEpochMs: representative.queuedAtEpochMs,
            completedAtEpochMs: result?.result?.endedAtEpochMs ?? command?.completedAtEpochMs,
            latencyMs,
            error: result?.error?.message ?? result?.result?.error?.message,
        };
    });
}

function linkProgressStatus(
    links: readonly ControlDistributedRunCommandLink[],
    commands: ReadonlyMap<string, ControlCommandSnapshot>,
    resultsByCommandId: ReadonlyMap<string, ControlResultSnapshot>,
    successStatus: DistributedRunProgressStatus,
): DistributedRunProgressStatus {
    if (links.length === 0) {
        return 'missing';
    }
    if (links.some(link => resultsByCommandId.get(link.commandId)?.ok === false)) {
        return 'failed';
    }
    if (links.every(link => resultsByCommandId.get(link.commandId)?.ok === true)) {
        return successStatus;
    }
    if (links.some(link => commands.get(link.commandId)?.dispatchedAtEpochMs !== undefined)) {
        return 'running';
    }
    return 'queued';
}

function summarizeLatencies(values: readonly number[]): DistributedRunLatencySummary {
    if (values.length === 0) {
        return { count: 0 };
    }
    const sorted = [...values].sort((left, right) => left - right);
    return {
        count: sorted.length,
        minMs: sorted[0],
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        maxMs: sorted[sorted.length - 1],
        averageMs: average(sorted),
    };
}

function validateDistributedRunArtifact(
    bundle: ControlDistributedRunArtifactBundle | undefined,
): DistributedRunArtifactValidation {
    if (!bundle) {
        return {
            status: 'not-loaded',
            fileCount: 0,
            message: 'Artifact bundle has not been loaded.',
        };
    }

    const requiredFiles: ReadonlyArray<keyof ControlDistributedRunArtifactBundle['files']> = [
        'distributed-run.json',
        'manifest.json',
        'control-run.json',
    ];
    const missing = requiredFiles.filter(fileName => !bundle.files[fileName]);
    if (missing.length > 0) {
        return {
            status: 'missing-file',
            fileCount: Object.keys(bundle.files).length,
            message: `Missing ${missing.join(', ')}.`,
        };
    }
    try {
        requiredFiles.forEach(fileName => JSON.parse(bundle.files[fileName]));
    } catch (caught) {
        return {
            status: 'invalid-json',
            fileCount: Object.keys(bundle.files).length,
            message: caught instanceof Error ? caught.message : String(caught),
        };
    }
    return {
        status: 'valid',
        fileCount: Object.keys(bundle.files).length,
        message: 'Distributed artifact files are present and valid JSON.',
    };
}

function recipeSelectionId(
    selection: RallarBlackBoxDistributedRunRecipeSelection,
    index = 0,
): string {
    return selection.recipeId ?? selection.recipe?.recipeId ?? `recipe-${index + 1}`;
}

function agentRole(
    run: ControlDistributedRunSnapshot,
    agentId: string,
): string | undefined {
    const roles = run.manifest.roleAssignments
        ?.filter(assignment => assignment.agentId === agentId)
        .map(assignment => assignment.role) ?? [];
    return roles.length > 0 ? roles.join(', ') : undefined;
}

function recipeCompareMap(run: ControlDistributedRunSnapshot): ReadonlyMap<string, string> {
    return new Map(run.manifest.recipes.map((selection, index) => [
        recipeSelectionId(selection, index),
        selection.profile ?? '',
    ]));
}

function distributedRunFailureSignatures(run: ControlDistributedRunSnapshot): readonly string[] {
    const signatures = run.rollup.failures.map(failure =>
        `${failure.kind}:${failure.key}:${failure.state}:${failure.error?.code ?? ''}:${failure.error?.message ?? ''}`
    );
    if (run.error) {
        signatures.push(`run:${run.error.code}:${run.error.message}`);
    }
    return signatures.sort();
}

function distributedRunReceivedMessageSignatures(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot | undefined,
): readonly string[] {
    return distributedRunEvents(distributedRun, controlRun)
        .filter(event => {
            const text = `${event.kind} ${event.topic ?? ''} ${event.summary}`.toLowerCase();
            return text.includes('message') || text.includes('received') || text.includes('payload');
        })
        .map(event => `${event.agentId}:${event.commandId ?? event.eventId}:${event.summary}`)
        .sort();
}

function distributedRunDuration(run: ControlDistributedRunSnapshot): number | undefined {
    const start = run.startedAtEpochMs ?? run.stagedAtEpochMs ?? run.createdAtEpochMs;
    const end = run.completedAtEpochMs ?? run.cancelledAtEpochMs ?? run.updatedAtEpochMs;
    return end >= start ? end - start : undefined;
}

function distributedRunMatchesFailureType(
    run: ControlDistributedRunSnapshot,
    failureType: string,
): boolean {
    const failures = [
        ...run.rollup.failures.map(failure =>
            `${failure.kind} ${failure.state} ${failure.error?.code ?? ''} ${failure.error?.message ?? ''}`
        ),
        run.error ? `run ${run.error.code} ${run.error.message}` : '',
    ].join(' ').toLowerCase();
    if (failureType === 'any') {
        return failures.trim().length > 0;
    }
    return failures.includes(failureType);
}

function distributedRunSearchText(run: ControlDistributedRunSnapshot): string {
    return [
        run.distributedRunId,
        run.controlRunId,
        run.state,
        run.manifest.displayName,
        run.manifest.group.applicationId,
        run.manifest.group.workspaceId,
        run.manifest.group.groupId,
        String(run.manifest.metadata?.createdBy ?? ''),
        ...run.targetAgentIds,
        ...run.manifest.recipes.flatMap((selection, index) => [
            recipeSelectionId(selection, index),
            selection.profile,
            selection.role,
        ]),
        ...distributedRunFailureSignatures(run),
    ].filter(Boolean).join(' ').toLowerCase();
}

function payloadReferencesDistributedRun(payload: unknown, distributedRunId: string): boolean {
    if (!payload || !distributedRunId) {
        return false;
    }
    try {
        return JSON.stringify(payload).includes(distributedRunId);
    } catch (_caught) {
        return false;
    }
}

function payloadTopic(payload: unknown): string | undefined {
    if (!isRecord(payload)) {
        return undefined;
    }
    return stringOrUndefined(payload.topic) ??
        stringOrUndefined(payload.name) ??
        stringOrUndefined(payload.eventTopic);
}

function eventSummary(event: ControlEventSnapshot): string {
    const payload = event.payload;
    if (isRecord(payload)) {
        const direct = stringOrUndefined(payload.message) ??
            stringOrUndefined(payload.status) ??
            stringOrUndefined(payload.name) ??
            stringOrUndefined(payload.kind) ??
            stringOrUndefined(payload.topic);
        if (direct) {
            return direct;
        }
    }
    return safePayloadSummary(payload);
}

function safePayloadSummary(value: unknown): string {
    if (value === undefined) {
        return '';
    }
    if (typeof value === 'string') {
        return value.length > 180 ? `${value.slice(0, 177)}...` : value;
    }
    try {
        const text = JSON.stringify(value);
        return text.length > 180 ? `${text.slice(0, 177)}...` : text;
    } catch (_caught) {
        return String(value);
    }
}

function normalizeFilterText(value: unknown): string {
    return String(value ?? '').trim().toLowerCase();
}

function setDifference(values: readonly string[], right: ReadonlySet<string>): readonly string[] {
    return values.filter(value => !right.has(value)).sort();
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function average(values: readonly number[]): number | undefined {
    if (values.length === 0) {
        return undefined;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sortedValues: readonly number[], quantile: number): number | undefined {
    if (sortedValues.length === 0) {
        return undefined;
    }
    const index = Math.min(
        sortedValues.length - 1,
        Math.max(0, Math.ceil(sortedValues.length * quantile) - 1),
    );
    return sortedValues[index];
}

function maxNumber(values: readonly (number | undefined)[]): number | undefined {
    const finite = values.filter(isFiniteNumber);
    return finite.length > 0 ? Math.max(...finite) : undefined;
}

function durationBetween(start: number | undefined, end: number | undefined): number | undefined {
    return start !== undefined && end !== undefined && end >= start
        ? end - start
        : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
