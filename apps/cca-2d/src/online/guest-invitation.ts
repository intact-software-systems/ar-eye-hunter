const nicknames = [
    'Captain Cabbage',
    'Count Crumb',
    'Dizzy Dumpling',
    'Doctor Drip',
    'Pickle Boots',
    'Professor Puddle',
    'Soggy Biscuit',
    'Wobbly Turnip'
];

export function openGuestInvitation(root: HTMLElement, signal: AbortSignal): void {
    root.innerHTML = `<main class="loading">
        <h1>Town invitation</h1>
        <p>Your town nickname is <output aria-label="Your nickname"></output>.</p>
        <button type="button">Shuffle nickname</button>
        <p>Guest matches are coming soon. You can play solo now.</p>
        <a>Play solo</a>
    </main>`;
    const output = root.querySelector('output')!;
    const shuffle = root.querySelector('button')!;
    root.querySelector('a')!.href = import.meta.env.BASE_URL;

    let index = Math.floor(Math.random() * nicknames.length);
    output.value = nicknames[index];
    shuffle.addEventListener('click', () => {
        const offset = 1 + Math.floor(Math.random() * (nicknames.length - 1));
        index = (index + offset) % nicknames.length;
        output.value = nicknames[index];
    }, { signal });
}
