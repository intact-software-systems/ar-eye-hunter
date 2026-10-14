import { parseRtcCaptureMode, resolveRtcCaptureConfiguration } from '@shared/webrtc/rtc-capture-configuration.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import { isRallarMessagePayload } from '../../black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts';
import { resolveBlackBoxRallarCrdtTransport } from '../../black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts';
import { isRallarSignalingWebSocketMessage } from '../browser/browser-command-values.ts';
import type {
    RallarBlackBoxDistributedRunRecipeSelection
} from '../distributed-run.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestCrdtOpenCommand,
    RallarBlackBoxTestParallelCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRecipeRunCommand
} from '../rallar-black-box-test-contracts.ts';
import { toMergedRuntimeConfig } from '../runtime/to-merged-runtime-config.ts';
import { RecipeCaptureSequence } from './recipe-capture-sequence.ts';

export namespace RecipeCaptureRequirements {
    export interface Entry {
        readonly command: RallarBlackBoxTestCommand;
        readonly modes: readonly RtcSignalingDiagnostics.CaptureMode[];
    }

    export interface Input {
        readonly selections: readonly RallarBlackBoxDistributedRunRecipeSelection[];
        readonly run: RtcSignalingDiagnostics.CaptureMode | undefined;
    }

    export interface Analysis {
        readonly entries: readonly Entry[];
        readonly references: ReadonlyMap<RallarBlackBoxTestRecipeRunCommand, ReadonlySet<RallarBlackBoxTestRecipe>>;
    }

    export interface ParallelScope {
        readonly inherited: readonly (RallarBlackBoxTestConfig | undefined)[];
        readonly recorded: Map<RallarBlackBoxTestConfig, RallarBlackBoxTestConfig>;
        readonly inheritedRecipes: readonly RallarBlackBoxTestRecipe[];
        readonly recordedRecipes: Set<RallarBlackBoxTestRecipe>;
    }

    export interface ParallelScopeInput {
        readonly parent: ParallelScope | undefined;
        readonly configurations: readonly Map<RallarBlackBoxTestConfig, RallarBlackBoxTestConfig>[];
        readonly recipes: readonly Set<RallarBlackBoxTestRecipe>[];
        readonly index: number;
    }

    export interface TraversalState {
        readonly config: RallarBlackBoxTestConfig | undefined;
        readonly alternatives: readonly (RallarBlackBoxTestConfig | undefined)[] | undefined;
        readonly loadedRecipe: RallarBlackBoxTestRecipe | undefined;
        readonly loadedAlternatives: readonly (RallarBlackBoxTestRecipe | undefined)[] | undefined;
        readonly parallelScope: ParallelScope | undefined;
    }

    export interface ParallelAnalysis {
        readonly groups: RallarBlackBoxTestParallelCommand['groups'];
        readonly sequence: RecipeCaptureSequence;
        readonly initial: TraversalState;
        readonly configurations: readonly Map<RallarBlackBoxTestConfig, RallarBlackBoxTestConfig>[];
        readonly recipes: readonly Set<RallarBlackBoxTestRecipe>[];
        readonly finalConfigurations: Set<RallarBlackBoxTestConfig | undefined>;
        readonly finalRecipes: Set<RallarBlackBoxTestRecipe | undefined>;
    }

    export interface ReferenceFrame {
        readonly recipe: RallarBlackBoxTestRecipe;
        readonly selection: RecipeCaptureSequence.Selection;
        readonly configSource: RallarBlackBoxTestConfig | undefined;
        readonly alternativeSources: readonly (RallarBlackBoxTestConfig | undefined)[] | undefined;
        readonly siblingSources: readonly (RallarBlackBoxTestConfig | undefined)[];
        readonly loadedRecipe: RallarBlackBoxTestRecipe | undefined;
        readonly loadedAlternatives: readonly (RallarBlackBoxTestRecipe | undefined)[] | undefined;
        readonly siblingRecipes: readonly RallarBlackBoxTestRecipe[];
        readonly discovering: boolean;
    }
}

