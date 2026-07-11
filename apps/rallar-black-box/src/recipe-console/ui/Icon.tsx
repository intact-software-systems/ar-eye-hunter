export type IconName =
    | 'play' | 'pulse' | 'search' | 'sliders' | 'globe' | 'tools'
    | 'close' | 'copy' | 'refresh';

export type IconProps = Readonly<{
    name: IconName;
    size?: 16 | 18;
    className?: string;
}>;

function IconPaths({ name }: Pick<IconProps, 'name'>) {
    switch (name) {
        case 'play': return <><path d="M6 4l8 5-8 5z" /><path d="M3 3v12" /></>;
        case 'pulse': return <path d="M2 9h3l2-5 3 10 2-5h4" />;
        case 'search': return <><circle cx="8" cy="8" r="5" /><path d="M12 12l4 4" /></>;
        case 'sliders': return <><path d="M3 5h12M3 13h12" /><circle cx="7" cy="5" r="2" /><circle cx="11" cy="13" r="2" /></>;
        case 'globe': return <><circle cx="9" cy="9" r="7" /><path d="M2 9h14M9 2c3 3 3 11 0 14M9 2c-3 3-3 11 0 14" /></>;
        case 'tools': return <><path d="M3 4h12M3 9h12M3 14h12" /><circle cx="6" cy="4" r="1.5" /><circle cx="12" cy="9" r="1.5" /><circle cx="8" cy="14" r="1.5" /></>;
        case 'close': return <path d="M4 4l10 10M14 4L4 14" />;
        case 'copy': return <><rect x="6" y="6" width="9" height="9" rx="1" /><path d="M3 12V3h9" /></>;
        case 'refresh': return <><path d="M14 6V3l-2 2a6 6 0 10 2 5" /><path d="M14 3h-4" /></>;
    }
}

export function Icon({ name, size = 18, className }: IconProps) {
    return (
        <svg
            aria-hidden="true"
            className={className}
            fill="none"
            height={size}
            viewBox="0 0 18 18"
            width={size}
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.75"
        >
            <IconPaths name={name} />
        </svg>
    );
}
