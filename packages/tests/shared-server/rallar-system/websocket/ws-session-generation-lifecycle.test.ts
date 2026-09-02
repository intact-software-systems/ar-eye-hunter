import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { validateWsSessionConnectGuard } from '@shared-server/rallar-system/websocket/ws-session-generation-computation.ts';
import { createWsSessionGenerationLifecycleService } from '@shared-server/rallar-system/websocket/ws-session-generation-lifecycle.ts';
import { describe, expect, it } from 'vitest';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';

describe('WebSocket session generation lifecycle persisted state', () => {
    it('computes the serialized write before transaction entry', async () => {
        const lifecycle = createWsSessionGenerationLifecycleService(
            new FakeRuntimeStateRepository()
        );
        const identity = {
            scope: {
                kind: 'client',
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                principalId: 'principal-1',
                clientInstanceId: 'instance-1'
            },
            sessionId: 'session-1'
        } as const;
        const facts = {
            ...identity,
            generationId: 'generation-1',
            generationStartedAtEpochMs: 1_000,
            expireAtEpochMs: 10_000
        } as const;
        const computed = lifecycle.computeConnectGuard(facts, await lifecycle.read(identity));
        expect(computed).toHaveProperty('value', JSON.stringify(computed.state));

        const stringify = JSON.stringify;
        JSON.stringify = () => {
            throw new Error('WebSocket lifecycle serialization must finish during compute');
        };
        try {
            await expect(lifecycle.write(appliedSql(), computed)).resolves.toBeUndefined();
        }
        finally {
            JSON.stringify = stringify;
        }
    });

    it('rejects a lifecycle write projection that differs from compute', async () => {
        const lifecycle = createWsSessionGenerationLifecycleService(
            new FakeRuntimeStateRepository()
        );
        const identity = {
            scope: {
                kind: 'group',
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                principalId: 'principal-1'
            },
            sessionId: 'session-1'
        } as const;
        const facts = {
            ...identity,
            generationId: 'generation-1',
            generationStartedAtEpochMs: 1_000,
            expireAtEpochMs: 10_000
        };
        const read = await lifecycle.read(identity);
        const computed = lifecycle.computeConnectGuard(facts, read);

        expect(() =>
            validateWsSessionConnectGuard(facts, read, {
                ...computed,
                value: `${computed.value} `
            })
        ).toThrow('WebSocket session lifecycle computed result differs');
    });

    it('rejects a version-3 row whose JSON expiry differs from its RuntimeState expiry', async () => {
        const repository = new FakeRuntimeStateRepository();
        const lifecycle = createWsSessionGenerationLifecycleService(repository);
        const identity = {
            scope: {
                kind: 'client',
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                principalId: 'principal-1',
                clientInstanceId: 'instance-1'
            },
            sessionId: 'session-1'
        } as const;
        const key = 'client:app-1:workspace-1:principal-1:instance-1:session-1';
        const value = JSON.stringify({
            version: 3,
            status: 'open',
            ...identity,
            generationId: 'generation-1',
            generationStartedAtEpochMs: 1_000,
            expireAtEpochMs: 10_000
        });
        await repository.upsert('ws-session-close-high-water', key, value, 9_999);

        await expect(lifecycle.read(identity)).rejects.toThrow(
            'WebSocket session close high-water row expiry is invalid'
        );

        expect(
            await repository.findEntry('ws-session-close-high-water', key)
        ).toMatchObject({ value, expireAtTimestamp: 9_999, revision: 0 });
    });

    it('rejects a version-2 row without rewriting or accepting a fallback state', async () => {
        const repository = new FakeRuntimeStateRepository();
        const lifecycle = createWsSessionGenerationLifecycleService(repository);
        const identity = {
            scope: {
                kind: 'client',
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                principalId: 'principal-1',
                clientInstanceId: 'instance-1'
            },
            sessionId: 'session-1'
        } as const;
        const key = 'client:app-1:workspace-1:principal-1:instance-1:session-1';
        const predecessorValue = JSON.stringify({
            version: 2,
            ...identity,
            generationId: 'generation-1',
            generationStartedAtEpochMs: 1_000,
            disconnectedAtEpochMs: 1_100,
            reason: 'socket-closed',
            expireAtEpochMs: 10_000
        });
        await repository.upsert(
            'ws-session-close-high-water',
            key,
            predecessorValue,
            10_000
        );

        await expect(lifecycle.read(identity)).rejects.toThrow(
            'WebSocket session close high-water state is invalid'
        );

        expect(
            await repository.findEntry('ws-session-close-high-water', key)
        ).toMatchObject({
            value: predecessorValue,
            expireAtTimestamp: 10_000,
            revision: 0
        });
    });
});

function appliedSql(): PSqlSql {
    const sql = (
        _stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ..._values: readonly PSqlParameter[]
    ): Promise<readonly Readonly<{ revision: number; }>[]> | object => Promise.resolve([{ revision: 0 }]);
    return sql as PSqlSql;
}