/** Follows executable capture sequences without choosing precedence or inventing product defaults. */
export class RecipeCaptureRequirements {
    private readonly requirements = new Map<RallarBlackBoxTestCommand, Set<RtcSignalingDiagnostics.CaptureMode>>();
    private readonly references = new Map<RallarBlackBoxTestRecipeRunCommand, Set<RallarBlackBoxTestRecipe>>();
    private config: RallarBlackBoxTestConfig | undefined;
    private configurationAlternatives: readonly (RallarBlackBoxTestConfig | undefined)[] | undefined;
    private parallelScope: RecipeCaptureRequirements.ParallelScope | undefined;
    private collectingParallelConfigurations = 0;
    private loadedRecipe: RallarBlackBoxTestRecipe | undefined;
    private loadedRecipeAlternatives: readonly (RallarBlackBoxTestRecipe | undefined)[] | undefined;
    private configurationSources = new WeakMap<RallarBlackBoxTestConfig, RallarBlackBoxTestConfig>();
    private readonly activeReferences: RecipeCaptureRequirements.ReferenceFrame[] = [];

    collect(input: RecipeCaptureRequirements.Input): readonly RtcSignalingDiagnostics.CaptureMode[] {
        return [...new Set(this.analyze(input).entries.flatMap((entry) => entry.modes))].sort();
    }

    analyze(input: RecipeCaptureRequirements.Input): RecipeCaptureRequirements.Analysis {
        this.requirements.clear();
        this.references.clear();
        this.config = undefined;
        this.configurationAlternatives = undefined;
        this.parallelScope = undefined;
        this.collectingParallelConfigurations = 0;
        this.loadedRecipe = undefined;
        this.loadedRecipeAlternatives = undefined;
        this.configurationSources = new WeakMap();
        this.activeReferences.length = 0;
        for (const selection of input.selections) {
            const sequence = new RecipeCaptureSequence({ run: input.run, recipe: undefined, step: undefined });
            if (selection.recipe) {
                this.visitKnownRecipe(selection.recipe, sequence.forRecipe(selection.recipe, undefined));
            }
            else if (input.run !== undefined) {
                // A reference cannot certify that an explicit capture request has no relevant SDK work.
                this.require({ kind: 'recipe.run', rtcCaptureMode: input.run }, sequence.get(), input.run);
            }
        }
        return {
            entries: [...this.requirements].map(([command, modes]) => ({ command, modes: [...modes].sort() })),
            references: new Map(this.references)
        };
    }

    private visit(commands: readonly RallarBlackBoxTestCommand[], sequence: RecipeCaptureSequence): void {
        for (const command of commands) {
            switch (command.kind) {
                case 'configure':
                    sequence.configure(command.config);
                    this.config = toMergedRuntimeConfig(this.config, command.config);
                    // Only auth/lifecycle fields inherit; capture routing retains this authored Configure origin.
                    this.configurationSources.set(this.config, command.config);
                    this.configurationAlternatives = undefined;
                    this.parallelScope?.recorded.set(command.config, this.config);
                    break;
                case 'recipe.load':
                    this.loadedRecipe = command.recipe;
                    this.loadedRecipeAlternatives = undefined;
                    this.parallelScope?.recordedRecipes.add(command.recipe);
                    break;
                case 'recipe.run':
                    this.visitRecipeReference(command, sequence);
                    break;
                case 'loop':
                    this.visit(command.commands, sequence);
                    // The next iteration may inherit a Configure from the previous one.
                    if ((command.count ?? 2) > 1) {
                        this.visit(command.commands, sequence);
                    }
                    break;
                case 'parallel':
                    this.visitParallel(command, sequence);
                    break;
                case 'rtc.connect':
                    this.require(
                        command,
                        sequence.get(),
                        parseRtcCaptureMode(command.rallar?.rtcCaptureMode).right?.mode
                    );
                    break;
                case 'crdt.open':
                    if (this.mayUseNonlocalCrdtTransport(command)) {
                        this.require(
                            command,
                            sequence.get(),
                            parseRtcCaptureMode(command.rallar?.rtcCaptureMode).right?.mode
                        );
                    }
                    break;
                case 'ws.send': {
                    const data = command.data;
                    if (
                        isRallarMessagePayload(data) &&
                        this.possibleConfigurations().some((config) => isRallarSignalingWebSocketMessage(data, config))
                    ) {
                        this.require(command, sequence.get(), undefined);
                    }
                    break;
                }
            }
        }
    }

