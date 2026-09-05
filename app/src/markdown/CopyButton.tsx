import { useEffect, useRef, useState } from 'react';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import * as styles from './CopyButton.styles';

export interface CopyButtonProps {
  readonly value: string;
  /** Named in the tooltip and the accessible name, e.g. "snippet" or "answer". */
  readonly label: string;
  /** Lets the block this sits in bring the button forward on hover. */
  readonly className?: string;
}

type State = 'idle' | 'copied' | 'failed';

const MESSAGE: Record<State, (label: string) => string> = {
  idle: (label) => `Copy ${label}`,
  copied: () => 'Copied',
  failed: () => 'Could not copy',
};

/**
 * The clipboard write can be refused — a webview without permission, a browser
 * outside a secure context — and silently doing nothing looks identical to a
 * dead button, so the failure gets its own state rather than a swallowed error.
 */
export const CopyButton = ({ value, label, className }: CopyButtonProps) => {
  const [state, setState] = useState<State>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setState('idle');
    }, 1500);
  };

  const message = MESSAGE[state](label);

  return (
    <Tooltip title={message}>
      <IconButton
        size="small"
        className={className}
        aria-label={message}
        data-testid={`copy-${label}`}
        sx={styles.button}
        onClick={() => {
          void copy();
        }}
      >
        {state === 'copied' ? (
          <CheckIcon fontSize="inherit" color="success" />
        ) : (
          <ContentCopyIcon fontSize="inherit" />
        )}
      </IconButton>
    </Tooltip>
  );
};
