import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type ManifestChunk = Readonly<{
    file: string;
    src?: string;
    isEntry?: boolean;
    isDynamicEntry?: boolean;
    imports?: readonly string[];
    dynamicImports?: readonly string[];
    css?: readonly string[];
}>;

type Manifest = Readonly<Record<string, ManifestChunk>>;

export type ExperienceChunkGraph = Readonly<{
    main: string;
    mainStaticClosure: ReadonlySet<string>;
    mainDynamicEntries: ReadonlySet<string>;
    mainDynamicExperienceEntries: ReadonlySet<string>;
    recipeConsoleStaticClosure: ReadonlySet<string>;
    legacyStaticClosure: ReadonlySet<string>;
    retentionDynamicEntry: string;
    retentionStaticClosure: ReadonlySet<string>;
    tuneStaticClosure: ReadonlySet<string>;
    productionClosure: ReadonlySet<string>;
}>;

type GraphMetadata = Readonly<{
    manifest: Manifest;
    outputRoot: string;
    recipeConsole: string;
    legacy: string;
    retention: string;
    tune: string;
}>;

const graphMetadata = new WeakMap<ExperienceChunkGraph, GraphMetadata>();

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function findEntry(
    manifest: Manifest,
    predicate: (chunk: ManifestChunk) => boolean,
    message: string,
): readonly [string, ManifestChunk] {
    const entry = Object.entries(manifest).find(([, chunk]) => predicate(chunk));
    assert(entry, message);
    return entry;
}

function closure(
    manifest: Manifest,
    root: string,
    includeDynamicImports: boolean,
): ReadonlySet<string> {
    const visited = new Set<string>();
    const visit = (key: string): void => {
        if (visited.has(key)) return;
        const chunk = manifest[key];
        assert(chunk, `Manifest closure references missing chunk: ${key}`);
        visited.add(key);
        for (const dependency of chunk.imports ?? []) visit(dependency);
        if (includeDynamicImports) {
            for (const dependency of chunk.dynamicImports ?? []) visit(dependency);
        }
    };
    visit(root);
    return visited;
}

function closureText(
    manifest: Manifest,
    outputRoot: string,
    keys: ReadonlySet<string>,
): string {
    return [...keys].map(key => {
        const chunk = manifest[key];
        if (!chunk) return '';
        return [chunk.file, ...(chunk.css ?? [])]
            .map(file => readFileSync(resolve(outputRoot, file), 'utf8'))
            .join('\n');
    }).join('\n');
}

function cssClosure(
    manifest: Manifest,
    keys: ReadonlySet<string>,
    excludedKeys: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
    const files = new Set<string>();
    for (const key of keys) {
        if (excludedKeys.has(key)) continue;
        for (const file of manifest[key]?.css ?? []) files.add(file);
    }
    return files;
}

export function readExperienceChunkGraph(
    manifestPath: string,
): ExperienceChunkGraph {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    const [main] = findEntry(
        manifest,
        chunk => chunk.isEntry === true,
        'Vite manifest must expose the main entry.',
    );
    const [recipeConsole] = findEntry(
        manifest,
        chunk => chunk.src?.endsWith('/recipe-console/app/RecipeConsoleApp.tsx') === true,
        'Vite manifest must expose RecipeConsoleApp as a dynamic entry.',
    );
    const [legacy] = findEntry(
        manifest,
        chunk => chunk.src?.endsWith('/legacy/shell/LegacyExperience.tsx') === true,
        'Vite manifest must expose LegacyExperience as a dynamic entry.',
    );
    const [retention] = findEntry(
        manifest,
        chunk => chunk.src?.endsWith(
            '/recipe-console/control/control-retention-api.ts',
        ) === true,
        'Vite manifest must expose the retention client as a dynamic entry.',
    );
    const [tune] = findEntry(
        manifest,
        chunk => chunk.src?.endsWith('/recipe-console/tune/TuneWorkspace.tsx') === true,
        'Vite manifest must expose TuneWorkspace as a dynamic entry.',
    );
    const mainDynamicEntries = new Set(manifest[main]?.dynamicImports ?? []);
    const experienceEntries = new Set(
        [...mainDynamicEntries].filter(key => key === recipeConsole || key === legacy),
    );
    const graph: ExperienceChunkGraph = {
        main,
        mainStaticClosure: closure(manifest, main, false),
        mainDynamicEntries,
        mainDynamicExperienceEntries: experienceEntries,
        recipeConsoleStaticClosure: closure(manifest, recipeConsole, false),
        legacyStaticClosure: closure(manifest, legacy, false),
        retentionDynamicEntry: retention,
        retentionStaticClosure: closure(manifest, retention, false),
        tuneStaticClosure: closure(manifest, tune, false),
        productionClosure: closure(manifest, main, true),
    };
    graphMetadata.set(graph, {
        manifest,
        outputRoot: resolve(dirname(manifestPath), '..'),
        recipeConsole,
        legacy,
        retention,
        tune,
    });
    return graph;
}

