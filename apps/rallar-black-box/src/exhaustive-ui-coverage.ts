import type { AppModeId, AppTabId } from './app-tabs.ts';

export type ExhaustiveUiCoverageRow = Readonly<{
    id: string;
    tab: AppTabId;
    workspace: AppModeId;
    intent: string;
    specFile: string;
    liveBackend: boolean;
    requiresControl: boolean;
    requiresMedia: boolean;
    evidence: readonly string[];
}>;

export const EXHAUSTIVE_UI_COVERAGE_MATRIX: readonly ExhaustiveUiCoverageRow[] = [
    {
        id: 'shell-navigation-global-context',
        tab: 'quick-test',
        workspace: 'rallar',
        intent:
            'Exercise direct-mode shell defaults, workspace switching, trace, Global Context, and persisted UI state.',
        specFile: 'exhaustive-shell-navigation.spec.ts',
        liveBackend: true,
        requiresControl: false,
        requiresMedia: false,
        evidence: ['mode switch', 'global context', 'trace strip', 'redacted storage']
    },
    {
        id: 'auth-login-negative-ticket-restore',
        tab: 'auth',
        workspace: 'rallar',
        intent: 'Validate login, negative login, restore/logout, WS ticket creation, and redacted auth output.',
        specFile: 'exhaustive-auth-groups.spec.ts',
        liveBackend: true,
        requiresControl: false,
        requiresMedia: false,
        evidence: ['login shell', 'bad credentials', 'ws ticket', 'logout']
    },
    {
        id: 'groups-clients-state-events',
        tab: 'rooms-clients',
        workspace: 'rallar',
        intent: 'Create/join/read groups, connect client presence, and page state events.',
        specFile: 'exhaustive-auth-groups.spec.ts',
        liveBackend: true,
        requiresControl: false,
        requiresMedia: false,
        evidence: ['group row', 'client row', 'event page', 'principal mismatch']
    },
    {
        id: 'quick-test-ws-receive-repeat',
        tab: 'quick-test',
        workspace: 'rallar',
        intent: 'Run the Quick Test group create/join/subscribe/send/repeat/receive workflow.',
        specFile: 'exhaustive-quick-websocket.spec.ts',
        liveBackend: true,
        requiresControl: false,
        requiresMedia: false,
        evidence: ['received message', 'copy diagnostics', 'runner recipe']
    },
    {
        id: 'websocket-command-center',
        tab: 'websocket',
        workspace: 'rallar',
        intent: 'Validate authenticated API WebSocket ticket, open, send, wait, reconnect, close, and negative states.',
        specFile: 'exhaustive-quick-websocket.spec.ts',
        liveBackend: true,
        requiresControl: false,
        requiresMedia: false,
        evidence: ['ws ticket', 'open result', 'send result', 'missing ticket failure']
    },
    {
        id: 'rtc-realtime-direct-facade',
        tab: 'rtc-realtime',
        workspace: 'rallar',
        intent: 'Exercise direct realtime/messages RTC operations, scoped addressing, and diagnostics.',
        specFile: 'exhaustive-rtc-realtime.spec.ts',
        liveBackend: true,
        requiresControl: false,
        requiresMedia: false,
        evidence: ['rtc status', 'lane readiness', 'nack evidence', 'topology route']
    },
    {
        id: 'rallar-data-operations',
        tab: 'rallar-data',
        workspace: 'rallar',
        intent: 'Run Rallar Data store lifecycle operations and visible change/result evidence.',
        specFile: 'exhaustive-rallar-data-crdt-media.spec.ts',
        liveBackend: true,
        requiresControl: false,
        requiresMedia: false,
        evidence: ['write result', 'compare-and-set', 'change events', 'storage estimate']
    },
    {
        id: 'crdt-health-editor-admin',
        tab: 'crdt-health',
        workspace: 'rallar',
        intent: 'Validate CRDT editor local/live guardrails, document actions, and admin health surfaces.',
        specFile: 'exhaustive-rallar-data-crdt-media.spec.ts',
        liveBackend: true,
        requiresControl: false,
        requiresMedia: false,
        evidence: ['editor action', 'admin health', 'document table', 'failure state']
    },
    {
        id: 'media-fake-device-console',
        tab: 'media',
        workspace: 'rallar',
        intent:
            'Attach fake media devices, toggle tracks, apply policy, subscribe remote streams, and copy diagnostics.',
        specFile: 'exhaustive-rallar-data-crdt-media.spec.ts',
        liveBackend: true,
        requiresControl: false,
        requiresMedia: true,
        evidence: ['local stream', 'track toggles', 'policy result', 'diagnostics']
    },
    {
        id: 'rallar-server-rest-workbench',
        tab: 'rallar-server',
        workspace: 'rallar',
        intent: 'Run REST presets/manual requests, OpenAPI refresh, redacted exports, and collection assertions.',
        specFile: 'exhaustive-rallar-server.spec.ts',
        liveBackend: true,
        requiresControl: false,
        requiresMedia: false,
        evidence: ['status response', 'curl redaction', 'command preview', 'collection extraction']
    },
    {
        id: 'runner-recipes-primary-launcher',
        tab: 'recipes',
        workspace: 'black-box-runner',
        intent:
            'Open the primary runner Recipes launcher, verify readiness statuses, one-click local launch affordances, and guided distributed launch blockers.',
        specFile: 'exhaustive-runner-workbench.spec.ts',
        liveBackend: true,
        requiresControl: true,
        requiresMedia: false,
        evidence: ['readiness panel', 'targetable agents', 'recipe card', 'distributed disabled reason']
    },
    {
        id: 'runner-runs-results-monitor',
        tab: 'runs',
        workspace: 'black-box-runner',
        intent:
            'Inspect current and recent runner results, failures, reports, and control state from the simplified Runs surface.',
        specFile: 'exhaustive-runner-workbench.spec.ts',
        liveBackend: true,
        requiresControl: true,
        requiresMedia: false,
        evidence: ['run metrics', 'run participants', 'recent command', 'report panel']
    },
    {
        id: 'runner-fleet-regional-reporting',
        tab: 'fleet',
        workspace: 'black-box-runner',
        intent:
            'Inspect cross-run fleet reporting with agent heatmaps, region summaries, repeated failures, timing distributions, and shareable exports.',
        specFile: 'exhaustive-control-distributed.spec.ts',
        liveBackend: true,
        requiresControl: true,
        requiresMedia: false,
        evidence: ['live fleet', 'agent heatmap', 'region summary', 'fleet export']
    },
    {
        id: 'runner-builder-primary-flow',
        tab: 'builder',
        workspace: 'black-box-runner',
        intent:
            'Use the primary Builder tab to create flows, preview recipes, and export runner scenarios without entering Advanced.',
        specFile: 'exhaustive-runner-workbench.spec.ts',
        liveBackend: true,
        requiresControl: false,
        requiresMedia: false,
        evidence: ['builder template', 'recipe preview', 'runner scenario', 'run flow']
    },
    {
        id: 'runner-advanced-raw-controls',
        tab: 'advanced',
        workspace: 'black-box-runner',
        intent:
            'Verify raw Manual Rallar, Local Workbench, Run Manager, Distributed Recipes, and Shared Test controls remain reachable under Advanced.',
        specFile: 'exhaustive-runner-workbench.spec.ts',
        liveBackend: true,
        requiresControl: true,
        requiresMedia: false,
        evidence: ['advanced switch', 'local workbench', 'run manager', 'distributed recipes']
    },
    {
        id: 'manual-rallar-runner-workbench',
        tab: 'manual-rallar',
        workspace: 'black-box-runner',
        intent: 'Exercise Manual Rallar configure/connect/send/matrix/negative recipe actions and history.',
        specFile: 'exhaustive-runner-workbench.spec.ts',
        liveBackend: true,
        requiresControl: false,
        requiresMedia: false,
        evidence: ['command preview', 'received inbox', 'history row', 'recipe snippet']
    },
    {
        id: 'local-workbench-recipes',
        tab: 'local-workbench',
        workspace: 'black-box-runner',
        intent: 'Load, run, cancel, and reset local recipes while checking queue/report/failure panels.',
        specFile: 'exhaustive-runner-workbench.spec.ts',
        liveBackend: true,
        requiresControl: false,
        requiresMedia: false,
        evidence: ['loaded recipe', 'command queue', 'completed command', 'report snapshot']
    },
    {
        id: 'flow-builder-recipes',
        tab: 'flow-builder',
        workspace: 'black-box-runner',
        intent: 'Build flows, normalize JSON, run generated recipes, and copy SPA/runner exports.',
        specFile: 'exhaustive-runner-workbench.spec.ts',
        liveBackend: true,
        requiresControl: false,
        requiresMedia: false,
        evidence: ['flow preview', 'run flow', 'SPA recipe', 'runner scenario']
    },
    {
        id: 'shared-test-catalog-artifacts',
        tab: 'shared-test',
        workspace: 'black-box-runner',
        intent: 'Validate shared-test catalog command surfaces plus successful and invalid artifact import.',
        specFile: 'exhaustive-runner-workbench.spec.ts',
        liveBackend: false,
        requiresControl: false,
        requiresMedia: false,
        evidence: ['catalog row', 'copy command', 'valid artifact', 'invalid artifact']
    },
    {
        id: 'run-manager-control-artifacts',
        tab: 'run-manager',
        workspace: 'black-box-runner',
        intent: 'Register agents, refresh/select runs, enqueue presets, reset/delete runs, and export artifacts.',
        specFile: 'exhaustive-control-distributed.spec.ts',
        liveBackend: true,
        requiresControl: true,
        requiresMedia: false,
        evidence: ['registered agents', 'queued command', 'result snapshot', 'artifact bundle']
    },
    {
        id: 'distributed-recipes-control-run',
        tab: 'distributed-recipes',
        workspace: 'black-box-runner',
        intent: 'Resolve targets, set policies/barriers/roles, create/stage/start/cancel/export distributed runs.',
        specFile: 'exhaustive-control-distributed.spec.ts',
        liveBackend: true,
        requiresControl: true,
        requiresMedia: false,
        evidence: ['target resolution', 'manifest preview', 'run monitor', 'history/compare']
    },
    {
        id: 'event-stream-focus-filters',
        tab: 'event-stream',
        workspace: 'rallar',
        intent: 'Verify event stream filters, windows, command focus, and redacted event payloads.',
        specFile: 'exhaustive-event-topology-trace.spec.ts',
        liveBackend: true,
        requiresControl: false,
        requiresMedia: false,
        evidence: ['kind filter', 'topic filter', 'window size', 'current focus']
    },
    {
        id: 'rallar-trace-redacted-events',
        tab: 'rallar-trace',
        workspace: 'rallar',
        intent: 'Inspect expanded Rallar trace filters, severity counts, windows, and redacted payloads.',
        specFile: 'exhaustive-event-topology-trace.spec.ts',
        liveBackend: true,
        requiresControl: false,
        requiresMedia: false,
        evidence: ['trace filter', 'severity metrics', 'payload JSON', 'redaction']
    },
    {
        id: 'rtc-diagnostics-stages',
        tab: 'rtc-diagnostics',
        workspace: 'rallar',
        intent: 'Validate RTC stage summaries, peer/lane warnings, first-payload evidence, and diagnostic filters.',
        specFile: 'exhaustive-event-topology-trace.spec.ts',
        liveBackend: true,
        requiresControl: false,
        requiresMedia: false,
        evidence: ['stage list', 'lane health', 'warning filters', 'first payload']
    },
    {
        id: 'topology-routes-search',
        tab: 'topology',
        workspace: 'rallar',
        intent: 'Verify topology search, node limits, status filters, and route links after live activity.',
        specFile: 'exhaustive-event-topology-trace.spec.ts',
        liveBackend: true,
        requiresControl: false,
        requiresMedia: false,
        evidence: ['node counts', 'search', 'status filter', 'route command link']
    }
] as const;

export function exhaustiveUiCoverageRowsForTab(
    tab: AppTabId,
    matrix: readonly ExhaustiveUiCoverageRow[] = EXHAUSTIVE_UI_COVERAGE_MATRIX
): readonly ExhaustiveUiCoverageRow[] {
    return matrix.filter((row) => row.tab === tab);
}

export function exhaustiveUiCoverageSpecFiles(
    matrix: readonly ExhaustiveUiCoverageRow[] = EXHAUSTIVE_UI_COVERAGE_MATRIX
): readonly string[] {
    return [...new Set(matrix.map((row) => row.specFile))].sort();
}
