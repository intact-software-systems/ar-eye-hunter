import type { AdminPruneExpiredCategory } from '@shared/api/admin-operations-types.ts';
import type { AdminRoomDirectoryResponse } from '@shared/api/admin-rooms/admin-room-directory.ts';
import type { AdminRoomTopologyWorkResponse } from '@shared/api/admin-rooms/admin-room-topology-work.ts';
import type { AdminPruneEnqueueResult } from '@shared/api/admin-rooms/decode-admin-prune-result.ts';
import type { TopologyReconfigureInboxResult } from '@shared/api/admin-rooms/decode-topology-inbox-result.ts';
import type { AdminSupportNarrativeResponse } from '@shared/api/admin-support/admin-support-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { startRepeating } from '@shared/resilience/timing/start-repeating.ts';
import { AuthenticatedResource } from '../api/authenticated-resource.ts';
import {
    pruneAdminExpiredRecords,
    readAdminRoomDirectory,
    readAdminRoomExplanation,
    readAdminRoomTopologyWork,
    recomputeAdminRoomTopology
} from './admin-room-http-api.ts';

export namespace AdminRoomOperations {
    export type Action =
        | { readonly kind: 'recompute'; }
        | {
            readonly kind: 'preview-maintenance';
            readonly categories: readonly Exclude<AdminPruneExpiredCategory, 'app-data'>[];
        }
        | { readonly kind: 'execute-maintenance'; readonly previewRequestId: string; };

    export interface TopologyOutcome {
        readonly receipt: TopologyReconfigureInboxResult;
        readonly work: AdminRoomTopologyWorkResponse;
    }
    export interface MaintenanceOutcome {
        readonly requestId: string;
        readonly result: AdminPruneEnqueueResult;
    }
    export interface View {
        readonly directory: AdminRoomDirectoryResponse;
        readonly explanation: AdminSupportNarrativeResponse | null;
        readonly topology: TopologyOutcome | null;
        readonly maintenance: MaintenanceOutcome | null;
    }
    export interface Config {
        readonly scope: StateScope;
        readonly refreshIntervalMs: number;
        readonly apiBaseUrl: string;
        readonly afterGroupId: string | null;
        readonly selectedGroupId: string | null;
    }
    export interface Accepted<Result> {
        readonly signal: AbortSignal;
        readonly result: Result;
    }
}

/** Coordinates existing admin commands; the authenticated resource owns request retry and account fencing. */
export class AdminRoomOperations extends AuthenticatedResource<AdminRoomOperations.View, AdminRoomOperations.Action> {
    private readonly roomConfig: AdminRoomOperations.Config;
    private topology: AdminRoomOperations.Accepted<TopologyReconfigureInboxResult> | null = null;
    private maintenance: AdminRoomOperations.Accepted<AdminRoomOperations.MaintenanceOutcome> | null = null;

    constructor(dependencies: AuthenticatedResource.Dependencies, config: AdminRoomOperations.Config) {
        super(dependencies, {
            scope: config.scope,
            changeResult: 'read',
            subscribeRefresh: (run) =>
                startRepeating({
                    timers: dependencies.timers,
                    intervalMs: config.refreshIntervalMs,
                    firstRun: 'after-interval',
                    run
                })
        }, { read: (input) => this.read(input), change: (input) => this.change(input) });
        this.roomConfig = config;
    }

    private async read(input: AuthenticatedResource.ReadInput): Promise<AdminRoomOperations.View> {
        const config = this.roomConfig;
        const context = { apiBaseUrl: config.apiBaseUrl, session: input.session, signal: input.signal };
        const receipt = this.topology?.signal === input.signal ? this.topology.result : null;
        // Observe the exact work first so subsequent room reads follow its terminal settlement.
        const topology = receipt === null ? null : {
            receipt,
            work: await readAdminRoomTopologyWork({ ...context, roomRef: receipt.groupRef, outboxId: receipt.outboxId })
        };
        const [directory, explanation] = await Promise.all([
            readAdminRoomDirectory({ ...context, scope: input.scope, afterGroupId: config.afterGroupId, limit: 50 }),
            config.selectedGroupId === null ? Promise.resolve(null) : readAdminRoomExplanation({
                ...context,
                roomRef: { ...input.scope, groupId: config.selectedGroupId }
            })
        ]);
        const maintenance = this.maintenance?.signal === input.signal ? this.maintenance.result : null;
        return { directory, explanation, topology, maintenance };
    }

    private async change(input: AuthenticatedResource.ChangeInput<AdminRoomOperations.Action>): Promise<string | null> {
        switch (input.request.kind) {
            case 'recompute':
                return this.recompute(input);
            case 'preview-maintenance':
                return this.prune(input, input.request.categories, true);
            case 'execute-maintenance': {
                const preview = this.maintenance?.signal === input.signal ? this.maintenance.result : null;
                if (
                    preview === null || preview.requestId !== input.request.previewRequestId ||
                    preview.result.status !== 'dry-run'
                ) {
                    return 'Run a new global maintenance preview before executing cleanup.';
                }
                const categories = preview.result.results.map((entry) => entry.category);
                if (categories.some((category) => category === 'app-data')) {
                    throw new TypeError('Global maintenance cannot prune app data');
                }
                return this.prune(input, categories.filter((category) => category !== 'app-data'), false);
            }
        }
    }

    private async recompute(
        input: AuthenticatedResource.ChangeInput<AdminRoomOperations.Action>
    ): Promise<string | null> {
        const groupId = this.roomConfig.selectedGroupId;
        if (groupId === null) {
            return 'Select a valid room before recomputing topology.';
        }
        if (this.getState().view?.topology?.work.status === 'pending') {
            return 'The previous topology work is still pending.';
        }
        const result = await recomputeAdminRoomTopology({
            ...input,
            apiBaseUrl: this.roomConfig.apiBaseUrl,
            roomRef: { ...input.scope, groupId }
        });
        if (this.current(input)) {
            this.topology = { signal: input.signal, result };
        }
        return null;
    }

    private async prune(
        input: AuthenticatedResource.ChangeInput<AdminRoomOperations.Action>,
        categories: readonly Exclude<AdminPruneExpiredCategory, 'app-data'>[],
        dryRun: boolean
    ): Promise<string | null> {
        if (categories.length === 0 || new Set(categories).size !== categories.length) {
            return 'Choose at least one distinct global maintenance category.';
        }
        const result = await pruneAdminExpiredRecords({
            ...input,
            apiBaseUrl: this.roomConfig.apiBaseUrl,
            categories,
            dryRun
        });
        if (this.current(input)) {
            this.maintenance = { signal: input.signal, result: { requestId: input.requestId, result } };
        }
        return null;
    }
}
