import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { toAlmConformancePrincipalRole } from '../alm-conformance-roles.ts';
import type { AlmConformanceStartGrant, AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import { toTopicGrantCommand } from './to-topic-grant-command.ts';

/** Set on each command of a cell's start state, which a recipe's reader tells from the cell's own grant changes by it. */
export const ALM_CELL_START_STATE_METADATA = { cellStartState: 'declared-grants' } as const;

/**
 * The permissions the room owner writes for a cell whose topic is granted, so the cell starts from its declared state
 * whatever an earlier cell left. Only the receiver owns the room, so every other role, and a cell without a granted
 * topic, writes nothing.
 */
export function toAlmCellStartState(step: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const { startGrants } = step.messages;
    if (step.role !== 'receiver' || startGrants === undefined) {
        return [];
    }
    assertStartGrantsNameEveryPrincipal(step, startGrants);
    return startGrants.flatMap((grant) => toAlmCellPrincipalStartCommands(step, grant)).map(toStartStateCommand);
}

/**
 * One principal's way to its declared state from any state, rows included: a revoke of `subscribe` with every
 * permission it must not hold, then a grant of what it holds. A grant adds and a revoke removes (D492), and the writer
 * deletes every subscription row of the principal on a revoke of `subscribe` while it is held, so afterwards the
 * principal holds its declared permissions and no row, even one an earlier cell's election left on a page's live
 * connection generation, which admission would still honour; an election is then always a step of the cell's own body.
 * An unchanged write is a no-op, so a principal already in the state costs no revision.
 */
export function toAlmCellPrincipalStartCommands(
    step: AlmConformanceStepInput,
    grant: AlmConformanceStartGrant
): readonly RallarBlackBoxTestCommand[] {
    const { grantee, publish, subscribe } = grant;
    return [
        toTopicGrantCommand({
            step,
            scope: 'start-state',
            operation: 'revoke',
            grantee,
            publish: !publish,
            subscribe: true
        }),
        ...(publish || subscribe
            ? [toTopicGrantCommand({ step, scope: 'start-state', operation: 'grant', grantee, publish, subscribe })]
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