    /** Unverified transport cannot certify local-only work; omitted transport retains its local default. */
    private mayUseNonlocalCrdtTransport(command: RallarBlackBoxTestCrdtOpenCommand): boolean {
        return this.possibleConfigurations().some((config) => {
            const rallar = { ...config?.rallar, ...command.rallar };
            const selected = resolveBlackBoxRallarCrdtTransport({
                transport: command.transport,
                crdtTransport: rallar.crdtTransport
            });
            return selected.fold(
                () => true,
                ({ transport }) => transport !== undefined && transport !== 'local-only'
            );
        });
    }

    private possibleConfigurations(): readonly (RallarBlackBoxTestConfig | undefined)[] {
        return [...(this.parallelScope?.inherited ?? []), ...(this.configurationAlternatives ?? [this.config])];
    }

    private possibleLoadedRecipes(): readonly (RallarBlackBoxTestRecipe | undefined)[] {
        return [
            ...new Set([
                ...(this.parallelScope?.inheritedRecipes ?? []),
                ...(this.loadedRecipeAlternatives ?? [this.loadedRecipe])
            ])
        ];
    }

    private configurationSource(config: RallarBlackBoxTestConfig | undefined): RallarBlackBoxTestConfig | undefined {
        return config === undefined ? undefined : this.configurationSources.get(config) ?? config;
    }

    private visitKnownRecipe(recipe: RallarBlackBoxTestRecipe, sequence: RecipeCaptureSequence): void {
        const frame: RecipeCaptureRequirements.ReferenceFrame = {
            recipe,
            selection: sequence.get(),
            configSource: this.configurationSource(this.config),
            alternativeSources: this.configurationAlternatives?.map((config) => this.configurationSource(config)),
            siblingSources: (this.parallelScope?.inherited ?? []).map((config) => this.configurationSource(config)),
            loadedRecipe: this.loadedRecipe,
            loadedAlternatives: this.loadedRecipeAlternatives,
            siblingRecipes: this.parallelScope?.inheritedRecipes ?? [],
            discovering: this.collectingParallelConfigurations > 0
        };
        const repeated = this.activeReferences.some((active) =>
            active.recipe === frame.recipe && active.configSource === frame.configSource &&
            active.loadedRecipe === frame.loadedRecipe && active.discovering === frame.discovering &&
            active.selection.run === frame.selection.run && active.selection.recipe === frame.selection.recipe &&
            active.selection.step === frame.selection.step &&
            this.hasSameSources(active.alternativeSources, frame.alternativeSources) &&
            this.hasSameSources(active.siblingSources, frame.siblingSources) &&
            this.hasSameSources(active.loadedAlternatives, frame.loadedAlternatives) &&
            this.hasSameSources(active.siblingRecipes, frame.siblingRecipes)
        );
        if (repeated) {
            return;
        }
        this.activeReferences.push(frame);
        try {
            this.visit(recipe.commands, sequence);
        }
        finally {
            this.activeReferences.pop();
        }
    }

    private hasSameSources(
        left: readonly (RallarBlackBoxTestConfig | RallarBlackBoxTestRecipe | undefined)[] | undefined,
        right: readonly (RallarBlackBoxTestConfig | RallarBlackBoxTestRecipe | undefined)[] | undefined
    ): boolean {
        if (left === undefined || right === undefined) {
            return left === right;
        }
        return left.every((value) => right.includes(value)) && right.every((value) => left.includes(value));
    }

