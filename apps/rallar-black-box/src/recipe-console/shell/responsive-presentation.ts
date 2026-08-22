export type RecipeConsolePresentation = Readonly<{
    navigation: 'rail' | 'compact-rail' | 'bottom';
    inspector: 'rail' | 'overlay' | 'sheet';
    commandBarHeight: 48 | 52;
}>;

export function resolveRecipeConsolePresentation(
    width: number,
    height: number
): RecipeConsolePresentation {
    if (width >= 720 && height <= 520) {
        return {
            navigation: 'compact-rail',
            inspector: 'overlay',
            commandBarHeight: 48
        };
    }
    if (width <= 767) {
        return {
            navigation: 'bottom',
            inspector: 'sheet',
            commandBarHeight: 52
        };
    }
    if (width < 1200) {
        return {
            navigation: 'compact-rail',
            inspector: 'overlay',
            commandBarHeight: 52
        };
    }
    return {
        navigation: 'rail',
        inspector: 'rail',
        commandBarHeight: 52
    };
}
