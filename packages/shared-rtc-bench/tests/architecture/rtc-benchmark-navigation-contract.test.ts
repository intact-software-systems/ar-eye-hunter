import fs from 'node:fs';
import path from 'node:path';
const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const packageRoot = path.join(repoRoot, 'packages/shared-rtc-bench');
const executablePaths = [
    'baseline/command/rtc-baseline-cli.ts',
    'workloads/signaling/rtc-peer-connection-diagnostics-burst.ts',
    'workloads/signaling/rtc-ice-candidate-queue-bench.ts',
    'workloads/signaling/rtc-peer-listener-cleanup-bench.ts',
    'workloads/data-channel/rtc-data-channel-replace-key-bench.ts',
    'workloads/data-channel/rtc-data-channel-drain-bench.ts',
    'workloads/data-channel/rtc-data-channel-close-retention-bench.ts',
    'workloads/data-channel/rtc-data-channel-error-reference-bench.ts',
    'workloads/topology/rtc-topology-star-bench.ts',
    'workloads/topology/rtc-topology-tree-no-rtt-bench.ts',
    'workloads/topology/rtc-topology-mesh-no-rtt-bench.ts',
    'workloads/topology/rtc-room-graph-rtt-bench.ts',
    'workloads/topology/rtc-topology-inactive-churn-bench.ts',
    'workloads/topology/rtc-rtt-repository-filter-bench.ts',
    'workloads/multicast/rtc-multicast-serialization-bench.ts',
    'workloads/group-coordination/webrtc-group-cache-fallback-bench.ts',
    'workloads/group-coordination/webrtc-group-manager-state-bench.ts',
    'workloads/group-coordination/webrtc-group-manager-peer-owners-bench.ts',
    'workloads/group-coordination/webrtc-heartbeat-callback-churn-bench.ts',
    'workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs',
    'topology-delivery/delivery-log-bench.ts',
    'topology-replay/replay-drain-operation-counts.ts',
    'diagnostics/rtc-room-graph-no-rtt-bench.ts',
    'diagnostics/rtc-rtt-group-scan-bench.ts',
    'diagnostics/rtt-traffic/rtc-topology-rtt-traffic-metrics.ts'
] as const;

describe('shared RTC benchmark navigation contract', () => {
    it('documents each executable exactly once and discovers package tests', () => {
        const readme = fs.readFileSync(path.join(packageRoot, 'README.md'), 'utf8');
        const executableCatalogRows = readme
            .split('\n')
            .filter((line) => line.startsWith('|') && line.includes('`'));
        const missingOrDuplicateRows = executablePaths.filter((entry) => {
            const occurrences = executableCatalogRows.filter((row) => row.includes(`\`${entry}\``)).length;
            return occurrences !== 1;
        });
        const vitestConfig = fs.readFileSync(path.join(repoRoot, 'vitest.config.ts'), 'utf8');
        expect(
            missingOrDuplicateRows,
            `missing/duplicate README rows:\n${missingOrDuplicateRows.join('\n')}`
        ).toEqual([]);
        expect(vitestConfig).toContain('packages/shared-rtc-bench/tests/**/*.test.ts');
        expect(readme).toContain('`createRtcPeerConnectionDiagnosticsDependencies`');
        expect(readme).not.toContain('`createRtcPeerConnectionDiagnosticsFakeRuntime`');
        expect(readme).toContain('`QRtcDataChannel.sendJson` queue replacement behavior');
        expect(readme).toContain('Construction, connect, and reset loop');
        for (
            const command of [
                'initialize',
                'capture',
                'list-external-attempts',
                'record-browser',
                'record-external',
                'record-external-cohort',
                'repeat-required',
                'compare-paired',
                'validate',
                'finalize'
            ]
        ) {
            expect(readme).toContain(`\`${command}\``);
        }
    });

    it('keeps diagnostics outside accepted baseline catalog and checked by Deno', () => {
        const catalogPath = path.join(packageRoot, 'baseline/catalog/rtc-baseline-workload-catalog.ts');
        const catalog = fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, 'utf8') : '';
        const packageJson = fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8');
        for (
            const diagnostic of [
                'diagnostics/rtc-room-graph-no-rtt-bench.ts',
                'diagnostics/rtc-rtt-group-scan-bench.ts',
                'diagnostics/rtt-traffic/rtc-topology-rtt-traffic-metrics.ts'
            ]
        ) {
            expect(catalog).not.toContain(diagnostic);
            expect(packageJson).toContain(diagnostic);
        }
    });
});
