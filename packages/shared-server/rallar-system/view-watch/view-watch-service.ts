import type { SessionPreviewWatchResult } from '@shared/api/views/view-watch.ts';
import { decodeSessionPreviewWatchResult } from '@shared/api/views/view-watch.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import type { RallarServerAppInbox } from '../../rallar-server/rallar-server-app-inbox.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import { writeRuntimeStateGuardedBatch } from '../../runtime-state/postgres/write-runtime-state-guarded-batch.ts';
import type { AppInboxMessageContext } from '../app-inbox/app-inbox-contracts.ts';
import type { ClientStateRepository } from '../client-state/persistence/client-state-repository.ts';
import { computeSha256CanonicalJson } from '../protocol/compute-sha256-canonical-json.ts';
import { decodeJsonWireValue } from '../protocol/json-wire-identity.ts';
import {
    computeViewWatch,
    type ViewWatchAuthorizer,
    type ViewWatchComputed,
    type ViewWatchRead
} from './compute-view-watch.ts';
import { decodeViewWatchCommand, type ViewWatchCommand } from './view-watch-command.ts';
import type { ViewWatchRepository } from './view-watch-repository.ts';

export namespace ViewWatchService {
    export interface Dependencies {
        readonly appInbox: RallarServerAppInbox;
        readonly repository: ViewWatchRepository;
        readonly clients: Pick<ClientStateRepository, 'listSessionsForPrincipal' | 'findSessionEntry'>;
        readonly authorizer: ViewWatchAuthorizer;
        readonly nowEpochMs: () => number;
    }
}

/** Owns one replaceable selected-view slot; its domain authorizer never decides transport delivery. */
export class ViewWatchService {
    readonly mutate: RallarServerAppInbox.Operation<ViewWatchCommand, SessionPreviewWatchResult>;

    private readonly dependencies: ViewWatchService.Dependencies;

    constructor(dependencies: ViewWatchService.Dependencies) {
        this.dependencies = dependencies;
        this.mutate = dependencies.appInbox.register({
            type: 'app:rallar-view-watch:mutate',
            decodeEnvelope: ({ data }) => decodeViewWatchCommand(data),
            encodeEnvelope: (command) => ({ data: decodeJsonWireValue(command, 'View watch command') }),
            toBinding: (command) => ({
                contextId: computeSha256CanonicalJson({
                    scope: command.scope,
                    sessionId: command.sessionId,
                    family: 'session-preview'
                }),
                resourceId: command.requestId
            }),
            toLogicalCommand: (command) => decodeJsonWireValue(command, 'Logical view watch command'),
            materialize: (command) => command,
            encodeResult: (result) => ({ ...result }),
            decodeResult: decodeSessionPreviewWatchResult,
            handle: (command, context) => this.changeWatch(command, context)
        });
    }

    async read(command: ViewWatchCommand): Promise<ViewWatchRead> {
        const { clients, repository, authorizer } = this.dependencies;
        const [{ auth, previous }, sessions, authorization] = await Promise.all([
            repository.readSession({ ...command.scope, sessionId: command.sessionId }),
            clients.listSessionsForPrincipal({ ...command.scope, principalId: command.principalId }),
            command.request.groupId === null
                ? Promise.resolve(null)
                : authorizer.read({ ...command.scope, groupId: command.request.groupId })
        ]);
        const matching = sessions.filter((session) =>
            session.sessionId === command.sessionId && session.generationId === command.request.connectionGenerationId
        );
        if (matching.length > 1) {
            throw new TypeError('One authenticated socket generation cannot name several client instances');
        }
        const [client, previousResource] = await Promise.all([
            matching[0] === undefined ? Promise.resolve(undefined) : clients.findSessionEntry(matching[0]),
            previous === null ? Promise.resolve(null) : repository.readResource(previous.value)
        ]);
        return {
            command,
            nowEpochMs: this.dependencies.nowEpochMs(),
            auth: auth ?? null,
            client: client ?? null,
            previous,
            previousResource,
            authorization
        };
    }

    private async changeWatch(
        command: ViewWatchCommand,
        context: AppInboxMessageContext<SessionPreviewWatchResult>
    ): Promise<SessionPreviewWatchResult> {
        const read = await this.read(command);
        const computed = computeViewWatch(read);
        if (!jsonEquals(computed, computeViewWatch(read))) {
            throw new TypeError('View watch differs from its complete captured command and reads');
        }
        return await this.dependencies.appInbox.commit(
            context,
            computed.result,
            (transaction) => writeViewWatch(transaction, computed)
        );
    }
}

export async function writeViewWatch(transaction: PSqlSql, computed: ViewWatchComputed): Promise<void> {
    const result = await writeRuntimeStateGuardedBatch(transaction, computed.storage);
    if (result.guard.status !== 'applied' || result.effects.some((effect) => effect.status !== 'applied')) {
        throw new RuntimeStateWriteConflictError();
    }
}
