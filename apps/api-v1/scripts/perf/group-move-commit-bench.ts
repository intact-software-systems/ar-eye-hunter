import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import postgres from 'postgres';

import { createPostgresTimestampWithoutTimeZoneTextType } from '@shared-server/postgres/postgres-timestamp-without-time-zone.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import type { GroupMutationDescriptor } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { toGroupMutationAttemptFacts } from '@shared-server/rallar-system/group-state/mutation/to-group-mutation-attempt-facts.ts';
import { writeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/write/write-group-mutation.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { GroupMoveAction } from '@shared/api/mutation/group-move.ts';

import { toApiV1PostgresClient } from '../../src/db/api-v1-database-lifecycle.ts';
import { API_V1_IN_MEMORY_SCHEMA_URL } from '../../src/db/in-memory-schema-bootstrap.ts';
import { createStateWriteServiceRuntime } from './create-state-write-service-runtime.ts';
import { newRunContext } from './state-write/state-write-measurement.ts';
import {
    createBenchmarkAuthSession,
    requireAppInboxSuccess,
    runAppInboxPumpUntilCompletion
} from './state-write/state-write-workload.ts';

// Diagnostic cohort scaling only. The unchanged state-write comparator remains the regression gate.
const databaseUrl = Deno.env.get('GROUP_MOVE_BENCH_DATABASE_URL');
if (!databaseUrl) {
    throw new Error('GROUP_MOVE_BENCH_DATABASE_URL must explicitly select the diagnostic PostgreSQL database');
}
const output = Deno.args[0];
if (!output) {
    throw new Error('Provide a fresh output JSON path');
}
const schema = `group_move_bench_${crypto.randomUUID().replaceAll('-', '')}`;
const sql = postgres(databaseUrl, {
    max: 4,
    connection: { search_path: schema, jit: 'off' },
    types: { timestampWithoutTimeZone: createPostgresTimestampWithoutTimeZoneTextType() }
});
try {
    await sql.unsafe(`create schema "${schema}"`);
    await sql.unsafe(await readFile(API_V1_IN_MEMORY_SCHEMA_URL, 'utf8'));
    const database = toApiV1PostgresClient(sql, undefined);
    const runtimeRepository = new PSqlRuntimeStateRepository(database);
    const auth = new AuthSessionRepository(runtimeRepository);
    const groupState = createGroupStateService({
        runtimeRepository,
        groupStateEventStore: new PSqlGroupStateEventRepository(database),
        serviceId: 'group-move-bench',
        finishedRetentionMs: 86400000,
        now: Date.now,
        readPlannedLayoutRow: async () => null,
        readAcceptedLayoutRow: async () => null
    });
    const context = newRunContext();
    const runtime = createStateWriteServiceRuntime({
        sql,
        context,
        serviceId: 'group-move-bench-inbox',
        timing: (event) => context.timingEvents.push(event)
    });
    const samples = [];
    for (const sessions of [2, 8, 16]) {
        for (let run = 0; run < 11; run++) {
            const scope = { applicationId: `move-bench-${sessions}-${run}`, workspaceId: 'default' };
            const source = { ...scope, groupId: 'source' };
            const destination = { ...scope, groupId: 'destination' };
            const principals = Array.from({ length: sessions }, (_, index) => `player-${index}`);
            const authorities = new Map([...principals, 'destination-owner'].map((principal) => [
                principal,
                createBenchmarkAuthSession(scope, principal, principal)
            ]));
            for (const authority of authorities.values()) {
                await auth.putSession(authority);
            }
            async function seed(descriptor: GroupMutationDescriptor, principal: string): Promise<void> {
                const authority = authorities.get(principal);
                if (!authority) {
                    throw new Error('Missing seed authority');
                }
                const ingress = await groupState.captureMutationIngress(descriptor, authority);
                const command = {
                    ...ingress,
                    facts: toGroupMutationAttemptFacts({
                        ingressFacts: ingress.facts,
                        attemptCount: 1,
                        laneNowEpochMs: Date.now(),
                        traceId: 'move-bench-seed'
                    })
                };
                const prepared = {
                    command: command.command,
                    facts: command.facts,
                    read: await groupState.read(command)
                };
                const computed = computeGroupMutation(prepared);
                if (computed.outcome !== 'write') {
                    throw new Error('Seed did not write');
                }
                await database.begin((transaction) => writeGroupMutation(transaction, computed));
            }
            for (const [group, owner] of [[source, principals[0]], [destination, 'destination-owner']] as const) {
                await seed(
                    mutationDescriptor({
                        operation: 'createGroup',
                        scope,
                        groupId: group.groupId,
                        request: {
                            requestId: crypto.randomUUID(),
                            groupId: group.groupId,
                            displayName: group.groupId,
                            kind: 'room',
                            joinMode: 'open',
                            maxMembers: sessions + 1,
                            createdByPrincipalId: owner
                        }
                    }),
                    owner
                );
            }
            for (const principal of principals) {
                if (principal !== principals[0]) {
                    await seed(
                        mutationDescriptor({
                            operation: 'joinGroup',
                            scope,
                            groupId: source.groupId,
                            request: {
                                requestId: crypto.randomUUID(),
                                actorPrincipalId: principal,
                                participation: 'player'
                            }
                        }),
                        principal
                    );
                }
                const authority = authorities.get(principal)!;
                const now = Date.now();
                await seed(
                    mutationDescriptor({
                        operation: 'connectPresence',
                        scope,
                        groupId: source.groupId,
                        sessionId: authority.sessionId,
                        request: {
                            requestId: crypto.randomUUID(),
                            actorPrincipalId: principal,
                            principalId: principal,
                            generationId: crypto.randomUUID(),
                            connectionGenerationId: crypto.randomUUID(),
                            connectedAtEpochMs: now,
                            lastHeartbeatAtEpochMs: now,
                            expiresAtEpochMs: now + 120000
                        }
                    }),
                    principal
                );
            }
            const moveId = crypto.randomUUID();
            async function act(action: GroupMoveAction, principal: string): Promise<void> {
                const authority = authorities.get(principal);
                if (!authority) {
                    throw new Error('Missing move authority');
                }
                await runAppInboxPumpUntilCompletion(
                    runtime,
                    runtime.group.processGroupMoveUntilCompletion({
                        traceId: `move-bench-${action}`,
                        request: {
                            requestId: crypto.randomUUID(),
                            moveId,
                            source,
                            destination,
                            action,
                            joinCode: null,
                            inviteToken: null
                        }
                    }, authority).then(requireAppInboxSuccess)
                );
            }
            await act('propose', principals[0]);
            for (const principal of principals) {
                await act('confirm', principal);
            }
            Object.assign(context.sql, newRunContext().sql);
            context.timingEvents.length = 0;
            context.attemptReleases.length = 0;
            const started = performance.now();
            await act('commit', principals[0]);
            const elapsedMs = performance.now() - started;
            const measurement = {
                sessions,
                run,
                elapsedMs,
                sql: { ...context.sql },
                attempts: context.attemptReleases.length,
                phases: context.timingEvents.filter((event) => event.component === 'group-move')
            };
            const recovered = await groupState.move.listForPrincipal(scope, principals[0]);
            const snapshot = await groupState.readSnapshot(destination);
            if (
                recovered[0]?.status !== 'committed' || snapshot?.memberCount !== sessions + 1 ||
                !principals.every((principal) =>
                    snapshot.members.some((member) => member.principalId === principal && member.status === 'active')
                )
            ) {
                throw new Error('Committed cohort or destination readback differs');
            }
            if (run > 0) {
                samples.push(measurement);
            }
        }
    }
    const artifact = {
        schema: 'rallar.group-move-commit-diagnostic.v1',
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
        runtime: Deno.version,
        postgres: (await sql`select version() as version`)[0].version,
        measurement:
            'One warmup and ten commits per cohort; setup and readback excluded, AppInbox pump cleanup included. Serial, no competing workload. Four database connections, JIT off. SQL and release observations from existing state-write instrumentation.',
        samples
    };
    await writeFile(output, JSON.stringify(artifact, null, 2), { flag: 'wx' });
    for (const sessions of [2, 8, 16]) {
        const times = samples.filter((sample) => sample.sessions === sessions).map((sample) => sample.elapsedMs).sort((
            a,
            b
        ) => a - b);
        console.log(
            JSON.stringify({ sessions, count: times.length, medianMs: (times[4] + times[5]) / 2, maxMs: times[9] })
        );
    }
}
finally {
    await sql.unsafe(`drop schema if exists "${schema}" cascade`);
    await sql.end();
}
