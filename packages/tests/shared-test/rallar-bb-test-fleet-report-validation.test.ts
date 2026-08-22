import { describe, expect, it } from 'vitest';
import {
    RALLAR_BLACK_BOX_FLEET_REPORT_BUNDLE_MAX_BYTES,
    RALLAR_BLACK_BOX_FLEET_REPORT_FILE_MAX_BYTES,
    RALLAR_BLACK_BOX_FLEET_REPORT_VALIDATION_MAX_ISSUE_TEXT_LENGTH,
    RALLAR_BLACK_BOX_FLEET_REPORT_VALIDATION_MAX_ISSUES,
    validateControlFleetReportBundle,
    validateControlFleetReportsResponse,
    validateControlFleetRunReport,
    validateControlFleetRunReportCollection
} from '../../../packages/shared-test/rallar-bb-test/fleet-report-validation.ts';

function validReport(
    distributedRunId = 'distributed-1',
    generatedAtEpochMs = 2_000
): Record<string, unknown> {
    return {
        fleetReportSchemaVersion: 1,
        distributedRunId,
        controlRunId: `control-${distributedRunId}`,
        generatedAtEpochMs,
        state: 'passed',
        ok: true,
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'fleet-room'
        },
        recipeIds: ['rtc-smoke'],
        summary: {
            agents: 1,
            regions: 1,
            passed: 1,
            failed: 0,
            missing: 0,
            flaky: 0,
            stale: 0,
            passRate: 1,
            failureGroups: 0
        },
        timing: {
            run: { count: 1, p50Ms: 25 },
            commands: { count: 1, p50Ms: 10 }
        },
        agents: [{
            agentId: 'agent-1',
            label: {
                agentId: 'agent-1',
                region: 'eu-north',
                location: {
                    latitude: 59.91,
                    longitude: 10.75,
                    precision: 'approximate'
                }
            },
            state: 'passed',
            ok: true,
            missing: false,
            flaky: false,
            stale: false,
            commandCount: 1,
            failedCommandCount: 0,
            resultCount: 1,
            eventCount: 2,
            diagnosticCount: 0,
            reconnectCount: 0,
            durationMs: 25,
            failureSignatureIds: []
        }],
        regions: [{
            region: 'eu-north',
            agentCount: 1,
            passed: 1,
            failed: 0,
            missing: 0,
            flaky: 0,
            stale: 0,
            passRate: 1,
            timing: { count: 1, p50Ms: 25 }
        }],
        failureSignatures: [],
        artifactRefs: {
            distributedRun: `/distributed-runs/${distributedRunId}`,
            controlRun: `/runs/control-${distributedRunId}`,
            fleetReport: `/fleet/reports/${distributedRunId}`
        }
    };
}

function validAggregate(reportCount = 1): Record<string, unknown> {
    return {
        generatedAtEpochMs: 3_000,
        reportCount,
        runCount: reportCount,
        agentCount: reportCount,
        regionCount: 1,
        passRate: 1,
        staleAgentCount: 0,
        flakyAgentCount: 0,
        failureGroupCount: 0,
        timing: {
            runs: { count: reportCount, p50Ms: 25 },
            commands: { count: reportCount, p50Ms: 10 }
        },
        regions: [{
            region: 'eu-north',
            agentCount: reportCount,
            passed: reportCount,
            failed: 0,
            missing: 0,
            flaky: 0,
            stale: 0,
            passRate: 1,
            timing: { count: reportCount, p50Ms: 25 }
        }],
        failureSignatures: []
    };
}

function validBundle(
    distributedRunId = 'distributed-1',
    files: Record<string, unknown> = {
        'fleet-report.json': '{"ok":true}',
        'summary.md': '# Fleet report',
        'agent-results.csv': 'agentId,state\nagent-1,passed\n',
        'failure-signatures.csv': 'signatureId,count\n'
    }
): Record<string, unknown> {
    return {
        fleetReportSchemaVersion: 1,
        distributedRunId,
        generatedAtEpochMs: 3_000,
        files
    };
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        Object.freeze(value);
        for (const child of Object.values(value as Record<string, unknown>)) {
            deepFreeze(child);
        }
    }
    return value;
}

