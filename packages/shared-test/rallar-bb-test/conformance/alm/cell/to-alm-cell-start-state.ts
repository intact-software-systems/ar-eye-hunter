import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { toAlmConformancePrincipalRole } from '../alm-conformance-roles.ts';
import type {
    AlmConformanceStartGrant,
    AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';
import { toTopicGrantCommand } from '../grant/to-topic-grant-command.ts';

/** Set on each command of a cell's start state, which a recipe's reader tells from the cell's own grant changes by it. */
export const ALM_CELL_START_STATE_METADATA = { cellStartState: 'declared-grants' } as const;

/**
 * The permissions the room owner writes for a cell whose topic is granted, so the cell starts from its declared state
 * whatever an earlier cell granted: for each principal, a revoke of every permission it does not hold, then a grant of
 * every one it holds. A grant only adds and a revoke only removes (D492), and either is a no-op where the principal
 * already is in the state, so the sequence reaches the declared state from any state in at most two revisions per
 * principal. A grant that leaves `subscribe` held keeps the principal's rows, whose connection generations an earlier
 * cell's pages no longer hold, and admission honours only a row of a live generation. Only the receiver owns the room,
 * so every other role, and a cell without a granted topic, writes nothing.
 */
export function toAlmCellStartState(step: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    if (step.role !== 'receiver' || step.startGrants === undefined) {
        return [];
    }
    assertStartGrantsNameEveryPrincipal(step, step.startGrants);
    return step.startGrants.flatMap((grant) => toPrincipalStartCommands(step, grant)).map(toStartStateCommand);
}

function toPrincipalStartCommands(
    step: AlmConformanceStepInput,
    grant: AlmConformanceStartGrant
): readonly RallarBlackBoxTestCommand[] {
    const { grantee, publish, subscribe } = grant;
    return [
        ...(publish && subscribe
            ? []
            : [toTopicGrantCommand({ step, operation: 'revoke', grantee, publish: !publish, subscribe: !subscribe })]),
        ...(publish || subscribe
            ? [toTopicGrantCommand({ step, operation: 'grant', grantee, publish, subscribe })]
            : [])
    ];
}

function toStartStateCommand(command: RallarBlackBoxTestCommand): RallarBlackBoxTestCommand {
    return { ...command, metadata: { ...command.metadata, ...ALM_CELL_START_STATE_METADATA } };
}

/** A start state that leaves a principal of the cell unnamed would leave its permissions to an earlier cell. */
function assertStartGrantsNameEveryPrincipal(
    step: AlmConformanceStepInput,
    startGrants: readonly AlmConformanceStartGrant[]
): void {
    const named = startGrants.map(({ grantee }) => grantee).toSorted();
    const required = [...new Set(step.roles.map(toAlmConformancePrincipalRole))].toSorted();
    if (named.join() !== required.join()) {
        throw new Error(
            `${step.scenarioKey} declares start grants for [${named.join()}], not once for each principal of its roles: ` +
                `[${required.join()}].`
        );
    }
}
