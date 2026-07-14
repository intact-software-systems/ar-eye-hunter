export const DIAGNOSTIC_BRIDGE_URL_STRING_MAX_BYTES = 4_096;

export const DIAGNOSTIC_BRIDGE_SOURCE_VIEWS = [
    'execute',
    'monitor',
    'analyze',
    'tune',
    'fleet',
    'advanced',
] as const;

export const DIAGNOSTIC_BRIDGE_TRANSPORTS = [
    'realtime',
    'messages.rtc',
    'rtc',
    'ws',
    'http',
    'runtime',
] as const;

export type DiagnosticBridgeSourceView =
    typeof DIAGNOSTIC_BRIDGE_SOURCE_VIEWS[number];

export type DiagnosticBridgeTransport =
    typeof DIAGNOSTIC_BRIDGE_TRANSPORTS[number];