    private visitRecipeReference(command: RallarBlackBoxTestRecipeRunCommand, sequence: RecipeCaptureSequence): void {
        if (command.recipe) {
            this.visitKnownRecipe(command.recipe, sequence.forRecipe(command.recipe, command.rtcCaptureMode));
            return;
        }
        const initial = this.snapshotTraversalState();
        const recipes = this.possibleLoadedRecipes();
        if (this.collectingParallelConfigurations === 0) {
            const bodies = this.references.get(command) ?? new Set<RallarBlackBoxTestRecipe>();
            recipes.forEach((recipe) => {
                if (recipe !== undefined) {
                    bodies.add(recipe);
                }
            });
            this.references.set(command, bodies);
        }
        const configurations = new Set<RallarBlackBoxTestConfig | undefined>();
        const loaded = new Set<RallarBlackBoxTestRecipe | undefined>();
        try {
            for (const recipe of recipes) {
                this.restoreTraversalState(initial);
                this.loadedRecipe = recipe;
                this.loadedRecipeAlternatives = undefined;
                if (recipe) {
                    this.visitKnownRecipe(recipe, sequence.forRecipe(recipe, command.rtcCaptureMode));
                }
                else {
                    this.require(command, sequence.get(), command.rtcCaptureMode);
                }
                (this.configurationAlternatives ?? [this.config]).forEach((value) => configurations.add(value));
                (this.loadedRecipeAlternatives ?? [this.loadedRecipe]).forEach((value) => loaded.add(value));
            }
        }
        finally {
            this.restoreTraversalState(initial);
        }
        this.config = configurations.values().next().value;
        this.configurationAlternatives = configurations.size > 1 ? [...configurations] : undefined;
        this.loadedRecipe = loaded.values().next().value;
        this.loadedRecipeAlternatives = loaded.size > 1 ? [...loaded] : undefined;
    }

    private visitParallel(command: RallarBlackBoxTestParallelCommand, sequence: RecipeCaptureSequence): void {
        if (command.groups.length <= 1 || command.maxConcurrency === 1) {
            command.groups.forEach((group) => this.visit(group.commands, sequence.fork()));
            return;
        }
        const analysis: RecipeCaptureRequirements.ParallelAnalysis = {
            groups: command.groups,
            sequence,
            initial: this.snapshotTraversalState(),
            configurations: command.groups.map(() => new Map()),
            recipes: command.groups.map(() => new Set()),
            finalConfigurations: new Set(),
            finalRecipes: new Set()
        };
        // Configure and loaded bodies are shared; capture selection and source order belong to each branch.
        this.discoverParallelWrites(analysis);
        if (this.collectingParallelConfigurations === 0) {
            analysis.groups.forEach((_, index) => this.visitParallelBranch(analysis, index));
        }
        this.applyParallelContinuation(analysis);
    }

    /** Settle finite authored source membership before authoritative capture classification. */
    private discoverParallelWrites(analysis: RecipeCaptureRequirements.ParallelAnalysis): void {
        this.collectingParallelConfigurations += 1;
        let previousSize: number;
        let size = 0;
        try {
            do {
                previousSize = size;
                analysis.finalConfigurations.clear();
                analysis.finalRecipes.clear();
                analysis.groups.forEach((_, index) => {
                    const final = this.visitParallelBranch(analysis, index);
                    if (analysis.configurations[index].size > 0) {
                        (final.alternatives ?? [final.config]).forEach((value) =>
                            analysis.finalConfigurations.add(value)
                        );
                    }
                    if (analysis.recipes[index].size > 0) {
                        (final.loadedAlternatives ?? [final.loadedRecipe]).forEach((value) =>
                            analysis.finalRecipes.add(value)
                        );
                    }
                });
                size = analysis.configurations.reduce((total, values) => total + values.size, 0) +
                    analysis.recipes.reduce((total, values) => total + values.size, 0);
            }
            while (size > previousSize);
        }
        finally {
            this.collectingParallelConfigurations -= 1;
        }
    }

