import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from './Icon.tsx';
import styles from './primitives.module.css';

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & Readonly<{
    icon: IconName;
    'aria-label': string;
    title?: string;
}>;

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({
    icon,
    'aria-label': ariaLabel,
    title,
    className,
    type = 'button',
    ...buttonProps
}: IconButtonProps, ref) {
    return (
        <button
            {...buttonProps}
            aria-label={ariaLabel}
            className={[styles.iconButton, className].filter(Boolean).join(' ')}
            ref={ref}
            title={title ?? ariaLabel}
            type={type}
        >
            <Icon className={styles.icon} name={icon} />
        </button>
    );
});
