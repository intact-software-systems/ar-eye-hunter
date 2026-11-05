import type { ViewWatchFamily, ViewWatchResult } from '@shared/api/views/view-watch.ts';
import { decodeViewWatchResult } from '@shared/api/views/view-watch.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import type { RallarServerAppInbox } from '../../rallar-server/rallar-server-app-inbox.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import { readRuntimeStateObservationsCurrent } from '../../runtime-state/postgres/read-runtime-state-observations-current.ts';
import { writeRuntimeStateGuardedBatch } from '../../runtime-state/postgres/write-runtime-state-guarded-batch.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/runtime-state-json-store.ts';
import type { AppInboxMessageContext } from '../app-inbox/app-inbox-contracts.ts';
import type { ClientStateRepository } from '../client-state/persistence/client-state-repository.ts';
import { computeSha256CanonicalJson } from '../protocol/compute-sha256-canonical-json.ts';
import { decodeJsonWireValue } from '../protocol/json-wire-identity.ts';
import {
    computeViewWatch,
    type ViewWatchAuthorizer,
    type ViewWatchComputed,
    type ViewWatchPredecessor,
    type ViewWatchRead
} from './compute-view-watch.ts';
import { validateViewWatch } from './validate-view-watch.ts';
import { decodeViewWatchCommand, type ViewWatchCommand } from './view-watch-command.ts';
import type { ViewWatchRegistration, ViewWatchRepository } from './view-watch-repository.ts';

export namespace ViewWatchService {
    export interface Dependencies {
        readonly appInbox: RallarServerAppInbox;
        readonly repository: ViewWatchRepository;
        readonly clients: Pick<ClientStateRepository, 'listSessionsForPrincipal' | 'findSessionEntry'>;
        readonly authorizers: Readonly<Record<ViewWatchFamily, ViewWatchAuthorizer>>;
        readonly nowEpochMs: () => number;
    }
}

export class ViewWatchAuthorizationError extends Error {
    readonly code = 'view-watch-authority-denied';
    readonly status = 403;
}

/** Owns one replaceable selected-view slot; its domain authorizer never decides transport delivery. */
export class ViewWatchService {
    readonly mutate: RallarServerAppInbox.Operation<ViewWatchCommand, ViewWatchResult>;

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
                    family: command.family
                }),
                resourceId: command.requestId
            }),
            toLogicalCommand: (command) => decodeJsonWireValue(command, 'Logical view watch command'),
            materialize: (command) => command,
            encodeResult: (result) => ({ ...result }),
            decodeResult: decodeViewWatchResult,
            handle: (command, context) => this.changeWatch(command, context)
        });
    }

    async read(command: ViewWatchCommand): Promise<ViewWatchRead> {
        const { clients, repository, authorizers } = this.dependencies;
        const authorizer = authorizers[command.family];
        const [{ auth, previous }, sessions, authorization] = await Promise.all([
            repository.readSession({ ...command.scope, sessionId: command.sessionId, family: command.family }),
            clients.listSessionsForPrincipal({ ...command.scope, principalId: command.principalId }),
            command.request.resourceId === null
                ? Promise.resolve(null)
                : authorizer.read({
                    ...command.scope,
                    family: command.family,
                    resourceId: command.request.resourceId
                }, { expiresAtEpochMs: command.sessionExpiresAtEpochMs, changeId: computeSha256CanonicalJson(command) })
        ]);
        const matching = sessions.filter((session) =>
            session.sessionId === command.sessionId && session.generationId === command.request.connectionGenerationId
        );
        if (matching.length > 1) {
            throw new TypeError('One authenticated socket generation cannot name several client instances');
        }
        const [client, predecessor, release] = await Promise.all([
            matching[0] === undefined ? Promise.resolve(undefined) : clients.findSessionEntry(matching[0]),
            previous === null ? Promise.resolve(null) : readViewWatchPredecessor(repository, previous),
            previous === null || previous.value.resourceId === command.request.resourceId
                ? Promise.resolve(null)
                : authorizer.readRelease(previous.value)
        ]);
        const read = {
            command,
            nowEpochMs: this.dependencies.nowEpochMs(),
            auth: auth ?? null,
            client: client ?? null,
            predecessor,
            authorization,
            release
        };
        assertViewWatchRead(read);
        return read;
    }

    private async changeWatch(
        command: ViewWatchCommand,
        context: AppInboxMessageContext<ViewWatchResult>
    ): Promise<ViewWatchResult> {
        const validated = validateViewWatch(await this.read(command));
        if (validated.right === undefined) {
            throw new ViewWatchAuthorizationError((validated.left ?? []).map(({ message }) => message).join('; '));
        }
        const computed = computeViewWatch(validated.right);
        return await this.dependencies.appInbox.commit(
            context,
            computed.result,
            (transaction) => writeViewWatch(transaction, computed)
        );
    }
}

async function readViewWatchPredecessor(
    repository: ViewWatchRepository,
    slot: RuntimeStateEntryValue<ViewWatchRegistration>
): Promise<ViewWatchPredecessor> {
    const resource = await repository.readResource(slot.value);
    if (resource === null || !jsonEquals(slot.value, resource.value)) {
        throw new TypeError('View watch slot and resource lookup differ');
    }
    return { slot, resource };
}

/** Stored identity is an invariant of the slot key; only session currency and availability are refusals. */
function assertViewWatchRead(read: ViewWatchRead): void {
    const { command, predecessor, authorization } = read;
    const previous = predecessor?.slot.value;
    if (
        previous !== undefined &&
        (previous.family !== command.family || previous.principalId !== command.principalId ||
            previous.sessionId !== command.sessionId ||
            previous.sessionIssuedAtEpochMs !== command.sessionIssuedAtEpochMs ||
            previous.applicationId !== command.scope.applicationId ||
            previous.workspaceId !== command.scope.workspaceId)
    ) {
        throw new TypeError('View watch predecessor belongs to another authenticated identity');
    }
    if (
        authorization !== null && (
            authorization.resource.resourceId !== command.request.resourceId ||
            authorization.resource.family !== command.family ||
            authorization.resource.applicationId !== command.scope.applicationId ||
            authorization.resource.workspaceId !== command.scope.workspaceId
        )
    ) {
        throw new TypeError('View watch authority names another preview');
    }
}

/** The slot rows commit only while the observed session, generation and slot still hold. */
export async function writeViewWatch(transaction: PSqlSql, computed: ViewWatchComputed): Promise<void> {
    if (computed.storage !== null) {
        const result = await writeRuntimeStateGuardedBatch(transaction, computed.storage);
        if (result.guard.status !== 'applied' || result.effects.some((effect) => effect.status !== 'applied')) {
            throw new RuntimeStateWriteConflictError();
        }
    }
    if (!(await readRuntimeStateObservationsCurrent(transaction, computed.observations))) {
        throw new RuntimeStateWriteConflictError();
    }
}
