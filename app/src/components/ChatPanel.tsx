import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import SendIcon from '@mui/icons-material/Send';
import { useAppStore } from '../store/appStore';
import { MessageBubble } from './MessageBubble';
import * as styles from './ChatPanel.styles';

export interface ChatPanelProps {
  onSend: (message: string) => void;
}

/** Slack in pixels within which the transcript still counts as scrolled to the end. */
const PINNED_TO_BOTTOM_PX = 80;

const EXAMPLES = [
  'Where is authentication handled?',
  'Explain the indexing service',
  'Generate a debounce helper in TypeScript',
];

export const ChatPanel = ({ onSend }: ChatPanelProps) => {
  const messages = useAppStore((state) => state.messages);
  const isStreaming = useAppStore((state) => state.isStreaming);
  const connected = useAppStore((state) => state.connected);
  const error = useAppStore((state) => state.error);
  const selectedRoot = useAppStore((state) => state.selectedRoot);
  const clearMessages = useAppStore((state) => state.clearMessages);

  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // Only follow the stream while the reader is already at the bottom. Scrolling
    // up mid-answer to re-read something used to be impossible: every token
    // yanked the view back down.
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (distanceFromBottom > PINNED_TO_BOTTOM_PX) return;
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
        ref={listRef}
        // A chat transcript is a log: announce new answers, and let a keyboard
        // user scroll the region without a pointer.
        role="log"
        aria-live="polite"
        aria-label="Conversation"
        tabIndex={0}
        sx={styles.transcript}
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
            <div ref={bottomRef} />
          </Stack>
        )}
      </Box>

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
          <IconButton
            color="primary"
            aria-label="Send message"
            data-testid="send-button"
            disabled={!connected || isStreaming || draft.trim().length === 0}
            onClick={() => submit(draft)}
          >
            <SendIcon />
          </IconButton>
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