    /** One branch lifecycle owns entry state, active sibling possibilities and balanced restoration. */
    private visitParallelBranch(
        analysis: RecipeCaptureRequirements.ParallelAnalysis,
        index: number
    ): RecipeCaptureRequirements.TraversalState {
        this.restoreTraversalState(analysis.initial);
        this.parallelScope = this.toParallelScope({
            parent: analysis.initial.parallelScope,
            configurations: analysis.configurations,
            recipes: analysis.recipes,
            index
        });
        try {
            this.visit(analysis.groups[index].commands, analysis.sequence.fork());
            return this.snapshotTraversalState();
        }
        finally {
            this.restoreTraversalState(analysis.initial);
        }
    }

    private applyParallelContinuation(analysis: RecipeCaptureRequirements.ParallelAnalysis): void {
        const parent = analysis.initial.parallelScope;
        analysis.configurations.forEach((values) =>
            values.forEach((value, source) => parent?.recorded.set(source, value))
        );
        analysis.recipes.forEach((values) => values.forEach((value) => parent?.recordedRecipes.add(value)));
        this.config = analysis.finalConfigurations.size > 0
            ? analysis.finalConfigurations.values().next().value
            : analysis.initial.config;
        this.configurationAlternatives = analysis.finalConfigurations.size > 1
            ? [...analysis.finalConfigurations]
            : analysis.finalConfigurations.size === 1
            ? undefined
            : analysis.initial.alternatives;
        this.loadedRecipe = analysis.finalRecipes.size > 0
            ? analysis.finalRecipes.values().next().value
            : analysis.initial.loadedRecipe;
        this.loadedRecipeAlternatives = analysis.finalRecipes.size > 1
            ? [...analysis.finalRecipes]
            : analysis.finalRecipes.size === 1
            ? undefined
            : analysis.initial.loadedAlternatives;
    }

    private snapshotTraversalState(): RecipeCaptureRequirements.TraversalState {
        return {
            config: this.config,
            alternatives: this.configurationAlternatives,
            loadedRecipe: this.loadedRecipe,
            loadedAlternatives: this.loadedRecipeAlternatives,
            parallelScope: this.parallelScope
        };
    }

    private restoreTraversalState(state: RecipeCaptureRequirements.TraversalState): void {
        this.config = state.config;
        this.configurationAlternatives = state.alternatives;
        this.loadedRecipe = state.loadedRecipe;
        this.loadedRecipeAlternatives = state.loadedAlternatives;
        this.parallelScope = state.parallelScope;
    }

    /** Both discovery and classification use the same active-sibling configuration/reference ownership. */
    private toParallelScope(
        input: RecipeCaptureRequirements.ParallelScopeInput
    ): RecipeCaptureRequirements.ParallelScope {
        return {
            inherited: [
                ...(input.parent?.inherited ?? []),
                ...input.configurations.flatMap((values, sibling) =>
                    sibling === input.index ? [] : [...values.values()]
                )
            ],
            recorded: input.configurations[input.index],
            inheritedRecipes: [
                ...(input.parent?.inheritedRecipes ?? []),
                ...input.recipes.flatMap((values, sibling) => sibling === input.index ? [] : [...values])
            ],
            recordedRecipes: input.recipes[input.index]
        };
    }

    private require(
        command: RallarBlackBoxTestCommand,
        sequence: RecipeCaptureSequence.Selection,
        step: RtcSignalingDiagnostics.CaptureMode | undefined
    ): void {
        if (this.collectingParallelConfigurations > 0) {
            return;
        }
        const configured = { ...sequence, step: step ?? sequence.step };
        const capture = resolveRtcCaptureConfiguration({ ...configured, sinkAvailable: false });
        if (capture.origin !== 'product-default') {
            const modes = this.requirements.get(command) ?? new Set<RtcSignalingDiagnostics.CaptureMode>();
            modes.add(capture.mode);
            this.requirements.set(command, modes);
        }
    }
}
