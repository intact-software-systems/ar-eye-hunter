import {
    ControlRetentionPlanLimitError,
    type ControlRetentionCandidate,
    type ControlRetentionPlan
} from '@shared-test/rallar-bb-test/control-retention.ts';

import type { RetentionPlanTokenAdapter } from './retention-plan-token.ts';
import { decodeRetentionCleanupQuery, type RetentionCleanupQuery } from './retention-query.ts';

export interface RetentionCleanupService {
    createRetentionPlan(maxRuns: number | undefined): ControlRetentionPlan;
    applyRetentionPlan(plan: ControlRetentionPlan): readonly string[];
    applyRunRetention(maxRuns: number | undefined): readonly string[];
    readRetainedRunCount(): number;
}

export interface RetentionCleanupInput {
    readonly url: URL;
    readonly maxRuns: number | undefined;
    readonly authorize: () => boolean | Promise<boolean>;
    readonly service: RetentionCleanupService;
    readonly tokens: RetentionPlanTokenAdapter;
    readonly persist: () => void;
}

export interface RetentionCleanupApplied {
    readonly deletedRunIds: readonly string[];
    readonly retainedRuns: number;
    readonly maxRuns: number | undefined;
}

export interface RetentionCleanupPreview extends RetentionCleanupApplied {
    readonly dryRun: true;
    readonly wouldDeleteRuns: readonly ControlRetentionCandidate[];
    readonly wouldDeleteRunIds: readonly string[];
    readonly wouldDeleteDistributedRunIds: readonly string[];
    readonly wouldDeleteFleetReportIds: readonly string[];
    readonly projectedRetainedRuns: number;
    readonly preserves: Readonly<{ connectedAgentSockets: true; storedArtifactFiles: true; }>;
    readonly planToken: string;
}

export interface RetentionCleanupRejection {
    readonly error: string;
}

export interface RetentionCleanupResult {
    readonly status: number;
    readonly body: RetentionCleanupApplied | RetentionCleanupPreview | RetentionCleanupRejection;
}

const UNAUTHORIZED: RetentionCleanupResult = { status: 401, body: { error: 'Admin token is required or invalid.' } };
const STALE_PLAN: RetentionCleanupResult = {
    status: 409,
    body: { error: 'Retention preview is stale, expired, or belongs to another server process.' }
};
const PREVIEW_LIMIT_EXCEEDED: RetentionCleanupResult = {
    status: 413,
    body: { error: 'Retention preview exceeds bounded planning limits.' }
};

export async function applyRetentionCleanup(input: RetentionCleanupInput): Promise<RetentionCleanupResult> {
    if (!(await input.authorize())) {
        return UNAUTHORIZED;
    }
    return await decodeRetentionCleanupQuery(input.url).fold(
        (error) => Promise.resolve<RetentionCleanupResult>({ status: 400, body: { error } }),
        (query) => applyRetentionCleanupQuery(input, query)
    );
}

async function applyRetentionCleanupQuery(
    input: RetentionCleanupInput,
    query: RetentionCleanupQuery
): Promise<RetentionCleanupResult> {
    switch (query.mode) {
        case 'immediate':
            return applyImmediateRetentionCleanup(input);
        case 'preview':
            return await previewRetentionCleanup(input);
        case 'confirm':
            return await confirmRetentionCleanup(input, query.planToken);
    }
}

function applyImmediateRetentionCleanup(input: RetentionCleanupInput): RetentionCleanupResult {
    const deletedRunIds = input.service.applyRunRetention(input.maxRuns);
    input.persist();
    return {
        status: 200,
        body: { deletedRunIds, retainedRuns: input.service.readRetainedRunCount(), maxRuns: input.maxRuns }
    };
}

async function previewRetentionCleanup(input: RetentionCleanupInput): Promise<RetentionCleanupResult> {
    const plan = readBoundedRetentionPlan(input);
    if (!plan) {
        return PREVIEW_LIMIT_EXCEEDED;
    }
    const planToken = await input.tokens.issue(plan.canonicalConsequence);
    return { status: 200, body: toRetentionCleanupPreview(plan, planToken, input.maxRuns) };
}

// The confirmed plan is recomputed, compared, and applied without an await between them, so
// no other request can change the runs after the consequence comparison.
async function confirmRetentionCleanup(
    input: RetentionCleanupInput,
    planToken: string
): Promise<RetentionCleanupResult> {
    const previewedPlan = readBoundedRetentionPlan(input);
    if (!previewedPlan || !(await input.tokens.verify(planToken, previewedPlan.canonicalConsequence))) {
        return STALE_PLAN;
    }
    const currentPlan = readBoundedRetentionPlan(input);
    if (!currentPlan || currentPlan.canonicalConsequence !== previewedPlan.canonicalConsequence) {
        return STALE_PLAN;
    }

    const deletedRunIds = input.service.applyRetentionPlan(currentPlan);
    input.persist();
    return {
        status: 200,
        body: { deletedRunIds, retainedRuns: currentPlan.projectedRetainedRuns, maxRuns: input.maxRuns }
    };
}

function readBoundedRetentionPlan(input: RetentionCleanupInput): ControlRetentionPlan | undefined {
    try {
        return input.service.createRetentionPlan(input.maxRuns);
    }
    catch (error) {
        if (error instanceof ControlRetentionPlanLimitError) {
            return undefined;
        }
        throw error;
    }
}

function toRetentionCleanupPreview(
    plan: ControlRetentionPlan,
    planToken: string,
    maxRuns: number | undefined
): RetentionCleanupPreview {
    return {
        deletedRunIds: [],
        retainedRuns: plan.currentRuns,
        maxRuns,
        dryRun: true,
        wouldDeleteRuns: plan.candidates,
        wouldDeleteRunIds: plan.deletedRunIds,
        wouldDeleteDistributedRunIds: plan.distributedRunIds,
        wouldDeleteFleetReportIds: plan.fleetReportIds,
        projectedRetainedRuns: plan.projectedRetainedRuns,
        preserves: {
            connectedAgentSockets: true,
            storedArtifactFiles: true
        },
        planToken
    };
}
