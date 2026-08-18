import { describe, expect, it } from 'vitest';
import {
    ADVANCED_SURFACE_CATALOG,
    resolveAdvancedSurface,
    resolveAdvancedSurfaceFromLegacySearch,
} from '../../../apps/rallar-black-box/src/recipe-console/advanced/advanced-surface-catalog.ts';
import {
    ADVANCED_DIAGNOSTIC_CONTEXT_MAX_BYTES,
    ADVANCED_DIAGNOSTIC_QUERY_MAX_BYTES,
    createAdvancedLegacyHref,
    createAdvancedRecipeConsoleReturnHref,
} from '../../../apps/rallar-black-box/src/recipe-console/advanced/advanced-legacy-href.ts';
import type {
    RecipeConsoleUrlState,
} from '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';
import {
    buildLegacyDiagnosticReturnHref,
    parseLegacyDiagnosticContext,
} from '../../../apps/rallar-black-box/src/legacy/diagnostics/context/legacy-diagnostic-context.ts';
import {
    DIAGNOSTIC_BRIDGE_LEGACY_SURFACE_IDS,
} from '../../../apps/rallar-black-box/src/app/diagnostic-bridge-url-contract.ts';

const EXPECTED_SURFACES = {
    'direct.quick-test': direct('rallar', 'quick-test'),
    'direct.auth': direct('rallar', 'auth'),
    'direct.groups-clients': direct('rallar', 'rooms-clients'),
    'direct.websocket': direct('rallar', 'websocket'),
    'direct.rtc-realtimes': direct('rallar', 'rtc-realtime'),
    'direct.topology': direct('rallar', 'topology'),
    'direct.rtc-diagnostics': direct('rallar', 'rtc-diagnostics'),
    'direct.rallar-data': direct('rallar', 'rallar-data'),
    'direct.crdt': direct('rallar', 'crdt-health'),
    'direct.media': direct('rallar', 'media'),
    'direct.rallar-server': direct('rallar', 'rallar-server'),
    'direct.rallar-trace': direct('rallar', 'rallar-trace'),
    'diagnostic.event-stream': direct('black-box-runner', 'event-stream'),
    'runner.recipes': advancedLegacy('recipes'),
    'runner.runs': advancedLegacy('runs'),
    'runner.fleet': advancedLegacy('fleet'),
    'runner.builder': advancedLegacy('builder'),
    'legacy.manual-rallar': advancedChild('manual'),
    'legacy.local-workbench': advancedChild('workbench'),
    'legacy.run-manager': advancedChild('run-manager'),
    'legacy.distributed-recipes': advancedChild('distributed'),
    'legacy.shared-test-catalog': advancedChild('shared-test'),
} as const;

const EXPECTED_ALIASES: Readonly<Record<string, keyof typeof EXPECTED_SURFACES>> = {
    quick: 'direct.quick-test',
    smoke: 'direct.quick-test',
    rallar: 'direct.quick-test',
    login: 'direct.auth',
    session: 'direct.auth',
    rooms: 'direct.groups-clients',
    groups: 'direct.groups-clients',
    clients: 'direct.groups-clients',
    people: 'direct.groups-clients',
    presence: 'direct.groups-clients',
    ws: 'direct.websocket',
    socket: 'direct.websocket',
    websockets: 'direct.websocket',
    realtime: 'direct.rtc-realtimes',
    rtcrealtime: 'direct.rtc-realtimes',
    rtc: 'direct.rtc-diagnostics',
    diagnostics: 'direct.rtc-diagnostics',
    data: 'direct.rallar-data',
    storage: 'direct.rallar-data',
    crdt: 'direct.crdt',
    collaboration: 'direct.crdt',
    server: 'direct.rallar-server',
    trace: 'direct.rallar-trace',
    rallartrace: 'direct.rallar-trace',
    events: 'diagnostic.event-stream',
    event: 'diagnostic.event-stream',
    catalog: 'runner.recipes',
    'fleet-report': 'runner.fleet',
    'fleet-reports': 'runner.fleet',
    flow: 'runner.builder',
    flows: 'runner.builder',
    'flow-builder': 'runner.builder',
    manual: 'legacy.manual-rallar',
    'manual-rallar': 'legacy.manual-rallar',
    workbench: 'legacy.local-workbench',
    local: 'legacy.local-workbench',
    'local-workbench': 'legacy.local-workbench',
    manager: 'legacy.run-manager',
    control: 'legacy.run-manager',
    orchestrator: 'legacy.run-manager',
    distributed: 'legacy.distributed-recipes',
    'distributed-runs': 'legacy.distributed-recipes',
    dist: 'legacy.distributed-recipes',
    'distributed-recipes': 'legacy.distributed-recipes',
    artifacts: 'legacy.shared-test-catalog',
    shared: 'legacy.shared-test-catalog',
    'shared-test-runner': 'legacy.shared-test-catalog',
    'shared-test': 'legacy.shared-test-catalog',
};

