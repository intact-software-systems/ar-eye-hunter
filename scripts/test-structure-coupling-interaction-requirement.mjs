export function hasConcreteInteractionRequirement(value) {
    if (typeof value !== 'string') {
        return false;
    }
    const text = value.trim();
    const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
    const statesObservableEffect =
        /\b(?:customer|consumer|effect|external|failure|gateway|observable|observed|owned port|reject(?:ed|s)?|visible)\b/iu
            .test(
                text
            );
    const statesInteractionForm =
        /\b(?:absence|cache|count|duplicate|exactly once|idempoten\w*|never|once|order|protocol|retry|suppression|twice)\b/iu
            .test(
                text
            );
    const statesNecessity = /\b(?:at least|at most|exactly|must|never|require(?:d|s)?)\b/iu.test(text);
    return words.length >= 8 && statesObservableEffect && statesInteractionForm && statesNecessity;
}
