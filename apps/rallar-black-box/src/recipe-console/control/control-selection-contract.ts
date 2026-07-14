import type { RallarBlackBoxDistributedGroupRef } from
    '@shared-test/rallar-bb-test/distributed-run.ts';
import type {
    ControlAgentSnapshot,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
} from '../../control-run-manager.ts';
import type {
    ControlAgentBoardRow,
    ControlAgentBoardSummary,
} from '../../control-agent-board.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';

export type RecipeConsoleControlSelectionIssue = Readonly<{
    field: 'controlRunId' | 'distributedRunId' | 'agentId' | 'distributedRuns';
    code: 'unavailable' | 'ambiguous' | 'incompatible';
    message: string;
    value?: string;
}>;

export type RecipeConsoleActiveRunContext = Readonly<{
    kind: 'none' | 'sole' | 'ambiguous';
    runs: readonly ControlDistributedRunSnapshot[];
}>;

export type RecipeConsoleControlGroupContext = Readonly<{
    source: 'selected-distributed-run' | 'sole-active-distributed-run' | 'bootstrap';
    group: RallarBlackBoxDistributedGroupRef;
}>;

export type RecipeConsoleControlSelection = Readonly<{
    controlRunId?: string;
    controlRun?: ControlRunSnapshot;
    controlRunSource?: 'url' | 'bootstrap' | 'sole-run';
    distributedRunId?: string;
    distributedRun?: ControlDistributedRunSnapshot;
    agentId?: string;
    agent?: ControlAgentSnapshot;
    issues: readonly RecipeConsoleControlSelectionIssue[];
    urlReplacePatch?: Partial<RecipeConsoleUrlState>;
    activeRunContext: RecipeConsoleActiveRunContext;
    groupContext: RecipeConsoleControlGroupContext;
    boardRows: readonly ControlAgentBoardRow[];
    boardSummary: ControlAgentBoardSummary;
    safeTargetableCount: number;
    lastKnownTargetableCount: number;
}>;
