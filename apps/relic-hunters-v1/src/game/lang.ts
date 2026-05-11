export type Lang = 'en' | 'no';

export type DialogueLine = Readonly<{
    text: string;
    delayMs: number;
    isCast?: boolean;
}>;

export const INTRO_DIALOGUE: Record<Lang, readonly DialogueLine[]> = {
    en: [
        { text: 'Welcome... brave hunters.', delayMs: 1000 },
        { text: 'The Castle of Yamashiro has stood for a thousand years, hiding relics of immense power.', delayMs: 4200 },
        { text: 'You are not alone in this quest. Others seek the same relics.', delayMs: 9200 },
        { text: 'Navigate the treacherous halls. Decipher ancient clues. Claim what you can carry.', delayMs: 13200 },
        { text: 'But be warned — monsters stir in the dark. Traps are set. And not every hunter... plays fair.', delayMs: 17800 },
        { text: 'Only the cunning, the bold, and the lucky shall escape with their prize.', delayMs: 23200 },
        { text: '...', delayMs: 27200 },
        { text: 'Now go. Find the relics.', delayMs: 28000 },
        { text: 'And may the ruin... remember your name!', delayMs: 30200, isCast: true },
    ],
    no: [
        { text: 'Velkommen... modige jegere.', delayMs: 1000 },
        { text: 'Yamashiro-slottet har stått i tusen år og skjult relikvier av enorm makt.', delayMs: 4200 },
        { text: 'Dere er ikke alene i dette søket. Andre jakter på de samme relikvier.', delayMs: 9200 },
        { text: 'Naviger de farlige hallene. Tyd de gamle ledetrådene. Ta det dere kan bære.', delayMs: 13200 },
        { text: 'Men vær advart — monstre rører seg i mørket. Feller er satt. Og ikke alle jegere... spiller rettferdig.', delayMs: 17800 },
        { text: 'Bare de listige, de modige og de heldige vil unnslippe med sin premie.', delayMs: 23200 },
        { text: '...', delayMs: 27200 },
        { text: 'Gå nå. Finn relikvierne.', delayMs: 28000 },
        { text: 'Og måtte ruinen... huske deres navn!', delayMs: 30200, isCast: true },
    ],
};

export const AUTO_COMPLETE_MS = 34000;

export type UIStrings = Readonly<{
    phaseLobby: string;
    phasePlanning: string;
    phaseFinished: string;
    phaseConnected: string;
    phaseConnecting: string;
    phaseSignedOut: string;
    phaseBannerPlanning: string;
    submitButton: string;
    boundButton: string;
    huntersSummoned: string;
    keeperWatches: string;
    keeperAwaits: string;
    heedingTheCall: string;
    bound: string;
    heedTheCall: string;
    readyConfirmed: string;
    beginTheHunt: string;
    objectiveLobby: string;
    objectiveJoin: string;
    objectiveEscaped: string;
    objectiveDefeated: string;
    objectiveAllLocked: string;
    objectiveWon: string;
    objectiveSilent: string;
    timerLabel: string;
    timerAutoSubmit: string;
    setTimerTitle: string;
    waitingForKeeper: string;
}>;

export const UI: Record<Lang, UIStrings> = {
    en: {
        phaseLobby: 'The Keeper gathers hunters',
        phasePlanning: 'The Keeper Commands',
        phaseFinished: 'Expedition complete',
        phaseConnected: 'Choose a room',
        phaseConnecting: 'Opening the gate',
        phaseSignedOut: 'Sign in',
        phaseBannerPlanning: '⚔  The Hunt Begins!',
        submitButton: 'Heed the Keeper',
        boundButton: 'Bound — awaiting the others...',
        huntersSummoned: 'Hunters Summoned',
        keeperWatches: 'The Keeper watches from above.',
        keeperAwaits: 'The Keeper awaits more hunters…',
        heedingTheCall: 'heeding the call',
        bound: 'bound',
        heedTheCall: 'Heed the Call',
        readyConfirmed: '✓ Ready',
        beginTheHunt: 'Begin the Hunt',
        objectiveLobby: 'The Keeper watches. Gather hunters, then enter the castle.',
        objectiveJoin: 'Join the expedition to enter the ruin.',
        objectiveEscaped: 'You escaped. Watch whether the others can beat your score.',
        objectiveDefeated: 'You are down. The ruin keeps your relics.',
        objectiveAllLocked: 'All plans are locked. The ruin is about to answer.',
        objectiveWon: 'The highest score has claimed the Heart Relic.',
        objectiveSilent: 'The ruin has gone silent.',
        timerLabel: 'Time left',
        timerAutoSubmit: 'Time is up — submitting your plan…',
        setTimerTitle: 'Round Time Limit',
        waitingForKeeper: 'Waiting for the Keeper to begin the hunt…',
    },
    no: {
        phaseLobby: 'Vokteren samler jegere',
        phasePlanning: 'Vokternes Befaling',
        phaseFinished: 'Ekspedisjonen er over',
        phaseConnected: 'Velg et rom',
        phaseConnecting: 'Åpner porten',
        phaseSignedOut: 'Logg inn',
        phaseBannerPlanning: '⚔  Jakten begynner!',
        submitButton: 'Adlyd Vokteren',
        boundButton: 'Bundet — venter på de andre...',
        huntersSummoned: 'Jegere innkalt',
        keeperWatches: 'Vokteren ser fra oven.',
        keeperAwaits: 'Vokteren venter på flere jegere…',
        heedingTheCall: 'adlyder kallet',
        bound: 'bundet',
        heedTheCall: 'Adlyd kallet',
        readyConfirmed: '✓ Klar',
        beginTheHunt: 'Start jakten',
        objectiveLobby: 'Vokteren ser på. Samle jegere, gå inn i slottet.',
        objectiveJoin: 'Bli med i ekspedisjonen for å entre ruinen.',
        objectiveEscaped: 'Du unnslapp. Se om de andre kan slå poengsummen din.',
        objectiveDefeated: 'Du er ute. Ruinen beholder relikvier.',
        objectiveAllLocked: 'Alle planer er låst. Ruinen er i ferd med å svare.',
        objectiveWon: 'Høyeste poengsum har krevd Hjerterelikkiet.',
        objectiveSilent: 'Ruinen har stilnet.',
        timerLabel: 'Tid igjen',
        timerAutoSubmit: 'Tiden er ute — sender inn planen din…',
        setTimerTitle: 'Tidsbegrensning per runde',
        waitingForKeeper: 'Venter på at Vokteren skal starte jakten…',
    },
};

export function pickSpeechVoice(lang: Lang): SpeechSynthesisVoice | null {
    if (typeof speechSynthesis === 'undefined') return null;
    const voices = speechSynthesis.getVoices();
    const locale = lang === 'no' ? 'nb' : 'en';
    // Prefer non-local (higher quality network) voices, then any matching locale
    return voices.find((v) => v.lang.startsWith(locale) && !v.localService)
        ?? voices.find((v) => v.lang.startsWith(locale))
        ?? null;
}