describe('fleet report runtime validation', () => {
    it('validates a bare optional snapshot collection without inventing an aggregate', () => {
        const valid = validReport('distributed-valid', 2_000);
        const invalid = validReport('distributed-invalid', 1_000);
        invalid.fleetReportSchemaVersion = 9;

        const result = validateControlFleetRunReportCollection([
            invalid,
            valid
        ]);

        expect(result).toMatchObject({
            ok: false,
            sourceCount: 2,
            acceptedCount: 1,
            quarantinedCount: 1
        });
        expect(result.reports.map((report) => report.distributedRunId))
            .toEqual(['distributed-valid']);
        expect(result.issues.map((issue) => issue.source)).toEqual(['report']);
    });

    it('accepts a schema-v1 report, preserves unknown extensions, and repairs a legacy missing label agentId', () => {
        const report = validReport();
        const agent = (report.agents as Array<Record<string, unknown>>)[0]!;
        const label = agent.label as Record<string, unknown>;
        delete label.agentId;
        label.futureLabelField = 'preserved';
        report.futureReportField = { enabled: true };
        const before = JSON.stringify(report);
        deepFreeze(report);

        const result = validateControlFleetRunReport(report);

        expect(result).toMatchObject({
            ok: true,
            sourceCount: 1,
            acceptedCount: 1,
            quarantinedCount: 0,
            issues: [],
            omittedIssueCount: 0
        });
        expect(result.report?.agents[0]?.label).toMatchObject({
            agentId: 'agent-1',
            futureLabelField: 'preserved'
        });
        expect(result.report).toMatchObject({
            futureReportField: { enabled: true }
        });
        expect(JSON.stringify(report)).toBe(before);
    });

    it.each(
        [
            ['unsupported schema version', (report: Record<string, unknown>) => {
                report.fleetReportSchemaVersion = 2;
            }, 'unsupported-schema-version'],
            ['invalid latitude', (report: Record<string, unknown>) => {
                const agent = (report.agents as Array<Record<string, unknown>>)[0]!;
                const label = agent.label as Record<string, unknown>;
                (label.location as Record<string, unknown>).latitude = 91;
            }, 'invalid-coordinate'],
            ['invalid longitude', (report: Record<string, unknown>) => {
                const agent = (report.agents as Array<Record<string, unknown>>)[0]!;
                const label = agent.label as Record<string, unknown>;
                (label.location as Record<string, unknown>).longitude = Number.NaN;
            }, 'invalid-coordinate'],
            ['malformed agent collection', (report: Record<string, unknown>) => {
                report.agents = {};
            }, 'invalid-type'],
            ['non-finite JSON number', (report: Record<string, unknown>) => {
                report.runDurationMs = JSON.parse('{"value":1e400}').value;
            }, 'invalid-value'],
            ['non-finite optional timing percentile', (report: Record<string, unknown>) => {
                const timing = report.timing as Record<string, Record<string, unknown>>;
                timing.run!.p95Ms = JSON.parse('{"value":1e400}').value;
            }, 'invalid-value'],
            ['malformed failure affected-agent collection', (report: Record<string, unknown>) => {
                report.failureSignatures = [{
                    signatureId: 'failure-1',
                    category: 'runtime',
                    title: 'Runtime failure',
                    normalizedMessage: 'failed',
                    count: 1,
                    affectedAgents: 'agent-1',
                    affectedRegions: [],
                    affectedRuns: ['distributed-1'],
                    likelyCause: 'runtime',
                    nextAction: 'retry'
                }];
            }, 'invalid-type']
        ] as const
    )('rejects %s', (_label, mutate, issueCode) => {
        const report = validReport();
        mutate(report);

        const result = validateControlFleetRunReport(report);

        expect(result).toMatchObject({
            ok: false,
            acceptedCount: 0,
            quarantinedCount: 1
        });
        expect(result.report).toBeUndefined();
        expect(result.issues.map((issue) => issue.code)).toContain(issueCode);
    });

    it('accepts a complete response with unknown extensions', () => {
        const response = {
            reports: [validReport()],
            aggregate: {
                ...validAggregate(),
                futureAggregateField: true
            },
            nextCursor: 'future-cursor'
        };

        const result = validateControlFleetReportsResponse(response);

        expect(result).toMatchObject({
            ok: true,
            sourceCount: 1,
            acceptedCount: 1,
            quarantinedCount: 0,
            aggregate: { futureAggregateField: true },
            issues: []
        });
        expect(result.reports.map((report) => report.distributedRunId)).toEqual([
            'distributed-1'
        ]);
    });

    it('retains valid nonconflicting reports while quarantining every duplicate and malformed source deterministically', () => {
        const newest = validReport('distributed-z', 5_000);
        const sameTime = validReport('distributed-a', 5_000);
        const duplicateOld = validReport('distributed-duplicate', 1_000);
        const duplicateNew = validReport('distributed-duplicate', 9_000);
        const malformed = validReport('distributed-malformed', 8_000);
        const malformedAgent = (malformed.agents as Array<Record<string, unknown>>)[0]!;
        const malformedLabel = malformedAgent.label as Record<string, unknown>;
        (malformedLabel.location as Record<string, unknown>).longitude = 181;
        const reports = [duplicateOld, newest, malformed, sameTime, duplicateNew];
        const before = JSON.stringify(reports);
        deepFreeze(reports);

        const forward = validateControlFleetReportsResponse({
            reports,
            aggregate: validAggregate(reports.length)
        });
        const reversed = validateControlFleetReportsResponse({
            reports: [...reports].reverse(),
            aggregate: validAggregate(reports.length)
        });

        expect(forward).toMatchObject({
            ok: false,
            sourceCount: 5,
            acceptedCount: 2,
            quarantinedCount: 3,
            omittedIssueCount: 0
        });
        expect(forward.reports.map((report) => report.distributedRunId)).toEqual([
            'distributed-a',
            'distributed-z'
        ]);
        expect(forward.issues.map((issue) => issue.code)).toEqual([
            'duplicate-distributed-run-id',
            'invalid-coordinate'
        ]);
        expect(reversed.reports).toEqual(forward.reports);
        expect(reversed.issues).toEqual(forward.issues);
        expect(JSON.stringify(reports)).toBe(before);
    });

    it('bounds stable issue output at 64 while preserving exact omitted and cardinality counts', () => {
        const reports = Array.from({ length: 70 }, (_, index) => ({
            ...validReport(`distributed-${String(index).padStart(3, '0')}-${'x'.repeat(1_024)}`),
            fleetReportSchemaVersion: 99
        }));

        const result = validateControlFleetReportsResponse({
            reports: [...reports].reverse(),
            aggregate: validAggregate(reports.length)
        });
        const permuted = validateControlFleetReportsResponse({
            reports,
            aggregate: validAggregate(reports.length)
        });

        expect(result).toMatchObject({
            ok: false,
            sourceCount: 70,
            acceptedCount: 0,
            quarantinedCount: 70,
            omittedIssueCount: 6
        });
        expect(result.issues).toHaveLength(
            RALLAR_BLACK_BOX_FLEET_REPORT_VALIDATION_MAX_ISSUES
        );
        expect(result.issues.every((issue) =>
            issue.path.length <= RALLAR_BLACK_BOX_FLEET_REPORT_VALIDATION_MAX_ISSUE_TEXT_LENGTH &&
            issue.message.length <= RALLAR_BLACK_BOX_FLEET_REPORT_VALIDATION_MAX_ISSUE_TEXT_LENGTH
        )).toBe(true);
        expect(permuted.issues).toEqual(result.issues);
        expect(permuted.omittedIssueCount).toBe(result.omittedIssueCount);
    });
});

