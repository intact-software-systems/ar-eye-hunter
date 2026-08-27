import { describe, expect, it } from 'vitest';

import {
    formatNavigationReport,
    navigationClassifications,
    navigationRuleIds,
    scanNavigationProject
} from '../../../scripts/repo-style-check/navigation-rules.mjs';

const repoRoot = '/virtual/repository';
const registryContract = `
    enum AppInboxType {
        GROUP_UPDATE = 'GROUP_UPDATE',
        CLIENT_SESSION_CONNECT = 'CLIENT_SESSION_CONNECT'
    }
    interface AppInboxHandlerRegistry {
        registerHandler(input: {
            readonly type: AppInboxType;
            readonly handle: (input: unknown) => Promise<unknown>;
        }): void;
    }
    declare const registry: AppInboxHandlerRegistry;
`;

describe('IDE causal navigation analyzer', () => {
    it('keeps the observational rule identifiers stable', () => {
        expect(Object.isFrozen(navigationRuleIds)).toBe(true);
        expect(navigationRuleIds).toEqual({
            registrationIndirection: 'navigation.registration-indirection',
            unnamedDeferredEdge: 'navigation.unnamed-deferred-edge',
            interfacePivot: 'navigation.interface-pivot'
        });
    });

    it('keeps the three navigation classifications stable', () => {
        expect(Object.isFrozen(navigationClassifications)).toBe(true);
        expect(navigationClassifications).toEqual({
            highConfidenceFinding: 'high-confidence-finding',
            legitimateBoundary: 'legitimate-boundary',
            manualReview: 'unknown/manual-review'
        });
    });

    it('accepts a concrete AppInbox type with a resolvable named handler', () => {
        const result = scan(`
            ${registryContract}
            async function handleGroupUpdate(input: unknown): Promise<unknown> {
                return input;
            }
            registry.registerHandler({
                type: AppInboxType.GROUP_UPDATE,
                handle: handleGroupUpdate
            });
        `);

        expect(result.findings).toEqual([]);
    });

    it('does not seed navigation from an unrelated registerHandler method', () => {
        const result = scan(`
            interface Plugin { readonly id: string; }
            interface PluginRegistry {
                registerHandler(plugin: Plugin): void;
            }
            declare const registry: PluginRegistry;
            declare const plugin: Plugin;
            registry.registerHandler(plugin);
        `);

        expect(result.findings).toEqual([]);
        expect(result.boundaryFacts).toEqual([]);
        expect(result.diagnostics).toEqual([]);
    });

    it('reports an AppInbox registration hidden behind a generic type loop', () => {
        const result = scan(`
            ${registryContract}
            async function handleMutation(input: unknown): Promise<unknown> {
                return input;
            }
            for (const type of [AppInboxType.GROUP_UPDATE, AppInboxType.CLIENT_SESSION_CONNECT]) {
                registry.registerHandler({ type, handle: handleMutation });
            }
        `);

        expect(ruleIds(result)).toEqual([navigationRuleIds.registrationIndirection]);
    });

    it('accepts a transparent one-call boundary adapter and a named method reference', () => {
        const result = scan(`
            ${registryContract}
            class GroupUpdateHandler {
                async handle(input: unknown): Promise<unknown> {
                    return input;
                }
            }
            const handler = new GroupUpdateHandler();
            registry.registerHandler({
                type: AppInboxType.GROUP_UPDATE,
                handle: async (input) => handler.handle(input)
            });
            registry.registerHandler({
                type: AppInboxType.CLIENT_SESSION_CONNECT,
                handle: handler.handle
            });
        `);

        expect(result.findings).toEqual([]);
    });

    it('reports dynamic callback and table dispatch as an unnamed deferred edge', () => {
        const result = scan(`
            ${registryContract}
            declare const handlers: Record<string, (input: unknown) => Promise<unknown>>;
            const selectedType = AppInboxType.GROUP_UPDATE;
            registry.registerHandler({
                type: AppInboxType.GROUP_UPDATE,
                handle: async (input) => handlers[selectedType](input)
            });
        `);

        expect(ruleIds(result)).toEqual([navigationRuleIds.unnamedDeferredEdge]);
    });

    it('uses Hono app routes as upstream seeds without treating collection methods as routes', () => {
        const routeResult = scan(`
            declare const app: {
                post(path: string, handler: (input: unknown) => Promise<unknown>): void;
            };
            declare const handlers: Record<string, (input: unknown) => Promise<unknown>>;
            app.post('/groups', async (input) => {
                return handlers['GROUP_UPDATE'](input);
            });
        `);
        const collectionResult = scan(`
            declare const cache: {
                get(key: string, loader: (input: unknown) => Promise<unknown>): void;
            };
            declare const handlers: Record<string, (input: unknown) => Promise<unknown>>;
            cache.get('/groups', handlers['GROUP_UPDATE']);
        `);

        expect(ruleIds(routeResult)).toEqual([navigationRuleIds.unnamedDeferredEdge]);
        expect(collectionResult.findings).toEqual([]);
    });

    it('reports a fixed anonymous route inventory erased by mountRest', () => {
        const result = scan(`
            interface App {}
            type RouteInstaller = (app: App) => void;
            interface RouteInstallers {
                readonly rest: readonly RouteInstaller[];
            }
            class Application {
                private restMounted = false;
                constructor(private readonly routeInstallers: RouteInstallers) {}
                mountRest(app: App): void {
                    if (!this.restMounted) {
                        for (const install of this.routeInstallers.rest) {
                            install(app);
                        }
                        this.restMounted = true;
                    }
                }
            }
            function registerGroupRoutes(_app: App): void {}
            function registerClientRoutes(_app: App): void {}
            function createRouteInstallers(): RouteInstallers {
                return {
                    rest: [
                        (app) => registerGroupRoutes(app),
                        (app) => registerClientRoutes(app)
                    ]
                };
            }
            declare const app: App;
            const application = new Application(createRouteInstallers());
            application.mountRest(app);
        `);

        expect(result.findings).toEqual([
            expect.objectContaining({
                ruleId: navigationRuleIds.unnamedDeferredEdge,
                classification: navigationClassifications.highConfidenceFinding
            })
        ]);
    });

    it('proves a fixed inventory across structurally compatible route contracts', () => {
        const result = scan(`
            interface App {}
            type SharedRouteInstaller<TApp> = (app: TApp) => void;
            interface SharedRouteInstallers<TApp> {
                readonly rest: readonly SharedRouteInstaller<TApp>[];
            }
            interface ApiRouteInstallers {
                readonly rest: readonly SharedRouteInstaller<App>[];
            }
            class Application {
                constructor(private readonly routeInstallers: SharedRouteInstallers<App>) {}
                mountRest(app: App): void {
                    for (const install of this.routeInstallers.rest) install(app);
                }
            }
            function registerGroupRoutes(_app: App): void {}
            function createApiRouteInstallers(): ApiRouteInstallers {
                return { rest: [(app) => registerGroupRoutes(app)] };
            }
            const routeInstallers: SharedRouteInstallers<App> = createApiRouteInstallers();
            declare const app: App;
            new Application(routeInstallers).mountRest(app);
        `);

        expect(result.findings).toEqual([
            expect.objectContaining({
                ruleId: navigationRuleIds.unnamedDeferredEdge,
                classification: navigationClassifications.highConfidenceFinding
            })
        ]);
        expect(result.diagnostics).toEqual([]);
    });

    it('leaves multiple structurally compatible inventories for manual review', () => {
        const result = scan(`
            interface App {}
            type SharedRouteInstaller<TApp> = (app: TApp) => void;
            interface SharedRouteInstallers<TApp> {
                readonly rest: readonly SharedRouteInstaller<TApp>[];
            }
            interface ApiRouteInstallers {
                readonly rest: readonly SharedRouteInstaller<App>[];
            }
            class Application {
                constructor(private readonly routeInstallers: SharedRouteInstallers<App>) {}
                mountRest(app: App): void {
                    for (const install of this.routeInstallers.rest) install(app);
                }
            }
            function registerGroupRoutes(_app: App): void {}
            function registerClientRoutes(_app: App): void {}
            function createPrimaryRoutes(): ApiRouteInstallers {
                return { rest: [(app) => registerGroupRoutes(app)] };
            }
            function createSecondaryRoutes(): ApiRouteInstallers {
                return { rest: [(app) => registerClientRoutes(app)] };
            }
            declare const app: App;
            new Application(createPrimaryRoutes()).mountRest(app);
        `);

        expect(result.findings).toEqual([]);
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                classification: navigationClassifications.manualReview
            })
        ]);
    });

    it('follows a transparent wrapper and still reports its fixed anonymous inventory', () => {
        const result = scan(`
            interface App {}
            type RouteInstaller = (app: App) => void;
            function invokeRouteInstallers(
                installers: readonly RouteInstaller[],
                app: App
            ): void {
                for (const install of installers) {
                    install(app);
                }
            }
            function mountRest(app: App, installers: readonly RouteInstaller[]): void {
                invokeRouteInstallers(installers, app);
            }
            function registerGroupRoutes(_app: App): void {}
            function registerClientRoutes(_app: App): void {}
            declare const app: App;
            mountRest(app, [
                (target) => registerGroupRoutes(target),
                (target) => registerClientRoutes(target)
            ]);
        `);

        expect(result.findings).toEqual([
            expect.objectContaining({
                ruleId: navigationRuleIds.unnamedDeferredEdge,
                classification: navigationClassifications.highConfidenceFinding
            })
        ]);
    });

    it('accepts one named aggregate that keeps a fixed route inventory concrete', () => {
        const result = scan(`
            interface App {}
            interface RouteInstallers {
                registerRestRoutes(app: App): void;
            }
            class Application {
                constructor(private readonly routeInstallers: RouteInstallers) {}
                mountRest(app: App): void {
                    this.routeInstallers.registerRestRoutes(app);
                }
            }
            function registerGroupRoutes(_app: App): void {}
            function registerClientRoutes(_app: App): void {}
            function registerRestRoutes(app: App): void {
                registerGroupRoutes(app);
                registerClientRoutes(app);
            }
            const routeInstallers: RouteInstallers = { registerRestRoutes };
            declare const app: App;
            new Application(routeInstallers).mountRest(app);
        `);

        expect(result.findings).toEqual([]);
        expect(result.diagnostics).toEqual([]);
    });

    it('classifies runtime-owned callable collections as legitimate dynamic boundaries', () => {
        const result = scan(`
            type Listener = (event: string) => void;
            type Stop = () => void;
            interface Plugin { install(app: unknown): void; }
            interface Middleware { use(app: unknown): void; }
            interface LifecycleParticipant { attach(): void; }

            const listeners = new Set<Listener>();
            const stops: Stop[] = [];
            const plugins = new Map<string, Plugin>();
            const middleware: Middleware[] = [];
            const participants = new Map<string, LifecycleParticipant>();

            export function subscribe(listener: Listener): void { listeners.add(listener); }
            export function addStop(stop: Stop): void { stops.push(stop); }
            export function registerPlugin(id: string, plugin: Plugin): void { plugins.set(id, plugin); }
            export function registerMiddleware(entry: Middleware): void { middleware.push(entry); }
            export function registerParticipant(id: string, participant: LifecycleParticipant): void {
                participants.set(id, participant);
            }

            export function emit(event: string): void {
                for (const listener of listeners) listener(event);
            }
            export function stopAll(): void {
                for (const stop of stops) stop();
            }
            export function installPlugins(app: unknown): void {
                for (const plugin of plugins.values()) plugin.install(app);
            }
            export function installMiddleware(app: unknown): void {
                for (const entry of middleware) entry.use(app);
            }
            export function attachParticipants(): void {
                for (const participant of participants.values()) participant.attach();
            }
        `);

        expect(result.findings).toEqual([]);
        expect(result.diagnostics).toEqual([]);
        expect(result.boundaryFacts).toHaveLength(5);
        expect(result.boundaryFacts).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    boundaryKind: 'dynamic',
                    classification: navigationClassifications.legitimateBoundary
                })
            ])
        );
    });

    it('classifies named plugin factories as a legitimate declarative boundary', () => {
        const result = scan(`
            interface App {}
            interface Plugin { install(app: App): void; }
            declare const app: App;
            function createAuthPlugin(): Plugin {
                return { install: () => undefined };
            }
            function createLogPlugin(): Plugin {
                return { install: () => undefined };
            }
            const plugins: readonly Plugin[] = [createAuthPlugin(), createLogPlugin()];
            export function installPlugins(): void {
                for (const plugin of plugins) plugin.install(app);
            }
        `);

        expect(result.findings).toEqual([]);
        expect(result.diagnostics).toEqual([]);
        expect(result.boundaryFacts).toEqual([
            expect.objectContaining({
                boundaryKind: 'declarative',
                classification: navigationClassifications.legitimateBoundary
            })
        ]);
    });

    it('does not mistake concrete protocol-object iteration for a callable inventory', () => {
        const result = scan(`
            interface MediaTrack {
                addEventListener(name: string, listener: () => void): void;
            }
            interface DataChannel {
                onRtcCallbacksDo(id: string, callbacks: { onOpen(): void }): void;
            }
            declare function readTracks(): readonly MediaTrack[];
            declare function readChannels(): readonly DataChannel[];
            export function registerEndedCallbacks(): void {
                for (const track of readTracks()) {
                    track.addEventListener('ended', () => undefined);
                }
            }
            export function registerPeerCallbacks(): void {
                for (const channel of readChannels()) {
                    channel.onRtcCallbacksDo('peer', { onOpen: () => undefined });
                }
            }
        `);

        expect(result.findings).toEqual([]);
        expect(result.boundaryFacts).toEqual([]);
        expect(result.diagnostics).toEqual([]);
    });

    it('classifies named declarative callable tables as legitimate boundaries', () => {
        const result = scan(`
            type Validator = (input: string) => readonly string[];
            function validateName(input: string): readonly string[] {
                return input.length > 0 ? [] : ['name'];
            }
            function validateLength(input: string): readonly string[] {
                return input.length < 20 ? [] : ['length'];
            }
            const validators: readonly Validator[] = [validateName, validateLength];
            export function validateAll(input: string): readonly string[] {
                const issues: string[] = [];
                for (const validate of validators) issues.push(...validate(input));
                return issues;
            }
        `);

        expect(result.findings).toEqual([]);
        expect(result.diagnostics).toEqual([]);
        expect(result.boundaryFacts).toEqual([
            expect.objectContaining({
                boundaryKind: 'declarative',
                classification: navigationClassifications.legitimateBoundary
            })
        ]);
    });

    it('reports a fixed anonymous inventory assembled with composition-time push', () => {
        const result = scan(`
            interface App {}
            type RouteInstaller = (app: App) => void;
            declare const app: App;
            function registerGroupRoutes(_app: App): void {}
            function registerClientRoutes(_app: App): void {}
            function createRouteInstallers(): readonly RouteInstaller[] {
                const assembled: RouteInstaller[] = [];
                assembled.push(
                    (target) => registerGroupRoutes(target),
                    (target) => registerClientRoutes(target)
                );
                return assembled;
            }
            const installers = createRouteInstallers();
            export function mountRest(): void {
                for (const install of installers) install(app);
            }
        `);

        expect(result.findings).toEqual([
            expect.objectContaining({
                ruleId: navigationRuleIds.unnamedDeferredEdge,
                classification: navigationClassifications.highConfidenceFinding
            })
        ]);
    });

    it('follows factory parameters used to assemble a fixed anonymous inventory', () => {
        const result = scan(`
            interface App {}
            type RouteInstaller = (app: App) => void;
            declare const app: App;
            function registerGroupRoutes(_app: App): void {}
            function registerClientRoutes(_app: App): void {}
            function createRouteInstallers(
                first: RouteInstaller,
                second: RouteInstaller
            ): readonly RouteInstaller[] {
                const assembled: RouteInstaller[] = [];
                assembled.push(first, second);
                return assembled;
            }
            const installers = createRouteInstallers(
                (target) => registerGroupRoutes(target),
                (target) => registerClientRoutes(target)
            );
            export function mountRest(): void {
                installers.forEach((install) => install(app));
            }
        `);

        expect(result.findings).toEqual([
            expect.objectContaining({
                ruleId: navigationRuleIds.unnamedDeferredEdge,
                classification: navigationClassifications.highConfidenceFinding
            })
        ]);
    });

    it('reports a fixed anonymous inventory invoked through forEach', () => {
        const result = scan(`
            interface App {}
            type RouteInstaller = (app: App) => void;
            declare const app: App;
            function registerGroupRoutes(_app: App): void {}
            function registerClientRoutes(_app: App): void {}
            const installers: readonly RouteInstaller[] = [
                (target) => registerGroupRoutes(target),
                (target) => registerClientRoutes(target)
            ];
            export function mountRest(): void {
                installers.forEach((install) => install(app));
            }
        `);

        expect(result.findings).toEqual([
            expect.objectContaining({
                ruleId: navigationRuleIds.unnamedDeferredEdge,
                classification: navigationClassifications.highConfidenceFinding
            })
        ]);
    });

    it('leaves an unresolved mount inventory for manual review', () => {
        const result = scan(`
            interface App {}
            type RouteInstaller = (app: App) => void;
            declare const installers: readonly RouteInstaller[];
            declare const app: App;
            export function mountRest(): void {
                for (const install of installers) install(app);
            }
            mountRest();
        `);

        expect(result.findings).toEqual([]);
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                classification: navigationClassifications.manualReview
            })
        ]);
    });

    it('reports a type-only business-service pivot with multiple production candidates', () => {
        const result = scan(`
            ${registryContract}
            interface GroupMutationService {
                compute(input: unknown): Promise<unknown>;
            }
            async function firstCompute(input: unknown): Promise<unknown> { return input; }
            async function secondCompute(input: unknown): Promise<unknown> { return input; }
            const firstService: GroupMutationService = {
                compute: firstCompute
            };
            const secondService: GroupMutationService = {
                compute: secondCompute
            };
            declare const service: GroupMutationService;
            async function handleGroupUpdate(input: unknown): Promise<unknown> {
                return service.compute(input);
            }
            registry.registerHandler({
                type: AppInboxType.GROUP_UPDATE,
                handle: handleGroupUpdate
            });
        `);

        expect(ruleIds(result)).toEqual([navigationRuleIds.interfacePivot]);
        expect(result.findings[0]?.message).toContain('GroupMutationService.compute');
        expect(result.findings[0]?.classification).toBe(
            navigationClassifications.manualReview
        );
    });

    it('follows a unique production implementation exposed by Find Usages', () => {
        const result = scan(`
            ${registryContract}
            interface GroupMutationService {
                compute(input: unknown): Promise<unknown>;
            }
            declare const handlers: Record<string, (input: unknown) => Promise<unknown>>;
            async function computeGroupMutation(input: unknown): Promise<unknown> {
                return handlers['GROUP_UPDATE'](input);
            }
            const productionService: GroupMutationService = {
                compute: computeGroupMutation
            };
            declare const service: GroupMutationService;
            async function handleGroupUpdate(input: unknown): Promise<unknown> {
                return service.compute(input);
            }
            registry.registerHandler({
                type: AppInboxType.GROUP_UPDATE,
                handle: handleGroupUpdate
            });
        `);

        expect(ruleIds(result)).toEqual([navigationRuleIds.unnamedDeferredEdge]);
    });

    it('classifies named persistence, writer, and clock contracts as effect boundaries', () => {
        const result = scan(`
            ${registryContract}
            interface RuntimeStateRepositoryLike {
                write(input: unknown): Promise<unknown>;
            }
            interface TransactionWriter {
                commit(input: unknown): Promise<unknown>;
            }
            interface GroupEventStore {
                append(input: unknown): Promise<unknown>;
            }
            interface EnqueueResourceEntryController {
                enqueueOrUpdate(input: unknown): Promise<unknown>;
            }
            interface RuntimeOptions {
                nowEpochMs(): number;
            }
            declare const repository: RuntimeStateRepositoryLike;
            declare const writer: TransactionWriter;
            declare const eventStore: GroupEventStore;
            declare const enqueueController: EnqueueResourceEntryController;
            declare const runtimeOptions: RuntimeOptions;
            async function handleGroupUpdate(input: unknown): Promise<unknown> {
                const durable = await repository.write(input);
                await writer.commit(durable);
                await eventStore.append(durable);
                await enqueueController.enqueueOrUpdate(durable);
                runtimeOptions.nowEpochMs();
                return durable;
            }
            registry.registerHandler({
                type: AppInboxType.GROUP_UPDATE,
                handle: handleGroupUpdate
            });
        `);

        expect(result.findings).toEqual([]);
        expect(result.boundaryFacts.map((fact) => fact.boundary)).toEqual([
            'RuntimeStateRepositoryLike.write',
            'TransactionWriter.commit',
            'GroupEventStore.append',
            'EnqueueResourceEntryController.enqueueOrUpdate',
            'RuntimeOptions.nowEpochMs'
        ]);
        expect(result.boundaryFacts.every((fact) => fact.classification === navigationClassifications.legitimateBoundary)).toBe(true);
    });

    it('accepts visible inline transaction work', () => {
        const result = scan(`
            ${registryContract}
            declare function transaction<T>(work: (tx: {
                read(): Promise<number>;
                write(value: number): Promise<number>;
            }) => Promise<T>): Promise<T>;
            async function handleGroupUpdate(): Promise<unknown> {
                return transaction(async (tx) => {
                    const current = await tx.read();
                    if (current > 0) {
                        return tx.write(current + 1);
                    }
                    return current;
                });
            }
            registry.registerHandler({
                type: AppInboxType.GROUP_UPDATE,
                handle: handleGroupUpdate
            });
        `);

        expect(ruleIds(result)).not.toContain(navigationRuleIds.unnamedDeferredEdge);
    });

    it('follows named functions passed through an Either pipeline', () => {
        const result = scan(`
            ${registryContract}
            type Either<T> = { flatMap<U>(next: (value: T) => Either<U>): Either<U> };
            declare function right<T>(value: T): Either<T>;
            function applyUpdatePolicy(input: unknown): Either<unknown> {
                return right(input);
            }
            async function handleGroupUpdate(input: unknown): Promise<unknown> {
                return right(input).flatMap(applyUpdatePolicy);
            }
            registry.registerHandler({
                type: AppInboxType.GROUP_UPDATE,
                handle: handleGroupUpdate
            });
        `);

        expect(result.findings).toEqual([]);
    });

    it('does not treat standard-library contracts as business-interface pivots', () => {
        const result = scan(`
            ${registryContract}
            function normalizeNames(names: readonly string[]): readonly string[] {
                return names.map((name) => name.trim());
            }
            function copyNames(names: readonly string[]): readonly string[] {
                return names.map((name) => name);
            }
            function toNumbers(values: readonly string[]): readonly number[] {
                return values.map(Number);
            }
            async function handleGroupUpdate(input: unknown): Promise<unknown> {
                const names = normalizeNames(['alpha', 'beta']);
                copyNames(names);
                toNumbers(names);
                return Promise.resolve({ input, names, observedAt: Date.now() });
            }
            registry.registerHandler({
                type: AppInboxType.GROUP_UPDATE,
                handle: handleGroupUpdate
            });
        `);

        expect(result.findings).toEqual([]);
        expect(result.boundaryFacts).toEqual([]);
    });

    it('does not mistake multiple call sites for multiple interface implementations', () => {
        const result = scan(`
            ${registryContract}
            interface Collection {
                map(input: unknown): unknown;
            }
            declare const collection: Collection;
            class FirstConsumer {
                apply(input: unknown): unknown { return collection.map(input); }
            }
            class SecondConsumer {
                apply(input: unknown): unknown { return collection.map(input); }
            }
            const first = new FirstConsumer();
            const second = new SecondConsumer();
            async function handleGroupUpdate(input: unknown): Promise<unknown> {
                return [first.apply(input), second.apply(input)];
            }
            registry.registerHandler({
                type: AppInboxType.GROUP_UPDATE,
                handle: handleGroupUpdate
            });
        `);

        expect(result.findings).toEqual([]);
    });

    it('preserves a concrete callable property through a generic helper parameter', () => {
        const result = scan(`
            ${registryContract}
            interface MutationStrategy {
                write(input: unknown): Promise<unknown>;
            }
            async function runStrategy(
                strategy: MutationStrategy,
                input: unknown
            ): Promise<unknown> {
                return strategy.write(input);
            }
            async function writeGroup(input: unknown): Promise<unknown> { return input; }
            async function writeClient(input: unknown): Promise<unknown> { return input; }
            async function handleGroupUpdate(input: unknown): Promise<unknown> {
                return runStrategy({ write: async (value) => writeGroup(value) }, input);
            }
            async function handleClientConnect(input: unknown): Promise<unknown> {
                return runStrategy({ write: async (value) => writeClient(value) }, input);
            }
            registry.registerHandler({
                type: AppInboxType.GROUP_UPDATE,
                handle: handleGroupUpdate
            });
            registry.registerHandler({
                type: AppInboxType.CLIENT_SESSION_CONNECT,
                handle: handleClientConnect
            });
        `);

        expect(result.findings).toEqual([]);
    });

    it('does not traverse callable implementations outside the repository root', () => {
        const result = scanNavigationProject({
            repoRoot,
            sources: [
                source(
                    '/virtual/dependencies/external.ts',
                    `
                        export declare const handlers: Record<string, () => unknown>;
                        export function externalOperation(): unknown {
                            return handlers['dynamic']();
                        }
                    `
                ),
                source(
                    '/virtual/repository/packages/group.ts',
                    `
                        ${registryContract}
                        import { externalOperation } from '../../dependencies/external';
                        async function handleGroupUpdate(): Promise<unknown> {
                            return externalOperation();
                        }
                        registry.registerHandler({
                            type: AppInboxType.GROUP_UPDATE,
                            handle: handleGroupUpdate
                        });
                    `
                )
            ],
            scanRoots: ['/virtual/repository/packages']
        });

        expect(result.findings).toEqual([]);
        expect(result.diagnostics).toEqual([]);
    });

    it('classifies named callback and decoder strategies as non-business boundaries', () => {
        const result = scan(`
            ${registryContract}
            interface LifecycleCallbacks {
                onClose(input: unknown): Promise<unknown>;
            }
            interface PayloadDecoder {
                decode(input: unknown): unknown;
            }
            interface PayloadCodec {
                encode(input: unknown): unknown;
            }
            type RetryPredicate = (input: unknown) => Promise<unknown>;
            interface RetryOptions {
                readonly retryIf: RetryPredicate;
            }
            const firstCallbacks: LifecycleCallbacks = {
                async onClose(input) { return input; }
            };
            const secondCallbacks: LifecycleCallbacks = {
                async onClose(input) { return input; }
            };
            const firstDecoder: PayloadDecoder = {
                decode(input) { return input; }
            };
            const secondDecoder: PayloadDecoder = {
                decode(input) { return input; }
            };
            const firstCodec: PayloadCodec = {
                encode(input) { return input; }
            };
            const secondCodec: PayloadCodec = {
                encode(input) { return input; }
            };
            const firstRetry: RetryOptions = {
                retryIf: async (input) => input
            };
            const secondRetry: RetryOptions = {
                retryIf: async (input) => input
            };
            declare const callbacks: LifecycleCallbacks;
            declare const decoder: PayloadDecoder;
            declare const codec: PayloadCodec;
            declare const retry: RetryOptions;
            async function handleGroupUpdate(input: unknown): Promise<unknown> {
                const decoded = decoder.decode(input);
                const encoded = codec.encode(decoded);
                await retry.retryIf(encoded);
                return callbacks.onClose(encoded);
            }
            registry.registerHandler({
                type: AppInboxType.GROUP_UPDATE,
                handle: handleGroupUpdate
            });
        `);

        expect(result.findings).toEqual([]);
        expect(result.boundaryFacts).toEqual([
            expect.objectContaining({
                boundary: 'PayloadDecoder.decode',
                boundaryKind: 'translation'
            }),
            expect.objectContaining({
                boundary: 'PayloadCodec.encode',
                boundaryKind: 'translation'
            }),
            expect.objectContaining({
                boundary: 'RetryOptions.retryIf',
                boundaryKind: 'deferred'
            }),
            expect.objectContaining({
                boundary: 'LifecycleCallbacks.onClose',
                boundaryKind: 'deferred'
            })
        ]);
    });

    it('follows aliases and cycles without truncating or duplicating findings', () => {
        const result = scan(`
            ${registryContract}
            async function first(input: unknown): Promise<unknown> {
                return second(input);
            }
            const alias = first;
            async function second(input: unknown): Promise<unknown> {
                if (input === undefined) return input;
                return alias(undefined);
            }
            registry.registerHandler({
                type: AppInboxType.GROUP_UPDATE,
                handle: alias
            });
        `);

        expect(result.findings).toEqual([]);
        expect(result.diagnostics).toEqual([]);
    });

    it('emits a diagnostic rather than a violation at the traversal ceiling', () => {
        const calls = Array.from({ length: 27 }, (_, index) => `function edge${index}(): unknown { return edge${index + 1}(); }`).join('\n');
        const result = scan(`
            ${registryContract}
            ${calls}
            function edge27(): unknown { return undefined; }
            async function handleGroupUpdate(): Promise<unknown> { return edge0(); }
            registry.registerHandler({
                type: AppInboxType.GROUP_UPDATE,
                handle: handleGroupUpdate
            });
        `);

        expect(result.findings).toEqual([]);
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]?.message).toContain('analysis truncated');
    });

    it('filters seeds by repeated report roots and sorts findings deterministically', () => {
        const sources = [
            source('/virtual/repository/packages/zeta.ts', genericRegistration('zeta')),
            source('/virtual/repository/apps/api-v1/src/route.ts', dynamicRegistration()),
            source('/virtual/repository/packages/alpha.ts', genericRegistration('alpha'))
        ];

        const full = scanNavigationProject({ repoRoot, sources });
        const focused = scanNavigationProject({
            repoRoot,
            sources,
            scanRoots: [
                '/virtual/repository/packages',
                '/virtual/repository/apps/api-v1/src'
            ]
        });

        expect(full.findings.map((finding) => finding.file)).toEqual([
            '/virtual/repository/apps/api-v1/src/route.ts',
            '/virtual/repository/packages/alpha.ts',
            '/virtual/repository/packages/zeta.ts'
        ]);
        expect(focused.findings).toEqual(full.findings);
        expect(
            scanNavigationProject({
                repoRoot,
                sources,
                scanRoots: ['/virtual/repository/packages/alpha.ts']
            }).findings.map((finding) => finding.file)
        ).toEqual(['/virtual/repository/packages/alpha.ts']);
    });

    it('caps report details at 200 while preserving complete per-rule counts', () => {
        const sources = Array.from({ length: 205 }, (_, index) =>
            source(
                `/virtual/repository/packages/fixture-${String(index).padStart(3, '0')}.ts`,
                genericRegistration(`fixture${index}`)
            ));
        const result = scanNavigationProject({ repoRoot, sources });
        const output = formatNavigationReport(result, {
            scanRoots: ['/virtual/repository/packages'],
            maximumDetails: 200
        });

        expect(output.match(/NAVIGATION WARN:/gu)).toHaveLength(200);
        expect(output).toContain('5 additional navigation details not displayed');
        expect(output).toContain('navigation.registration-indirection=205');
        expect(output).toContain('[high-confidence-finding]');
        expect(output).toContain(
            'Navigation classifications: high-confidence-finding=205, legitimate-boundary=0, unknown/manual-review=0'
        );
    });

    it('applies the shared detail cap to diagnostics as well as findings and facts', () => {
        const result = scanNavigationProject({ repoRoot, sources: [] });
        const output = formatNavigationReport(
            {
                ...result,
                diagnostics: Array.from({ length: 205 }, (_, index) => ({
                    file: `/virtual/repository/packages/diagnostic-${index}.ts`,
                    line: 1,
                    message: 'analysis truncated'
                }))
            },
            { scanRoots: ['/virtual/repository/packages'], maximumDetails: 200 }
        );

        expect(output.match(/NAVIGATION DIAGNOSTIC:/gu)).toHaveLength(200);
        expect(output).toContain('5 additional navigation details not displayed');
        expect(output).toContain(
            'Navigation classifications: high-confidence-finding=0, legitimate-boundary=0, unknown/manual-review=205'
        );
    });

    it('surfaces project-construction failures as analyzer errors', () => {
        expect(() =>
            scanNavigationProject({
                repoRoot,
                sources: [source('/virtual/repository/packages/group.ts', genericRegistration())],
                tsConfigFilePath: '/path/that/does/not/exist/tsconfig.json'
            })
        ).toThrow();
    });
});

function scan(raw: string) {
    return scanNavigationProject({
        repoRoot,
        sources: [source('/virtual/repository/packages/group.ts', raw)]
    });
}

function source(file: string, raw: string) {
    return { file, raw };
}

function ruleIds(result: ReturnType<typeof scanNavigationProject>): string[] {
    return result.findings.map((finding) => finding.ruleId);
}

function genericRegistration(label = 'mutation'): string {
    return `
        ${registryContract}
        async function handle${label}(input: unknown): Promise<unknown> { return input; }
        for (const type of [AppInboxType.GROUP_UPDATE]) {
            registry.registerHandler({ type, handle: handle${label} });
        }
    `;
}

function dynamicRegistration(): string {
    return `
        ${registryContract}
        declare const handlers: Record<string, (input: unknown) => Promise<unknown>>;
        registry.registerHandler({
            type: AppInboxType.GROUP_UPDATE,
            handle: async (input) => handlers[AppInboxType.GROUP_UPDATE](input)
        });
    `;
}