export function assertExperienceChunkGraph(graph: ExperienceChunkGraph): void {
    const metadata = graphMetadata.get(graph);
    assert(metadata, 'Chunk graph must originate from readExperienceChunkGraph().');
    const { manifest, outputRoot, recipeConsole, legacy, retention, tune } = metadata;

    assert(recipeConsole !== legacy, 'The two experiences must use different entries.');
    assert(
        manifest[recipeConsole]?.file !== manifest[legacy]?.file,
        'The two experiences must use different files.',
    );
    assert(
        graph.mainStaticClosure.size > 1,
        'Main static closure must contain non-entry dependencies.',
    );
    assert(
        !graph.mainStaticClosure.has(recipeConsole),
        'Recipe Console is in the main static closure.',
    );
    assert(
        !graph.mainStaticClosure.has(legacy),
        'LegacyExperience is in the main static closure.',
    );
    assert(
        graph.mainDynamicEntries.size > graph.mainDynamicExperienceEntries.size,
        'Unrelated runtime/auth dynamic entries must remain allowed and observable.',
    );
    assert(
        graph.mainDynamicExperienceEntries.size === 2 &&
            graph.mainDynamicExperienceEntries.has(recipeConsole) &&
            graph.mainDynamicExperienceEntries.has(legacy),
        'Main must have exactly the two filtered experience dynamic entries.',
    );
    assert(
        graph.recipeConsoleStaticClosure.size > 1,
        'Recipe Console static closure must be nonempty.',
    );
    assert(
        graph.legacyStaticClosure.size > 1,
        'Legacy static closure must be nonempty.',
    );
    assert(
        !graph.recipeConsoleStaticClosure.has(legacy),
        'Recipe Console static closure includes LegacyExperience.',
    );
    assert(
        manifest[recipeConsole]?.dynamicImports?.includes(retention),
        'Recipe Console must dynamically import the retention client.',
    );
    assert(
        manifest[recipeConsole]?.dynamicImports?.includes(tune),
        'Recipe Console must dynamically import TuneWorkspace.',
    );
    assert(
        !graph.recipeConsoleStaticClosure.has(retention),
        'Recipe Console static closure includes the retention client.',
    );
    assert(
        !graph.tuneStaticClosure.has(retention),
        'Inactive Tune static closure includes the retention client.',
    );
    assert(
        graph.productionClosure.has(graph.main) &&
            graph.productionClosure.has(recipeConsole) &&
            graph.productionClosure.has(legacy),
        'Production closure must reach the main entry and both experiences.',
    );
    assert(
        ![...graph.productionClosure].some(key =>
            key.includes('recipe-console-css-isolation')
        ),
        'Production closure includes a CSS isolation fixture entry.',
    );

    const mainCss = cssClosure(manifest, graph.mainStaticClosure);
    const recipeCss = cssClosure(manifest, graph.recipeConsoleStaticClosure);
    const legacyCss = cssClosure(
        manifest,
        graph.legacyStaticClosure,
        graph.mainStaticClosure,
    );
    assert(legacyCss.size > 0, 'Legacy experience must emit a nonempty CSS closure.');
    for (const file of legacyCss) {
        assert(!mainCss.has(file), `Main static closure includes legacy CSS: ${file}`);
        assert(!recipeCss.has(file), `Recipe Console static closure includes legacy CSS: ${file}`);
    }

    const mainText = closureText(manifest, outputRoot, graph.mainStaticClosure);
    const recipeText = closureText(manifest, outputRoot, graph.recipeConsoleStaticClosure);
    const legacyText = closureText(manifest, outputRoot, graph.legacyStaticClosure);
    const tuneText = closureText(manifest, outputRoot, graph.tuneStaticClosure);
    const retentionText = closureText(
        manifest,
        outputRoot,
        graph.retentionStaticClosure,
    );
    assert(
        recipeText.includes('data-command-bar'),
        'Recipe Console static closure sentinel is missing.',
    );
    assert(
        !mainText.includes('data-command-bar'),
        'Main static closure contains Recipe Console UI.',
    );
    assert(
        !legacyText.includes('data-command-bar'),
        'Legacy static closure contains Recipe Console UI.',
    );
    assert(!mainText.includes('app-shell'), 'Main static closure contains legacy shell UI.');
    assert(!recipeText.includes('app-shell'), 'Recipe Console static closure contains legacy shell UI.');
    assert(!recipeText.includes('panel-media'), 'Recipe Console static closure contains legacy media UI.');
    assert(!recipeText.includes('panel-rallar-server'), 'Recipe Console static closure contains legacy server UI.');
    assert(!recipeText.includes('panel-distributed-recipes'), 'Recipe Console static closure contains legacy recipe UI.');
    assert(legacyText.includes('app-shell'), 'Legacy static closure does not contain the legacy shell.');
    assert(legacyText.includes('panel-media'), 'Legacy static closure does not contain panel-media.');
    assert(legacyText.includes('panel-rallar-server'), 'Legacy static closure does not contain panel-rallar-server.');
    assert(legacyText.includes('panel-distributed-recipes'), 'Legacy static closure does not contain distributed recipes.');
    assert(legacyText.includes('legacy-panel-distributed-recipes'), 'Legacy compatibility recipe sentinel is missing.');
    for (const [label, text] of [
        ['main', mainText],
        ['Recipe Console', recipeText],
        ['Tune', tuneText],
    ] as const) {
        assert(
            !text.includes('retention/cleanup') &&
                !text.includes('preview.deletedRunIds'),
            `${label} static closure contains lazy retention implementation.`,
        );
    }
    assert(
        retentionText.includes('retention/cleanup') &&
            retentionText.includes('preview.deletedRunIds'),
        'Retention dynamic closure sentinels are missing.',
    );
}

function runCli(): void {
    const outputRoot = resolve(process.argv[2] ?? 'apps/rallar-black-box/dist');
    const graph = readExperienceChunkGraph(resolve(outputRoot, '.vite/manifest.json'));
    assertExperienceChunkGraph(graph);
    const metadata = graphMetadata.get(graph);
    assert(metadata, 'Chunk graph metadata is unavailable after assertion.');
    console.log(
        `experience chunks ok: ${manifestFile(metadata.manifest, metadata.recipeConsole)} | ${manifestFile(metadata.manifest, metadata.legacy)}`,
    );
}

function manifestFile(manifest: Manifest, key: string): string {
    const file = manifest[key]?.file;
    assert(file, `Manifest chunk ${key} does not expose a file.`);
    return file;
}

const entryUrl = process.argv[1]
    ? pathToFileURL(resolve(process.argv[1])).href
    : undefined;
if (entryUrl === import.meta.url) runCli();
