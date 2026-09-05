import { useLayoutEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import SendIcon from '@mui/icons-material/Send';
import StopIcon from '@mui/icons-material/Stop';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import { useAppStore } from '../store/appStore';
import { MessageBubble } from './MessageBubble';
import * as styles from './ChatPanel.styles';

export interface ChatPanelProps {
  onSend: (message: string) => void;
  onCancel: () => void;
}

/** Slack in pixels within which the transcript still counts as scrolled to the end. */
const PINNED_TO_BOTTOM_PX = 80;

const atBottom = (list: HTMLElement): boolean =>
  list.scrollHeight - list.scrollTop - list.clientHeight <= PINNED_TO_BOTTOM_PX;

const EXAMPLES = [
  'Where is authentication handled?',
  'Explain the indexing service',
  'Generate a debounce helper in TypeScript',
];

export const ChatPanel = ({ onSend, onCancel }: ChatPanelProps) => {
  const messages = useAppStore((state) => state.messages);
  const isStreaming = useAppStore((state) => state.isStreaming);
  const connected = useAppStore((state) => state.connected);
  const error = useAppStore((state) => state.error);
  const selectedRoot = useAppStore((state) => state.selectedRoot);
  const clearMessages = useAppStore((state) => state.clearMessages);

  const [draft, setDraft] = useState('');
  const [detached, setDetached] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  /**
   * Whether the reader is still following the end of the transcript.
   *
   * It is remembered from the last scroll rather than measured when a message
   * arrives, and that distinction is the whole point: by the time the effect
   * runs the new content is already laid out, so any turn taller than the slack
   * would read as “the reader has scrolled away” — from a reader who never
   * moved. Sending a message stopped scrolling to it, which is as basic as chat
   * bugs get, and no unit test caught it because jsdom lays nothing out.
   */
  const pinned = useRef(true);

  const scrollToLatest = (): void => {
    pinned.current = true;
    setDetached(false);
    // `smooth` here, unlike the per-token follow: one deliberate jump is worth
    // seeing, and it tells the reader where they were taken.
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  };

  // Layout, not passive: the browser must not paint the taller transcript before
  // the view has caught up with it, or every message arrives with a visible jolt.
  useLayoutEffect(() => {
    if (!pinned.current) return;
    // `auto`, not `smooth`: a smooth scroll per token never finishes before the
    // next one starts, so the view lurches instead of following.
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'auto' });
  }, [messages]);

  const submit = (text: string): void => {
    const content = text.trim();
    if (content.length === 0 || isStreaming) return;
    onSend(content);
    setDraft('');
  };

  return (
    <Stack sx={styles.panel}>
      <Box
        // A chat transcript is a log: announce new answers, and let a keyboard
        // user scroll the region without a pointer.
        role="log"
        aria-live="polite"
        aria-label="Conversation"
        tabIndex={0}
        sx={styles.transcript}
        onScroll={(event) => {
          // The reader's own scrolling is the only thing that unpins them, and the
          // only thing that pins them back.
          pinned.current = atBottom(event.currentTarget);
          setDetached(!pinned.current);
        }}
        data-testid="message-list"
      >
        {messages.length === 0 ? (
          <Stack spacing={2} sx={styles.emptyState}>
            <Typography variant="h6">Ask something about your codebase</Typography>
            <Typography variant="body2" color="text.secondary">
              Index a folder, then ask a question. Answers are grounded in the snippets retrieved
              from it.
            </Typography>
            <Stack direction="row" spacing={1} useFlexGap sx={styles.examples}>
              {EXAMPLES.map((example) => (
                <Chip
                  key={example}
                  label={example}
                  variant="outlined"
                  onClick={() => submit(example)}
                  disabled={!connected}
                  sx={styles.exampleChip}
                />
              ))}
            </Stack>
          </Stack>
        ) : (
          <Stack spacing={1.5}>
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            <Box ref={bottomRef} sx={styles.transcriptEnd} />
          </Stack>
        )}
      </Box>

      {detached ? (
        <Box sx={styles.jumpAnchor}>
          <Button
            size="small"
            variant="contained"
            startIcon={<ArrowDownwardIcon />}
            data-testid="jump-to-latest"
            onClick={scrollToLatest}
            sx={styles.jumpButton}
          >
            Jump to latest
          </Button>
        </Box>
      ) : null}

      {error ? (
        <Alert severity="warning" variant="outlined" sx={styles.errorAlert}>
          {error}
        </Alert>
      ) : null}

      <Paper square variant="outlined" sx={styles.composer}>
        <Stack direction="row" spacing={1} sx={styles.composerRow}>
          <TextField
            fullWidth
            multiline
            maxRows={6}
            size="small"
            placeholder={
              connected ? 'Ask about your code…' : 'Waiting for the backend on port 3001…'
            }
            value={draft}
            disabled={!connected}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter inserts a newline.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit(draft);
              }
            }}
            slotProps={{ htmlInput: { 'data-testid': 'chat-input' } }}
          />
          {/*
            One control, two jobs: while a turn is streaming the only useful
            action is to stop it, and a separate button would sit disabled and
            dead for the rest of the time.
          */}
          {isStreaming ? (
            <IconButton
              color="primary"
              aria-label="Stop generating"
              data-testid="stop-button"
              onClick={onCancel}
            >
              <StopIcon />
            </IconButton>
          ) : (
            <IconButton
              color="primary"
              aria-label="Send message"
              data-testid="send-button"
              disabled={!connected || draft.trim().length === 0}
              onClick={() => submit(draft)}
            >
              <SendIcon />
            </IconButton>
          )}
        </Stack>
        <Stack direction="row" spacing={1} sx={styles.composerFooter}>
          <Typography variant="caption" color="text.secondary">
            {selectedRoot ? `Scoped to ${selectedRoot}` : 'Searching all indexed folders'}
          </Typography>
          <Box sx={styles.spacer} />
          {messages.length > 0 && (
            <Chip size="small" label="Clear chat" variant="outlined" onClick={clearMessages} />
          )}
        </Stack>
      </Paper>
    </Stack>
  );
};
