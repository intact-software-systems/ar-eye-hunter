export const DIAGNOSTIC_BRIDGE_URL_STRING_MAX_BYTES = 4_096;
export const DIAGNOSTIC_BRIDGE_URL_QUERY_MAX_BYTES = 4_096;

export const DIAGNOSTIC_BRIDGE_PROVIDERS = [
    'simulated',
    'browser-rallar'
] as const;

export const DIAGNOSTIC_BRIDGE_LEGACY_SURFACE_IDS = [
    'direct.quick-test',
    'direct.auth',
    'direct.groups-clients',
    'direct.websocket',
    'direct.rtc-realtimes',
    'direct.topology',
    'direct.rtc-diagnostics',
    'direct.rallar-data',
    'direct.crdt',
    'direct.media',
    'direct.rallar-server',
    'direct.rallar-trace',
    'diagnostic.event-stream',
    'runner.recipes',
    'runner.runs',
    'runner.fleet',
    'runner.builder',
    'legacy.manual-rallar',
    'legacy.local-workbench',
    'legacy.run-manager',
    'legacy.distributed-recipes',
    'legacy.shared-test-catalog'
] as const;

export const DIAGNOSTIC_BRIDGE_SOURCE_VIEWS = [
    'execute',
    'monitor',
    'analyze',
    'tune',
    'fleet',
    'advanced'
] as const;

export const DIAGNOSTIC_BRIDGE_TRANSPORTS = [
    'realtime',
    'messages.rtc',
    'rtc',
    'ws',
    'http',
    'runtime'
] as const;

export type DiagnosticBridgeSourceView = typeof DIAGNOSTIC_BRIDGE_SOURCE_VIEWS[number];

export type DiagnosticBridgeTransport = typeof DIAGNOSTIC_BRIDGE_TRANSPORTS[number];

export type DiagnosticBridgeProvider = typeof DIAGNOSTIC_BRIDGE_PROVIDERS[number];

export type DiagnosticBridgeLegacySurfaceId = typeof DIAGNOSTIC_BRIDGE_LEGACY_SURFACE_IDS[number];