const MONITOR_STATE: RecipeConsoleUrlState = {
    v: 1,
    experience: 'recipe-console',
    view: 'monitor',
    controlRunId: ' control/run ',
    distributedRunId: 'distributed run',
    agentId: 'agent-a',
    recipeId: 'recipe-a',
    commandId: 'command-a',
    transport: 'rtc',
};

describe('Recipe Console Advanced surface catalog', () => {
    it('enumerates every actionable direct and Advanced Legacy leaf exactly once', () => {
        expect(ADVANCED_SURFACE_CATALOG).toHaveLength(22);
        expect(new Set(ADVANCED_SURFACE_CATALOG.map(surface => surface.id)).size)
            .toBe(22);
        expect(ADVANCED_SURFACE_CATALOG.map(surface => surface.id))
            .toEqual(DIAGNOSTIC_BRIDGE_LEGACY_SURFACE_IDS);
        expect(Object.fromEntries(ADVANCED_SURFACE_CATALOG.map(surface => [
            surface.id,
            {
                kind: surface.kind,
                workspace: surface.route.workspace,
                tab: surface.route.tab,
                ...('advancedSurface' in surface.route
                    ? { advancedSurface: surface.route.advancedSurface }
                    : {}),
            },
        ]))).toEqual(EXPECTED_SURFACES);
        expect(ADVANCED_SURFACE_CATALOG.every(surface =>
            surface.label.trim().length > 0 && surface.aliases.length > 0
        )).toBe(true);
    });

    it('preserves every current app-tab and Advanced child alias', () => {
        for (const surface of ADVANCED_SURFACE_CATALOG) {
            expect(resolveAdvancedSurface(surface.id)?.id).toBe(surface.id);
            const canonicalLeaf = 'advancedSurface' in surface.route
                ? surface.route.advancedSurface
                : surface.route.tab;
            expect(resolveAdvancedSurface(canonicalLeaf)?.id).toBe(surface.id);
        }
        for (const [alias, id] of Object.entries(EXPECTED_ALIASES)) {
            expect(resolveAdvancedSurface(` ${alias.toUpperCase()} `)?.id).toBe(id);
        }
        expect(resolveAdvancedSurface('advanced')).toBeUndefined();
        expect(resolveAdvancedSurface('debug')).toBeUndefined();
        expect(resolveAdvancedSurface('unknown-surface')).toBeUndefined();
    });

    it('resolves old workspace tab advancedSurface and legacySurface deep links', () => {
        expect(resolveAdvancedSurfaceFromLegacySearch(
            '?workspace=direct&tab=diagnostics',
        )?.id).toBe('direct.rtc-diagnostics');
        expect(resolveAdvancedSurfaceFromLegacySearch(
            '?appMode=blackbox&tab=debug&advanced=distributed',
        )?.id).toBe('legacy.distributed-recipes');
        expect(resolveAdvancedSurfaceFromLegacySearch(
            '?workspace=runner&tab=manual-rallar',
        )?.id).toBe('legacy.manual-rallar');
        expect(resolveAdvancedSurfaceFromLegacySearch(
            '?workspace=rallar&tab=event',
        )?.id).toBe('diagnostic.event-stream');
        expect(resolveAdvancedSurfaceFromLegacySearch(
            '?legacySurface=rtc-diagnostics',
        )?.id).toBe('direct.rtc-diagnostics');
        expect(resolveAdvancedSurfaceFromLegacySearch(
            '?tab=advanced',
        )).toBeUndefined();
    });
});

