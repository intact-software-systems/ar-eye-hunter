import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { findMutationBoundaryViolationsFromRoots } from './mutation-boundary-analysis.ts';
import { MUTATION_ROUTE_INVENTORY, validateMutationRouteInventory } from './mutation-routing-inventory.ts';

// Retain permanently as cross-domain semantic route-provenance evidence.
const CAPABILITY_FIXTURES = 'packages/tests/shared-server/fixtures/mutation-boundary-capability-receivers';

it('follows mutable capability provenance through production receiver shapes', () => {
    for (
        const name of [
            'parameter.ts',
            'bracket.ts',
            'constructor.ts',
            'declared-property.ts',
            'destructured.ts'
        ]
    ) {
        const root = `${CAPABILITY_FIXTURES}/${name}`;
        expect(findMutationBoundaryViolationsFromRoots([root]), root).toEqual([
            expect.objectContaining({
                filePath: root,
                directMutatorCalls: ['ClientStateRepository.insertPrincipal']
            })
        ]);
    }
    expect(findMutationBoundaryViolationsFromRoots([`${CAPABILITY_FIXTURES}/read-only.ts`])).toEqual(
        []
    );
});

it('rejects a dead correct type after an HTTP handler is given the wrong handoff type', () => {
    const item = requireEntry(AppInboxType.CLIENT_PRINCIPAL_UPSERT, 'HTTP');
    const source = readFileSync(item.sourcePath, 'utf8');
    const mutated = source
        .replace(
            'type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,',
            'type: AppInboxType.CLIENT_INSTANCE_UPSERT,'
        )
        .replace(
            'const request = withActor(requestBody, authSession);',
            `const request = withActor(requestBody, authSession);
        const deadCorrectType = (): void => {
          void AppInboxType.CLIENT_PRINCIPAL_UPSERT;
          void deps.processClientAppInbox;
        };
        void deadCorrectType;`
        );

    expect(validateWithOverride(item.sourcePath, mutated)).toEqual(
        expect.arrayContaining([expect.stringContaining('registered handler is not connected')])
    );
});

it('rejects a rerouted websocket callback even when dead markers remain', () => {
    const item = requireEntry(AppInboxType.RTC_RTT_SUBMIT, 'WS_INBOX');
    const source = readFileSync(item.sourcePath, 'utf8');
    const mutated = source.replace('await options.enqueueRtcRttMutation({', 'await Promise.resolve({') +
        `
function deadWsHandoff(enqueueRtcRttMutation: (...args: never[]) => unknown): void {
  void enqueueRtcRttMutation;
  void AppInboxType.RTC_RTT_SUBMIT;
}
`;
    expect(mutated).not.toBe(source);

    expect(validateWithOverride(item.sourcePath, mutated)).toEqual(
        expect.arrayContaining([expect.stringContaining('registered handler is not connected')])
    );
});

it('rejects a lifecycle type dispatched to the wrong owner with a dead correct call', () => {
    const item = requireEntry(AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT, 'WS_LIFECYCLE');
    const source = readFileSync(item.dispatchSourcePath, 'utf8');
    const live = 'await this.handler.processAuthorisedWsDisconnect(input, context)';
    const mutated = source.replace(live, 'await this.handler.processAuthorisedWsConnect(input, context)') +
        `
class DeadLifecycleOwner {
  process(): void { void this.handler.processAuthorisedWsDisconnect; }
  private readonly handler = { processAuthorisedWsDisconnect(): void {} };
}
`;
    expect(source).toContain(live);

    expect(validateWithOverride(item.dispatchSourcePath, mutated)).toEqual(
        expect.arrayContaining([expect.stringContaining('owner dispatch is not connected')])
    );
});

it('rejects a cross-file admin handoff with the wrong type and dead correct evidence', () => {
    const item = MUTATION_ROUTE_INVENTORY.find((entry) => entry.entrypoint.includes('/topology/recompute'));
    if (!item) {
        throw new Error('Admin topology route is absent');
    }
    const source = readFileSync(item.enqueueSourcePath, 'utf8');
    const mutated = source.replace(
        'processAuthenticatedHttpEntryUntilCompletionResult(',
        'processAuthenticatedEntryUntilCompletionResult('
    ) +
        '\nfunction deadAdminType(): void { ' +
        'void AppInboxType.TOPOLOGY_RECONFIGURE; ' +
        'void processAuthenticatedHttpEntryUntilCompletionResult; }\n';
    expect(mutated).not.toBe(source);

    expect(validateWithOverride(item.enqueueSourcePath, mutated)).toEqual(
        expect.arrayContaining([expect.stringContaining('registered handler is not connected')])
    );
});

it('rejects a cross-file auth handoff discriminator and owner reroute', () => {
    const item = requireEntry(AppInboxType.AUTH_USER_REGISTER, 'HTTP');
    const typeOwnerSource = readFileSync(item.typeOwnerSourcePath, 'utf8');
    const dispatchSource = readFileSync(item.dispatchSourcePath, 'utf8');
    const wrongType = typeOwnerSource.replace('kind: \'register-user\',', 'kind: \'issue-session\',') +
        '\nfunction deadAuthType(): void { void \'register-user\'; }\n';
    const wrongOwner = dispatchSource.replace(
        'await this.authInboxHandler.processAuthMutation(command, context)',
        'await Promise.resolve(command)'
    ) +
        '\nclass DeadAuthOwner { process(): void { void this.authInboxHandler.processAuthMutation; } private readonly authInboxHandler = { processAuthMutation(): void {} }; }\n';
    expect(typeOwnerSource).toContain('kind: \'register-user\',');
    expect(dispatchSource).toContain(
        'await this.authInboxHandler.processAuthMutation(command, context)'
    );

    expect(validateWithOverride(item.typeOwnerSourcePath, wrongType)).toEqual(
        expect.arrayContaining([expect.stringContaining('registered handler is not connected')])
    );
    expect(validateWithOverride(item.dispatchSourcePath, wrongOwner)).toEqual(
        expect.arrayContaining([expect.stringContaining('owner dispatch is not connected')])
    );
});

it('rejects a websocket auth handoff moved to an unreachable helper', () => {
    const item = requireEntry(AppInboxType.AUTH_WS_TICKET_CONSUME, 'HTTP');
    const source = readFileSync(item.sourcePath, 'utf8');
    const live = 'const authSession = await input.requireWsAuthSession({ sessionId, ticket });';
    const mutated = source.replace(live, 'const authSession = await Promise.resolve({ sessionId });') +
        `
async function deadWsAuthHandoff(input: RegisterWsRoutesInput): Promise<void> {
  await input.requireWsAuthSession({ sessionId: 'dead' });
}
`;
    expect(source).toContain(live);

    expect(validateWithOverride(item.sourcePath, mutated)).toEqual(
        expect.arrayContaining([expect.stringContaining('registered handler is not connected')])
    );
});

function requireEntry(type: AppInboxType, transport: string) {
    const item = MUTATION_ROUTE_INVENTORY.find(
        (entry) => entry.type === type && entry.transport === transport
    );
    if (!item) {
        throw new Error(`${transport}:${type} route is absent`);
    }
    return item;
}

function validateWithOverride(filePath: string, source: string): readonly string[] {
    return validateMutationRouteInventory(MUTATION_ROUTE_INVENTORY, {
        sourceOverrides: new Map([[filePath, source]])
    });
}