describe('fleet report bundle runtime validation', () => {
    it('accepts exactly the four contract files and preserves their text and unknown envelope extensions', () => {
        const bundle = {
            ...validBundle(),
            futureBundleField: 'preserved'
        };

        const result = validateControlFleetReportBundle(bundle, 'distributed-1');

        expect(result).toMatchObject({
            ok: true,
            issues: [],
            omittedIssueCount: 0,
            bundle: { futureBundleField: 'preserved' }
        });
        expect(result.bundle?.files).toEqual(
            (bundle as Record<string, unknown>).files
        );
    });

    it.each(
        [
            ['unsupported schema', { ...validBundle(), fleetReportSchemaVersion: 2 }, 'unsupported-schema-version'],
            ['wrong requested identity', validBundle('other-run'), 'bundle-run-id-mismatch'],
            [
                'a missing file',
                validBundle('distributed-1', {
                    'fleet-report.json': '{}',
                    'summary.md': '',
                    'agent-results.csv': ''
                }),
                'missing-bundle-file'
            ],
            [
                'an extra file',
                validBundle('distributed-1', {
                    ...(validBundle().files as Record<string, unknown>),
                    'unexpected.txt': 'no'
                }),
                'unexpected-bundle-file'
            ],
            [
                'a non-text file',
                validBundle('distributed-1', {
                    ...(validBundle().files as Record<string, unknown>),
                    'summary.md': new Uint8Array()
                }),
                'invalid-type'
            ]
        ] as const
    )('rejects %s', (_label, bundle, issueCode) => {
        const result = validateControlFleetReportBundle(bundle, 'distributed-1');

        expect(result.ok).toBe(false);
        expect(result.bundle).toBeUndefined();
        expect(result.issues.map((issue) => issue.code)).toContain(issueCode);
    });

    it('measures per-file limits in UTF-8 bytes at the exact boundary', () => {
        const exactUtf8 = 'é'.repeat(
            RALLAR_BLACK_BOX_FLEET_REPORT_FILE_MAX_BYTES / 2
        );
        const exact = validBundle('distributed-1', {
            'fleet-report.json': exactUtf8,
            'summary.md': '',
            'agent-results.csv': '',
            'failure-signatures.csv': ''
        });
        const oversized = validBundle('distributed-1', {
            ...(exact.files as Record<string, unknown>),
            'fleet-report.json': `${exactUtf8}é`
        });

        expect(validateControlFleetReportBundle(exact, 'distributed-1').ok).toBe(true);
        expect(validateControlFleetReportBundle(
            oversized,
            'distributed-1'
        )).toMatchObject({
            ok: false,
            issues: [expect.objectContaining({ code: 'bundle-file-too-large' })]
        });
    });

    it('measures the aggregate UTF-8 limit independently of each file limit', () => {
        const perFile = 'x'.repeat(
            RALLAR_BLACK_BOX_FLEET_REPORT_BUNDLE_MAX_BYTES / 4
        );
        const exactFiles = {
            'fleet-report.json': perFile,
            'summary.md': perFile,
            'agent-results.csv': perFile,
            'failure-signatures.csv': perFile
        };

        expect(
            validateControlFleetReportBundle(
                validBundle('distributed-1', exactFiles),
                'distributed-1'
            ).ok
        ).toBe(true);
        expect(validateControlFleetReportBundle(
            validBundle('distributed-1', {
                ...exactFiles,
                'summary.md': `${perFile}x`
            }),
            'distributed-1'
        )).toMatchObject({
            ok: false,
            issues: [expect.objectContaining({ code: 'bundle-too-large' })]
        });
    });
});