describe('Recipe Console Advanced legacy href contract', () => {
    it('opens a canonical direct route with only versioned safe context', () => {
        const href = createAdvancedLegacyHref({
            surface: 'diagnostics',
            state: MONITOR_STATE,
            sourceSearch: '?' + new URLSearchParams({
                provider: 'browser-rallar',
                applicationId: 'application-a',
                workspaceId: 'workspace-a',
                groupId: 'group-a',
                controlToken: 'control-secret',
                agentSessionTicket: 'ticket-secret',
                password: 'password-secret',
                apiKey: 'api-key-secret',
                controlUrl: 'wss://control.test/?token=nested-secret',
                returnTo: 'https://attacker.test/steal',
                futureField: 'arbitrary-value',
            }),
        });
        const url = legacyUrl(href);

        expect(Object.fromEntries(url.searchParams)).toEqual({
            experience: 'legacy',
            workspace: 'rallar',
            tab: 'rtc-diagnostics',
            legacySurface: 'direct.rtc-diagnostics',
            diagnosticContext: '1',
            view: 'monitor',
            provider: 'browser-rallar',
            contextApplicationId: 'application-a',
            contextWorkspaceId: 'workspace-a',
            contextGroupId: 'group-a',
            controlRunId: 'control/run',
            distributedRunId: 'distributed run',
            agentId: 'agent-a',
            recipeId: 'recipe-a',
            commandId: 'command-a',
            transport: 'rtc',
        });
        expect(href).not.toMatch(
            /control-secret|ticket-secret|password-secret|api-key-secret|nested-secret|attacker|arbitrary-value|returnTo/i,
        );
    });

    it('canonicalizes old Advanced and Flow Builder aliases without forcing a provider', () => {
        const distributed = legacyUrl(createAdvancedLegacyHref({
            surface: 'dist',
            state: MONITOR_STATE,
        }));
        expect(Object.fromEntries(distributed.searchParams)).toMatchObject({
            experience: 'legacy',
            workspace: 'black-box-runner',
            tab: 'advanced',
            advancedSurface: 'distributed',
            legacySurface: 'legacy.distributed-recipes',
            diagnosticContext: '1',
        });
        expect(distributed.searchParams.has('provider')).toBe(false);

        const builder = legacyUrl(createAdvancedLegacyHref({
            surface: 'flow-builder',
            state: MONITOR_STATE,
            sourceSearch: '?provider=https%3A%2F%2Fevil.test',
        }));
        expect(builder.searchParams.get('workspace')).toBe('black-box-runner');
        expect(builder.searchParams.get('tab')).toBe('builder');
        expect(builder.searchParams.has('advancedSurface')).toBe(false);
        expect(builder.searchParams.has('provider')).toBe(false);
        expect(createAdvancedLegacyHref({
            surface: 'unknown',
            state: MONITOR_STATE,
        })).toBeUndefined();
    });

    it('reconstructs a Recipe Console return URL instead of consuming returnTo', () => {
        const outbound = legacyUrl(createAdvancedLegacyHref({
            surface: 'rtc-diagnostics',
            state: MONITOR_STATE,
            sourceSearch: '?provider=browser-rallar' +
                '&applicationId=application-a&workspaceId=workspace-a&groupId=group-a',
        }));
        outbound.searchParams.set('returnTo', 'https://attacker.test/steal');
        outbound.searchParams.set('token', 'return-secret');
        outbound.searchParams.set('rallarPassword', 'password-secret');
        outbound.searchParams.set('controlUrl', 'wss://control.test/private');
        outbound.searchParams.set('apiKey', 'api-secret');

        const href = createAdvancedRecipeConsoleReturnHref(outbound.search);
        const url = legacyUrl(href);
        expect(Object.fromEntries(url.searchParams)).toEqual({
            v: '1',
            experience: 'recipe-console',
            view: 'monitor',
            provider: 'browser-rallar',
            controlRunId: 'control/run',
            distributedRunId: 'distributed run',
            agentId: 'agent-a',
            recipeId: 'recipe-a',
            commandId: 'command-a',
            transport: 'rtc',
        });
        expect(href).not.toMatch(
            /returnTo|attacker|return-secret|password-secret|control\.test|api-secret/i,
        );
    });

    it('agrees with the reviewed legacy parser and return builder', () => {
        const outbound = legacyUrl(createAdvancedLegacyHref({
            surface: 'rtc-diagnostics',
            state: MONITOR_STATE,
            sourceSearch: '?provider=browser-rallar'
                + '&applicationId=application-a&workspaceId=workspace-a'
                + '&groupId=group-a',
        }));
        const parsed = parseLegacyDiagnosticContext(outbound.search);

        expect(parsed.status).toBe('ready');
        expect(createAdvancedRecipeConsoleReturnHref(outbound.search)).toBe(
            buildLegacyDiagnosticReturnHref(parsed.context),
        );
    });

    it('keeps canonical legacySurface only for an Advanced return', () => {
        const source = new URLSearchParams({
                diagnosticContext: '1',
                view: 'advanced',
                legacySurface: 'diagnostics',
                provider: 'simulated',
            });
        const href = createAdvancedRecipeConsoleReturnHref(`?${source}`);
        const url = legacyUrl(href);

        expect(Object.fromEntries(url.searchParams)).toEqual({
            v: '1',
            experience: 'recipe-console',
            view: 'advanced',
            provider: 'simulated',
            legacySurface: 'direct.rtc-diagnostics',
        });

        source.set('legacySurface', 'direct.rtc-diagnostics');
        const parsed = parseLegacyDiagnosticContext(`?${source}`);
        expect(parsed.status).toBe('ready');
        expect(buildLegacyDiagnosticReturnHref(parsed.context)).toBe(href);
        expect(new TextEncoder().encode(
            new URL(href, 'https://app.example').search.slice(1),
        ).byteLength).toBeLessThanOrEqual(
            ADVANCED_DIAGNOSTIC_QUERY_MAX_BYTES,
        );
    });

    it('prioritizes the canonical Advanced surface at the return URL budget', () => {
        const href = createAdvancedRecipeConsoleReturnHref('?' +
            new URLSearchParams({
                diagnosticContext: '1',
                view: 'advanced',
                legacySurface: 'direct.rtc-diagnostics',
                controlRunId: 'r'.repeat(4_003),
            }));
        const url = legacyUrl(href);

        expect(url.searchParams.get('legacySurface'))
            .toBe('direct.rtc-diagnostics');
        expect(url.searchParams.has('controlRunId')).toBe(false);
        expect(utf8Bytes(url.search.slice(1)))
            .toBeLessThanOrEqual(ADVANCED_DIAGNOSTIC_QUERY_MAX_BYTES);
    });

    it('drops unversioned context invalid values and oversized output', () => {
        const unversioned = legacyUrl(createAdvancedRecipeConsoleReturnHref('?' +
            new URLSearchParams({
                diagnosticContext: '2',
                view: 'monitor',
                legacySurface: 'rtc-diagnostics',
                provider: 'browser-rallar',
                controlRunId: 'must-not-survive',
                returnTo: '/?token=secret',
            })));
        expect(Object.fromEntries(unversioned.searchParams)).toEqual({
            v: '1',
            experience: 'recipe-console',
            view: 'advanced',
        });

        const overlong = '界'.repeat(
            Math.floor(ADVANCED_DIAGNOSTIC_CONTEXT_MAX_BYTES / 3) + 1,
        );
        const largeState = {
            ...MONITOR_STATE,
            view: 'advanced',
            controlRunId: overlong,
            distributedRunId: 'd'.repeat(ADVANCED_DIAGNOSTIC_CONTEXT_MAX_BYTES),
            agentId: 'a'.repeat(ADVANCED_DIAGNOSTIC_CONTEXT_MAX_BYTES),
            recipeId: 'r'.repeat(ADVANCED_DIAGNOSTIC_CONTEXT_MAX_BYTES),
            commandId: 'c'.repeat(ADVANCED_DIAGNOSTIC_CONTEXT_MAX_BYTES),
        } as RecipeConsoleUrlState;
        const href = createAdvancedLegacyHref({
            surface: 'rtc-diagnostics',
            state: largeState,
            sourceSearch: '?' + new URLSearchParams({
                applicationId: 'p'.repeat(ADVANCED_DIAGNOSTIC_CONTEXT_MAX_BYTES),
                workspaceId: 'w'.repeat(ADVANCED_DIAGNOSTIC_CONTEXT_MAX_BYTES),
                groupId: 'g'.repeat(ADVANCED_DIAGNOSTIC_CONTEXT_MAX_BYTES),
            }),
        });
        const largeUrl = legacyUrl(href);
        expect(largeUrl.searchParams.has('controlRunId')).toBe(false);
        expect(utf8Bytes(largeUrl.search.slice(1)))
            .toBeLessThanOrEqual(ADVANCED_DIAGNOSTIC_QUERY_MAX_BYTES);
        const returnUrl = legacyUrl(
            createAdvancedRecipeConsoleReturnHref(largeUrl.search),
        );
        expect(returnUrl.searchParams.get('legacySurface'))
            .toBe('direct.rtc-diagnostics');
        expect(utf8Bytes(returnUrl.search.slice(1)))
            .toBeLessThanOrEqual(ADVANCED_DIAGNOSTIC_QUERY_MAX_BYTES);
    });
});

function direct(workspace: 'rallar' | 'black-box-runner', tab: string) {
    return { kind: 'direct', workspace, tab } as const;
}

function advancedLegacy(tab: string) {
    return { kind: 'advanced-legacy', workspace: 'black-box-runner', tab } as const;
}

function advancedChild(advancedSurface: string) {
    return {
        kind: 'advanced-legacy',
        workspace: 'black-box-runner',
        tab: 'advanced',
        advancedSurface,
    } as const;
}

function legacyUrl(href: string | undefined): URL {
    expect(href).toBeTypeOf('string');
    return new URL(href!, 'https://console.test/operator');
}

function utf8Bytes(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}
