import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { isIPv4 } from 'node:net';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { sampleNodeClockPair } from './check-node-clock-offset.ts';
import { parseNodeClockProbe } from './parse-node-clock-probe.ts';
import { ApiV1RtcTopologyProofApi } from '../topology-replay/api-v1-rtc-topology-proof-api.mts';
import { runManagedClusterProof } from './run-managed-cluster-proof.mts';
import { qualifySeatDeadline, type SeatDeadlineQualification } from './seat-deadline-qualification.mts';

async function participants(origin: string, users: ConstructorParameters<typeof ApiV1RtcTopologyProofApi>[0]) {
    const api = new ApiV1RtcTopologyProofApi(users);
    const login = (principal: 'alice' | 'bob' | 'admin') => api.login({
        principal, label: principal, apiBaseUrl: origin, wsBaseUrl: origin.replace(/^http/, 'ws')
    });
    const [owner, player, next] = await Promise.all([login('alice'), login('bob'), login('admin')]);
    assert.equal(new Set([owner.clientId, player.clientId, next.clientId]).size, 3);
    return { api, owner, player, next };
}

function setting(name: string) {
    const value = process.env[name];
    assert.ok(value, 'Missing ' + name);
    return value;
}

async function report(input: SeatDeadlineQualification) {
    const result = await qualifySeatDeadline(input);
    console.log(JSON.stringify(result));
    if (result.clock !== 'within') process.exitCode = 1;
}

if (import.meta.main && process.argv[2] === '--direct') {
    assert.equal(process.argv.length, 8, 'Supply two direct origins, their clock identities and a budget');
    const { first, second, calibrationId, enforcementId, budgetMs } = parseNodeClockProbe(process.argv.slice(3));
    for (const origin of [first, second]) {
        const { hostname, protocol } = new URL(origin);
        const loopback = hostname === 'localhost' || hostname === 'localhost.' || hostname === '[::1]' ||
            (isIPv4(hostname) && hostname.startsWith('127.'));
        assert.ok(protocol === 'https:' || loopback, 'Remote seat qualification requires HTTPS on both direct origins');
    }
    assert.notEqual(calibrationId, enforcementId);
    const hook = setting('SEAT_PROOF_WORKER_CONTROL');
    assert.ok(isAbsolute(hook), 'Supply an absolute path to a disposable worker controller');
    const credentials = (role: string) => ({
        username: setting('SEAT_PROOF_' + role + '_USERNAME'), password: setting('SEAT_PROOF_' + role + '_PASSWORD')
    });
    console.log(JSON.stringify({ topology: 'direct-origins', hostIndependence: 'requires-external-provenance',
        claim: { origin: first, peerId: calibrationId }, expiry: { origin: second, peerId: enforcementId }, budgetMs }));
    await sampleNodeClockPair({ origin: first, peerId: calibrationId }, { origin: second, peerId: enforcementId });
    const actors = await participants(first, { alice: credentials('OWNER'), bob: credentials('PLAYER'), admin: credentials('NEXT') });
    const control = async (action: 'stop' | 'start') => {
        try {
            await promisify(execFile)(hook, [action], { timeout: 60_000 });
        } catch {
            throw new Error('Disposable expiry worker control failed: ' + action);
        }
    };
    await report({ claim: { origin: first, peerId: calibrationId }, expiry: { origin: second, peerId: enforcementId },
        budgetMs, databaseUrl: setting('SEAT_PROOF_DATABASE_URL'), ...actors, stopExpiry: () => control('stop'), startExpiry: () => control('start') });
} else if (import.meta.main) {
    await runManagedClusterProof({
        applicationNamePrefix: 'seat-deadline',
        async runScenario({ plans, controls, databaseUrl }) {
            const [expiry, claim] = plans;
            assert.ok(expiry && claim);
            const actors = await participants(claim.baseUrl, { alice: { username: 'alice', password: 'secret' },
                bob: { username: 'bob', password: 'secret' }, admin: { username: 'admin', password: 'admin' } });
            console.log(JSON.stringify({ topology: 'one-host-fixture', budgetMs: 100 }));
            await report({
                claim: { origin: claim.baseUrl, peerId: claim.env.RALLAR_SERVER_CLOCK_PEER_ID! },
                expiry: { origin: expiry.baseUrl, peerId: expiry.env.RALLAR_SERVER_CLOCK_PEER_ID! }, budgetMs: 100,
                databaseUrl, ...actors, stopExpiry: () => controls.stop(expiry.port, 'crash'),
                startExpiry: () => controls.restart(expiry.port, { ...expiry, logPath: expiry.logPath + '.restarted' })
            });
        }
    });
}
