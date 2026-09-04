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

export interface ChatPanelProps {
  onSend(message: string): void;
}

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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const submit = (text: string): void => {
    const content = text.trim();
    if (content.length === 0 || isStreaming) return;
    onSend(content);
    setDraft('');
  };

  return (
    <Stack sx={{ height: '100%', minWidth: 0 }}>
      <Box sx={{ flex: 1, overflowY: 'auto', p: 2 }} data-testid="message-list">
        {messages.length === 0 ? (
          <Stack spacing={2} alignItems="center" justifyContent="center" sx={{ height: '100%' }}>
            <Typography variant="h6">Ask something about your codebase</Typography>
            <Typography variant="body2" color="text.secondary">
              Add a folder on the left, then ask a question. Answers are grounded in retrieved
              snippets.
            </Typography>
            <Stack direction="row" spacing={1} flexWrap="wrap" justifyContent="center" useFlexGap>
              {EXAMPLES.map((example) => (
                <Chip
                  key={example}
                  label={example}
                  variant="outlined"
                  onClick={() => submit(example)}
                  disabled={!connected}
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

      {error && (
        <Alert severity="warning" variant="outlined" sx={{ mx: 2, mb: 1 }}>
          {error}
        </Alert>
      )}

      <Paper square variant="outlined" sx={{ p: 1.5, borderLeft: 0, borderRight: 0, borderBottom: 0 }}>
        <Stack direction="row" spacing={1} alignItems="flex-end">
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
        <Stack direction="row" spacing={1} sx={{ mt: 1 }} alignItems="center">
          <Typography variant="caption" color="text.secondary">
            {selectedRoot ? `Scoped to ${selectedRoot}` : 'Searching all indexed folders'}
          </Typography>
          <Box sx={{ flex: 1 }} />
          {messages.length > 0 && (
            <Chip size="small" label="Clear chat" variant="outlined" onClick={clearMessages} />
          )}
        </Stack>
      </Paper>
    </Stack>
  );
};
