import {
    describe,
    expect,
    it
} from 'vitest';

import {
    ALM_CONFORMANCE_CARRIERS,
    type AlmConformanceCarrier
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import type { AlmConformanceRole } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts';
import {
    createAlmConformanceRecipes,
    toAlmConformanceRoleRecipe,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { ALM_CELL_START_STATE_METADATA } from '@shared-test/rallar-bb-test/conformance/alm/granted-topic/to-alm-cell-start-state.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestHttpRequestCommand
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { CONFORMANCE_PRINCIPAL_IDS, toConformanceInput } from './alm-conformance-test-input.ts';
import { toNestedCommands } from './to-nested-commands.ts';

export interface Permissions {
    readonly publish: boolean;
    readonly subscribe: boolean;
}

export interface GrantRequest {
    readonly operation: 'grant' | 'revoke';
    readonly principalId: string;
    readonly topicId: string;
    readonly permissions: Permissions;
}

/** The roles whose principal a start state names: a role sharing the sender's principal is named by the sender. */
type GranteeRole = 'receiver' | 'sender' | 'recipient-b' | 'publisher-b';

export type DeclaredState = Readonly<Partial<Record<GranteeRole, Permissions>>>;

export type StartStateTable = Readonly<Record<string, DeclaredState>>;

const NONE: Permissions = { publish: false, subscribe: false };
const SUBSCRIBE: Permissions = { publish: false, subscribe: true };
const PUBLISH: Permissions = { publish: true, subscribe: false };
const BOTH: Permissions = { publish: true, subscribe: true };

export const PERMISSIONS = { NONE, SUBSCRIBE, PUBLISH, BOTH } as const;

const GRANTEE_ROLES: readonly GranteeRole[] = ['receiver', 'sender', 'recipient-b', 'publisher-b'];

/** What the server holds of one principal: its permissions and whether a subscription row of a live generation exists. */
interface Held extends Permissions {
    readonly row: boolean;
}

/** Every state an earlier cell can leave: a row exists only while `subscribe` is held, and a red cell leaves it behind. */
const STATES: readonly Held[] = [
    { ...NONE, row: false },
    { ...SUBSCRIBE, row: false },
    { ...SUBSCRIBE, row: true },
    { ...PUBLISH, row: false },
    { ...BOTH, row: false },
    { ...BOTH, row: true }
];

export function isStartStateCommand(command: RallarBlackBoxTestCommand): boolean {
    return command.metadata?.cellStartState === ALM_CELL_START_STATE_METADATA.cellStartState;
}

export function toGrantRequests(commands: readonly RallarBlackBoxTestCommand[]): readonly GrantRequest[] {
    return toNestedCommands(commands).flatMap((command): readonly GrantRequest[] => {
        const request = command.kind === 'http.request' ? (command as RallarBlackBoxTestHttpRequestCommand).request : undefined;
        const match = request?.path?.match(/\/publication-grants\/([^/]+)\/(grant|revoke)\/requests\//);
        const body = request?.body as (Permissions & Readonly<{ topicId: string; }>) | undefined;
        return match === null || match === undefined || body === undefined
            ? []
            : [{
                operation: match[2] as GrantRequest['operation'],
                principalId: match[1]!,
                topicId: body.topicId,
                permissions: { publish: body.publish, subscribe: body.subscribe }
            }];
    });
}

/**
 * D492 and the writer: a grant adds and a revoke removes the named permissions, an unchanged result writes nothing, and a
 * write that does not keep `subscribe` held across it deletes the principal's rows.
 */
export function toStateAfter(initial: Held, requests: readonly GrantRequest[]): Held {
    return requests.reduce<Held>((held, { operation, permissions }) => {
        const next = operation === 'grant'
            ? { publish: held.publish || permissions.publish, subscribe: held.subscribe || permissions.subscribe }
            : { publish: held.publish && !permissions.publish, subscribe: held.subscribe && !permissions.subscribe };
        const unchanged = next.publish === held.publish && next.subscribe === held.subscribe;
        return unchanged ? held : { ...next, row: held.row && held.subscribe && next.subscribe };
    }, initial);
}

export function toRecipeCommands(scenario: AlmConformanceScenario, role: AlmConformanceRole): readonly RallarBlackBoxTestCommand[] {
    return toAlmConformanceRoleRecipe(scenario, role)?.commands ?? [];
}

/** Every principal of the cell, once: a sibling or successor is named by the sender's principal. */
function toCellPrincipalIds(scenario: AlmConformanceScenario): readonly string[] {
    return [...new Set(scenario.roles.map((role) => CONFORMANCE_PRINCIPAL_IDS[role]!))].toSorted();
}

function isGrantedCell(scenario: AlmConformanceScenario): boolean {
    const connect = toRecipeCommands(scenario, 'receiver').find((command) => command.kind === 'rtc.connect');
    return connect?.kind === 'rtc.connect' && (JSON.stringify(connect.rallar?.messageSelector) ?? '').includes('"access":"granted"');
}

function toDeclaredPermissions(declared: DeclaredState, principalId: string): Permissions {
    const role = GRANTEE_ROLES.find((candidate) => CONFORMANCE_PRINCIPAL_IDS[candidate] === principalId && declared[candidate] !== undefined);
    return role === undefined ? NONE : declared[role]!;
}

function toPlannedGrantedCells(
    prefix: string,
    carrier: AlmConformanceCarrier,
    cellSettle: 'barriered' | undefined
): readonly AlmConformanceScenario[] {
    return createAlmConformanceRecipes({ ...toConformanceInput(carrier), ...(cellSettle === undefined ? {} : { cellSettle }) })
        .filter((scenario) => scenario.scenarioId.startsWith(prefix) && isGrantedCell(scenario));
}

function toStartRequests(scenario: AlmConformanceScenario, role: AlmConformanceRole): readonly GrantRequest[] {
    return toGrantRequests(toRecipeCommands(scenario, role).filter(isStartStateCommand));
}

/** The pins of a declared start state, over every granted cell whose id starts with `prefix`. */
export function describeDeclaredStartStates(prefix: string, table: StartStateTable): void {
    describe(`the start state of the ${prefix} cells`, () => {
        it('every cell on the granted topic declares every role\'s start permissions', () => {
            const planned = new Set<string>();
            for (const carrier of ALM_CONFORMANCE_CARRIERS) {
                for (const scenario of toPlannedGrantedCells(prefix, carrier, undefined)) {
                    planned.add(scenario.scenarioKey);
                    const declared = table[scenario.scenarioKey];
                    expect(declared, `${carrier} ${scenario.scenarioKey} is in the table`).toBeDefined();
                    const requests = toStartRequests(scenario, 'receiver');

                    expect([...new Set(requests.map(({ principalId }) => principalId))].toSorted(), `${carrier} ${scenario.scenarioKey}`)
                        .toEqual(toCellPrincipalIds(scenario));
                    for (const principalId of toCellPrincipalIds(scenario)) {
                        expect(
                            toStateAfter({ ...NONE, row: false }, requests.filter((request) => request.principalId === principalId)),
                            `${carrier} ${scenario.scenarioKey} ${principalId}`
                        ).toEqual({ ...toDeclaredPermissions(declared!, principalId), row: false });
                    }
                }
            }
            expect([...planned].toSorted()).toEqual(Object.keys(table).toSorted());
        });

        it('its receiver writes exactly that state after the connected barrier and before the formation poll, whatever ran before', () => {
            for (const carrier of ALM_CONFORMANCE_CARRIERS) {
                for (const scenario of toPlannedGrantedCells(prefix, carrier, 'barriered')) {
                    const label = `${carrier} ${scenario.scenarioKey}`;
                    const receiver = toRecipeCommands(scenario, 'receiver');
                    const ids = receiver.map(({ commandId }) => commandId ?? '');
                    const connected = ids.findIndex((id) => id.endsWith('-receiver-connected'));
                    const formationPoll = ids.findIndex((id) => id.endsWith('-receiver-formation-poll'));
                    const written = receiver.flatMap((command, index) => isStartStateCommand(command) ? [index] : []);

                    expect(written.length, label).toBeGreaterThan(0);
                    expect(written, label).toEqual(Array.from({ length: written.length }, (_, offset) => connected + 1 + offset));
                    expect(written.at(-1)! + 1, label).toBe(formationPoll);
                    for (const role of scenario.roles.filter((candidate) => candidate !== 'receiver')) {
                        expect(toStartRequests(scenario, role), `${label} ${role}`).toEqual([]);
                    }
                    const requests = toStartRequests(scenario, 'receiver');
                    for (const principalId of toCellPrincipalIds(scenario)) {
                        for (const initial of STATES) {
                            expect(
                                toStateAfter(initial, requests.filter((request) => request.principalId === principalId)),
                                `${label} ${principalId} from ${JSON.stringify(initial)}`
                            ).toEqual({ ...toDeclaredPermissions(table[scenario.scenarioKey]!, principalId), row: false });
                        }
                    }
                }
            }
        });

        it('a cell without a settle writes it at the head of its receiver\'s body, after its cue subscription', () => {
            for (const carrier of ALM_CONFORMANCE_CARRIERS) {
                for (const scenario of toPlannedGrantedCells(prefix, carrier, undefined)) {
                    const { prologue } = scenario.partsByRole.receiver!;
                    const body = toRecipeCommands(scenario, 'receiver').slice(prologue.length);
                    const written = body.flatMap((command, index) => isStartStateCommand(command) ? [index] : []);
                    const leading = body.findIndex((command) => command.metadata?.cellArming !== 'cue-subscription' && command.kind !== 'fault.inject');

                    expect(written.length, `${carrier} ${scenario.scenarioKey}`).toBeGreaterThan(0);
                    expect(written, `${carrier} ${scenario.scenarioKey}`)
                        .toEqual(Array.from({ length: written.length }, (_, offset) => leading + offset));
                }
            }
        });

        it('every start state revokes subscribe before it grants it', () => {
            for (const carrier of ALM_CONFORMANCE_CARRIERS) {
                for (const scenario of toPlannedGrantedCells(prefix, carrier, undefined)) {
                    const requests = toStartRequests(scenario, 'receiver');
                    for (const principalId of toCellPrincipalIds(scenario)) {
                        const own = requests.filter((request) => request.principalId === principalId);
                        const label = `${carrier} ${scenario.scenarioKey} ${principalId}`;
                        const revoke = own.findIndex(({ operation, permissions }) => operation === 'revoke' && permissions.subscribe);
                        const grant = own.findIndex(({ operation }) => operation === 'grant');

                        expect(revoke, label).toBeGreaterThanOrEqual(0);
                        expect(grant < 0 || revoke < grant, label).toBe(true);
                    }
                }
            }
        });

        it('a barriered and a plain cell write the same grants, the barriered cell as one request each', () => {
            for (const carrier of ALM_CONFORMANCE_CARRIERS) {
                const barriered = toPlannedGrantedCells(prefix, carrier, 'barriered');
                for (const [index, scenario] of toPlannedGrantedCells(prefix, carrier, undefined).entries()) {
                    const label = `${carrier} ${scenario.scenarioKey}`;
                    const written = toRecipeCommands(barriered[index]!, 'receiver').filter(isStartStateCommand);

                    expect(toStartRequests(barriered[index]!, 'receiver'), label).toEqual(toStartRequests(scenario, 'receiver'));
                    expect(written.map(({ kind }) => kind), label).toEqual(written.map(() => 'http.request'));
                    expect(toRecipeCommands(scenario, 'receiver').filter(isStartStateCommand).map(({ kind }) => kind), label)
                        .toEqual(written.map(() => 'loop'));
                }
            }
        });

        it('no granted cell revokes a permission its own start state did not grant', () => {
            for (const carrier of ALM_CONFORMANCE_CARRIERS) {
                for (const scenario of toPlannedGrantedCells(prefix, carrier, undefined)) {
                    const declared = table[scenario.scenarioKey]!;
                    const bodyRevokes = scenario.roles.flatMap((role) =>
                        toGrantRequests(toRecipeCommands(scenario, role).filter((command) => !isStartStateCommand(command)))
                            .filter(({ operation }) => operation === 'revoke')
                    );
                    for (const { principalId, permissions } of bodyRevokes) {
                        const held = toDeclaredPermissions(declared, principalId);
                        expect(
                            { publish: permissions.publish && !held.publish, subscribe: permissions.subscribe && !held.subscribe },
                            `${carrier} ${scenario.scenarioKey} revokes ${JSON.stringify(permissions)} of ${principalId}`
                        ).toEqual(NONE);
                    }
                }
            }
        });
    });
}
