import { describe, expect, it } from 'vitest';
import {
    ADVANCED_DIAGNOSTIC_HANDOFF_MAX_CORRELATED_FAILURE_KEYS,
    ADVANCED_DIAGNOSTIC_HANDOFF_MAX_DIAGNOSTICS,
    ADVANCED_DIAGNOSTIC_HANDOFF_MAX_TEXT_LENGTH,
    deriveAdvancedDiagnosticHandoffTargets
} from '../../shared-test/rallar-bb-test/mod.ts';

const AUTH_AND_WEBSOCKET = [
    { surface: 'auth', label: 'Auth' },
    { surface: 'websocket', label: 'WebSocket' }
] as const;

function diagnostic(
    correlatedFailureKeys: unknown,
    fields: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
    return { correlatedFailureKeys, ...fields };
}

describe('advanced diagnostic handoff targets', () => {
    it('routes auth, ticket, unauthorized, forbidden, and BAD_AUTH failures to Auth then WebSocket', () => {
        const authSignals = [
            { code: 'BAD_AUTH', message: 'Credentials rejected' },
            { message: 'WebSocket ticket was rejected' },
            { message: 'Request was unauthorized' },
            { message: 'Operation forbidden for this user' }
        ];

        authSignals.forEach((failure, index) => {
            expect(deriveAdvancedDiagnosticHandoffTargets({
                failure: { key: `failure-${index}`, ...failure },
                diagnostics: []
            })).toEqual(AUTH_AND_WEBSOCKET);
        });
    });

    it('routes stable RTC no-peer and no-route failure codes to RTC Diagnostics', () => {
        ['RALLAR_BB_RTC_NO_PEERS', 'RTC_NO_ROUTE'].forEach((code) => {
            expect(deriveAdvancedDiagnosticHandoffTargets({
                failure: { key: code, code, message: 'Transport failed' }
            })).toEqual([
                { surface: 'rtc-diagnostics', label: 'RTC Diagnostics' }
            ]);
        });
    });

    it('uses no-peer and no-route diagnostics only when correlated to the selected failure key', () => {
        expect(deriveAdvancedDiagnosticHandoffTargets({
            failure: { key: 'selected', message: 'Command failed' },
            diagnostics: [
                diagnostic(['other'], {
                    diagnosticTypeId: 'rallar.browser.auth.ticket_forbidden',
                    message: 'Unauthorized ticket'
                }),
                diagnostic(['selected'], {
                    diagnosticTypeId: 'rallar.browser.rtc.no_peer',
                    message: 'No peer was discovered'
                }),
                diagnostic(['selected', 'selected'], {
                    topic: 'rallar.browser.rtc.no_route',
                    summary: 'No route to the remote peer'
                })
            ]
        })).toEqual([
            { surface: 'rtc-diagnostics', label: 'RTC Diagnostics' }
        ]);
    });

    it('routes missing group and member failures to Groups/Clients', () => {
        [
            { code: 'GROUP_NOT_FOUND', message: 'Group lookup failed' },
            { code: 'MISSING_MEMBER', message: 'Membership failed' },
            { message: 'Required group is missing' },
            { message: 'Expected member was not found' }
        ].forEach((failure, index) => {
            expect(deriveAdvancedDiagnosticHandoffTargets({
                failure: { key: `membership-${index}`, ...failure }
            })).toEqual([
                { surface: 'rooms-clients', label: 'Groups/Clients' }
            ]);
        });
    });

    it('routes unavailable HTTP services and explicit server-status failures to Rallar Server', () => {
        [
            { code: 'HTTP_SERVICE_UNAVAILABLE', message: 'API unavailable' },
            { code: 'HTTP_STATUS_503', message: 'Request failed' },
            { message: 'Rallar Server status 502' },
            { message: 'HTTP status 500 from the control service' }
        ].forEach((failure, index) => {
            expect(deriveAdvancedDiagnosticHandoffTargets({
                failure: { key: `server-${index}`, ...failure }
            })).toEqual([
                { surface: 'rallar-server', label: 'Rallar Server' }
            ]);
        });
    });

    it('uses HTTP service diagnostics only when correlated to the selected failure', () => {
        const unrelated = diagnostic(['other'], { code: 'HTTP_SERVICE_UNAVAILABLE' });
        expect(deriveAdvancedDiagnosticHandoffTargets({
            failure: { key: 'selected', message: 'Command failed' },
            diagnostics: [unrelated]
        })).toEqual([]);

        expect(deriveAdvancedDiagnosticHandoffTargets({
            failure: { key: 'selected', message: 'Command failed' },
            diagnostics: [
                unrelated,
                diagnostic(['selected'], { code: 'HTTP_SERVICE_UNAVAILABLE' })
            ]
        })).toEqual([
            { surface: 'rallar-server', label: 'Rallar Server' }
        ]);
    });

    it('returns a stable, deduplicated surface order regardless of diagnostic order', () => {
        expect(deriveAdvancedDiagnosticHandoffTargets({
            failure: {
                key: 'mixed',
                code: 'BAD_AUTH',
                message: 'Missing group; Rallar Server status 503'
            },
            diagnostics: [
                diagnostic(['mixed'], { topic: 'rtc.no_route' }),
                diagnostic(['mixed'], { message: 'no_peer' }),
                diagnostic(['mixed'], { topic: 'rtc.no_route' })
            ]
        })).toEqual([
            ...AUTH_AND_WEBSOCKET,
            { surface: 'rtc-diagnostics', label: 'RTC Diagnostics' },
            { surface: 'rooms-clients', label: 'Groups/Clients' },
            { surface: 'rallar-server', label: 'Rallar Server' }
        ]);
    });

    it('returns no targets for unrelated, missing, or malformed evidence', () => {
        const inputs: unknown[] = [
            undefined,
            null,
            {},
            { failure: null, diagnostics: null },
            { failure: { key: [], code: {}, message: 42 }, diagnostics: [{}] },
            {
                failure: { key: 'other', message: 'Command timed out' },
                diagnostics: [
                    diagnostic('other', { topic: 'rtc.no_route' }),
                    diagnostic([42, null], { message: 'forbidden' })
                ]
            }
        ];

        inputs.forEach((input) => {
            expect(() => deriveAdvancedDiagnosticHandoffTargets(input)).not.toThrow();
            expect(deriveAdvancedDiagnosticHandoffTargets(input)).toEqual([]);
        });
    });

    it('does not mutate evidence or classify generic and uncorrelated phrases', () => {
        const correlatedFailureKeys = Object.freeze(['other']);
        const diagnostics = Object.freeze([
            Object.freeze({
                correlatedFailureKeys,
                code: 'BAD_AUTH',
                topic: 'rallar.browser.rtc.no_route',
                summary: 'Rallar Server status 503'
            })
        ]);
        const failure = Object.freeze({
            key: 'selected',
            message: 'Authentic route selection reached the server retry policy'
        });
        const input = Object.freeze({ failure, diagnostics });
        const before = JSON.stringify(input);

        expect(deriveAdvancedDiagnosticHandoffTargets(input)).toEqual([]);
        expect(JSON.stringify(input)).toBe(before);
        expect(input.failure).toBe(failure);
        expect(input.diagnostics).toBe(diagnostics);
    });

    it('bounds arbitrary text, diagnostic arrays, and correlation-key arrays', () => {
        const textBeyondBound = `${'x'.repeat(ADVANCED_DIAGNOSTIC_HANDOFF_MAX_TEXT_LENGTH)} BAD_AUTH`;
        const diagnostics = Array.from(
            { length: ADVANCED_DIAGNOSTIC_HANDOFF_MAX_DIAGNOSTICS + 1 },
            (_, index) =>
                index === ADVANCED_DIAGNOSTIC_HANDOFF_MAX_DIAGNOSTICS
                    ? diagnostic(['selected'], { topic: 'rtc.no_route' })
                    : diagnostic(['other'], { topic: 'runtime.info' })
        );
        const correlationKeys = Array.from(
            { length: ADVANCED_DIAGNOSTIC_HANDOFF_MAX_CORRELATED_FAILURE_KEYS + 1 },
            (_, index) =>
                index === ADVANCED_DIAGNOSTIC_HANDOFF_MAX_CORRELATED_FAILURE_KEYS
                    ? 'selected'
                    : `other-${index}`
        );

        expect(deriveAdvancedDiagnosticHandoffTargets({
            failure: { key: 'selected', message: textBeyondBound },
            diagnostics
        })).toEqual([]);
        expect(deriveAdvancedDiagnosticHandoffTargets({
            failure: { key: 'selected', message: 'Command failed' },
            diagnostics: [diagnostic(correlationKeys, { topic: 'rtc.no_peer' })]
        })).toEqual([]);
    });
});
