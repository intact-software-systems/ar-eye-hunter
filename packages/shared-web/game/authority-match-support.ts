import type { RallarGameAuthorityRef } from '@shared/rallar-game/mod.ts';
import type { RallarMatchStandingComparator, RallarMatchStandingRow } from '@shared/rallar-match/mod.ts';
import { deriveRallarMatchStandings } from '@shared/rallar-match/mod.ts';
import type {
    RallarGameAuthorityClientConfig,
    RallarGameAuthorityClientHandle,
    RallarGameAuthorityCommandOptions
} from './rallar-game-authority-client-contracts.ts';
import { RallarGameAuthorityClient } from './rallar-game-authority-client.ts';

export interface RallarServerGameAuthorityRef extends RallarGameAuthorityRef {
    readonly kind: 'server';
}

export interface RallarAuthorityBrowserMatchConfig<TCommand, TSnapshot, TEvent, TPresence = unknown>
    extends Omit<RallarGameAuthorityClientConfig<TCommand, TSnapshot, TEvent, TPresence>, 'authority'> {
    readonly authority: RallarServerGameAuthorityRef;
    readonly readStandingRows?: () => readonly RallarMatchStandingRow[];
    readonly compareStandings?: RallarMatchStandingComparator;
}

export interface RallarAuthorityBrowserMatchDependencies<TCommand, TSnapshot, TEvent, TPresence = unknown> {
    readonly createAuthorityClient?: (
        config: RallarGameAuthorityClientConfig<TCommand, TSnapshot, TEvent, TPresence>
    ) => RallarGameAuthorityClientHandle<TCommand, TSnapshot, TEvent, TPresence>;
}

export interface RallarAuthorityBrowserMatchHandle<TCommand, TSnapshot, TEvent, TPresence = unknown> {
    readonly client: RallarGameAuthorityClientHandle<TCommand, TSnapshot, TEvent, TPresence>;
    readonly start: RallarGameAuthorityClientHandle<TCommand, TSnapshot, TEvent, TPresence>['start'];
    readonly stop: RallarGameAuthorityClientHandle<TCommand, TSnapshot, TEvent, TPresence>['stop'];
    readonly status: RallarGameAuthorityClientHandle<TCommand, TSnapshot, TEvent, TPresence>['status'];
    readonly diagnostics: RallarGameAuthorityClientHandle<TCommand, TSnapshot, TEvent, TPresence>['diagnostics'];
    submitCommand(
        command: TCommand,
        options?: RallarGameAuthorityCommandOptions
    ): ReturnType<RallarGameAuthorityClientHandle<TCommand, TSnapshot, TEvent, TPresence>['sendCommand']>;
    standings(): ReturnType<typeof deriveRallarMatchStandings>;
}

export function createRallarAuthorityBrowserMatch<TCommand, TSnapshot, TEvent, TPresence = unknown>(
    config: RallarAuthorityBrowserMatchConfig<TCommand, TSnapshot, TEvent, TPresence>,
    dependencies: RallarAuthorityBrowserMatchDependencies<TCommand, TSnapshot, TEvent, TPresence> = {}
): RallarAuthorityBrowserMatchHandle<TCommand, TSnapshot, TEvent, TPresence> {
    if (config.authority.kind !== 'server') {
        throw new Error(
            'Rallar authority browser matches require server authority.'
        );
    }

    const client = dependencies.createAuthorityClient?.(config) ??
        new RallarGameAuthorityClient(config);
    const deriveStandings = () =>
        deriveRallarMatchStandings({
            rows: config.readStandingRows?.() ?? [],
            compare: config.compareStandings
        });

    return {
        client,
        start: () => client.start(),
        stop: () => client.stop(),
        status: () => client.status(),
        diagnostics: () => client.diagnostics(),
        submitCommand: (command, options) => client.sendCommand(command, options),
        standings: deriveStandings
    };
}
