import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function staticClosure(manifest: Manifest, root: string): readonly string[] {
    const visited = new Set<string>();
    const visit = (key: string): void => {
        if (visited.has(key)) return;
        visited.add(key);
        for (const dependency of manifest[key]?.imports ?? []) {
            visit(dependency);
        }
    };
    visit(root);
    return [...visited];
}

async function closureText(
    manifest: Manifest,
    outputRoot: string,
    root: string,
): Promise<string> {
    return (await Promise.all(
        staticClosure(manifest, root).map(async key => {
            const chunk = manifest[key];
            if (!chunk) return '';
            const files = [chunk.file, ...(chunk.css ?? [])];
            return (await Promise.all(
                files.map(file => readFile(resolve(outputRoot, file), 'utf8')),
            )).join('\n');
        }),
    )).join('\n');
}

const outputRoot = resolve(process.argv[2] ?? 'apps/rallar-black-box/dist');
const manifest = JSON.parse(
    await readFile(resolve(outputRoot, '.vite/manifest.json'), 'utf8'),
) as Manifest;
const entries = Object.entries(manifest);
const main = entries.find(([, chunk]) => chunk.isEntry);
const recipe = entries.find(([, chunk]) =>
    chunk.src?.endsWith('/recipe-console/app/RecipeConsoleApp.tsx')
);
const legacy = entries.find(([, chunk]) =>
    chunk.src?.endsWith('/legacy/shell/LegacyExperience.tsx')
);

assert(main, 'Vite manifest must expose the main entry.');
assert(recipe, 'Vite manifest must expose RecipeConsoleApp as a dynamic entry.');
assert(legacy, 'Vite manifest must expose LegacyExperience as a dynamic entry.');
assert(recipe[0] !== legacy[0], 'The two experiences must use different entries.');
assert(recipe[1].file !== legacy[1].file, 'The two experiences must use different files.');

const experienceEdges = (main[1].dynamicImports ?? []).filter(key =>
    key === recipe[0] || key === legacy[0]
);

const mainStaticKeys = staticClosure(manifest, main[0]);
assert(!mainStaticKeys.includes(recipe[0]), 'Recipe Console is in the main static closure.');
assert(!mainStaticKeys.includes(legacy[0]), 'LegacyExperience is in the main static closure.');
assert(
    experienceEdges.length === 2 &&
        new Set(experienceEdges).size === 2,
    'Main must have exactly the two filtered experience dynamic edges.',
);

const [mainText, recipeText, legacyText] = await Promise.all([
    closureText(manifest, outputRoot, main[0]),
    closureText(manifest, outputRoot, recipe[0]),
    closureText(manifest, outputRoot, legacy[0]),
]);

assert(
    !mainText.includes('Preparing the Execute workspace.'),
    'Main static closure contains Recipe Console UI.',
);
assert(!mainText.includes('app-shell'), 'Main static closure contains legacy shell UI.');
assert(!recipeText.includes('app-shell'), 'Recipe Console static closure contains legacy shell UI.');
assert(!recipeText.includes('panel-recipes'), 'Recipe Console static closure contains legacy panels.');
assert(legacyText.includes('app-shell'), 'Legacy static closure does not contain the legacy shell.');
assert(legacyText.includes('panel-recipes'), 'Legacy static closure does not contain legacy panels.');

console.log(
    `experience chunks ok: ${recipe[1].file} | ${legacy[1].file}`,
);
