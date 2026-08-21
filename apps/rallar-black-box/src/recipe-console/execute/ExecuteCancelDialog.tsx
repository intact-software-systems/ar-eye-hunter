import { ControlRunCancelDialog, type ControlRunCancelDialogProps } from '../control/ControlRunCancelDialog.tsx';

export type ExecuteCancelDialogProps = Omit<ControlRunCancelDialogProps, 'owner'>;

export function ExecuteCancelDialog(props: ExecuteCancelDialogProps) {
    return <ControlRunCancelDialog {...props} owner="execute" />;
}
