import {
  type ControlRetentionPlan,
  ControlRetentionPlanLimitError,
} from '@shared-test/rallar-bb-test/control-retention.ts';
import type { RetentionPlanTokenAdapter } from './retention-plan-token.ts';
import { parseRetentionCleanupQuery } from './retention-query.ts';

export type RetentionCleanupService = Readonly<{
  createRetentionPlan(maxRuns: number | undefined): ControlRetentionPlan;
  applyRetentionPlan(plan: ControlRetentionPlan): readonly string[];
  pruneRuns(maxRuns: number | undefined): readonly string[];
  legacyRetainedRuns(): number;
}>;

export type RetentionCleanupResult = Readonly<{
  status: number;
  body: unknown;
}>;

export type RetentionCleanupInput = Readonly<{
  url: URL;
  maxRuns: number | undefined;
  authorize(): boolean | Promise<boolean>;
  service: RetentionCleanupService;
  tokens: RetentionPlanTokenAdapter;
  persist(): void;
}>;

export async function handleRetentionCleanup(
  input: RetentionCleanupInput,
): Promise<RetentionCleanupResult> {
  if (!(await input.authorize())) {
    return result(401, { error: 'Admin token is required or invalid.' });
  }
  const query = parseRetentionCleanupQuery(input.url);
  if (query.mode === 'invalid') {
    return result(400, { error: query.error });
  }
  if (query.mode === 'legacy') {
    const deletedRunIds = input.service.pruneRuns(input.maxRuns);
    input.persist();
    return result(200, {
      deletedRunIds,
      retainedRuns: input.service.legacyRetainedRuns(),
      maxRuns: input.maxRuns,
    });
  }

  const firstPlan = boundedPlan(input, query.mode);
  if ('status' in firstPlan) {
    return firstPlan;
  }
  if (query.mode === 'preview') {
    const planToken = await input.tokens.issue(firstPlan.canonicalConsequence);
    return result(200, previewBody(firstPlan, planToken, input.maxRuns));
  }
  if (!(await input.tokens.verify(query.planToken, firstPlan.canonicalConsequence))) {
    return conflict();
  }
  const finalPlan = boundedPlan(input, 'confirm');
  if ('status' in finalPlan || finalPlan.canonicalConsequence !== firstPlan.canonicalConsequence) {
    return conflict();
  }
  const deletedRunIds = input.service.applyRetentionPlan(finalPlan);
  input.persist();
  return result(200, {
    deletedRunIds,
    retainedRuns: finalPlan.projectedRetainedRuns,
    maxRuns: input.maxRuns,
  });
}

function boundedPlan(
  input: RetentionCleanupInput,
  mode: 'preview' | 'confirm',
): ControlRetentionPlan | RetentionCleanupResult {
  try {
    return input.service.createRetentionPlan(input.maxRuns);
  } catch (error) {
    if (error instanceof ControlRetentionPlanLimitError) {
      return mode === 'preview'
        ? result(413, { error: 'Retention preview exceeds bounded planning limits.' })
        : conflict();
    }
    throw error;
  }
}

function previewBody(
  plan: ControlRetentionPlan,
  planToken: string,
  maxRuns: number | undefined,
): unknown {
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
      storedArtifactFiles: true,
    },
    planToken,
  };
}

function conflict(): RetentionCleanupResult {
  return result(409, {
    error: 'Retention preview is stale, expired, or belongs to another server process.',
  });
}

function result(status: number, body: unknown): RetentionCleanupResult {
  return { status, body };
}
