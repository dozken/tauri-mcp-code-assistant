import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import BuildIcon from '@mui/icons-material/Build';
import { Markdown } from '../markdown/Markdown';
import { CopyButton } from '../markdown/CopyButton';
import * as styles from './MessageBubble.styles';
import type { ChatMessage } from '../types';

/**
 * Built once. `Intl.DateTimeFormat` is expensive to construct and this renders on
 * every streamed token; `undefined` locale means the reader's own, which is the
 * only correct answer for a clock.
 */
const CLOCK = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

export interface MessageBubbleProps {
  message: ChatMessage;
}

export const MessageBubble = ({ message }: MessageBubbleProps) => {
  return (
    <Stack direction="row" sx={styles.row[message.role]} data-testid={`message-${message.role}`}>
      <Paper variant="outlined" sx={styles.bubble[message.role]}>
        {message.toolCalls.length > 0 && (
          <Accordion disableGutters elevation={0} sx={styles.toolAccordion}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={styles.toolSummary}>
              <Stack direction="row" spacing={1} sx={styles.toolChips}>
                <BuildIcon fontSize="small" color="secondary" />
                {message.toolCalls.map((call, index) => (
                  <Chip
                    key={`${call.name}-${index}`}
                    size="small"
                    variant="outlined"
                    color={call.failed ? 'error' : 'secondary'}
                    label={`${call.name} · ${call.durationMs}ms`}
                  />
                ))}
              </Stack>
            </AccordionSummary>
            <AccordionDetails sx={styles.toolDetails}>
              {message.toolCalls.map((call, index) => (
                <Box key={`${call.name}-detail-${index}`} sx={styles.toolEntry}>
                  <Typography variant="caption" color="text.secondary">
                    {call.name}({JSON.stringify(call.args)})
                  </Typography>
                  <Box component="pre" sx={styles.toolOutput}>
                    {call.result}
                  </Box>
                </Box>
              ))}
            </AccordionDetails>
          </Accordion>
        )}

        <Markdown content={message.content} />

        {message.streaming && message.content.trim() === '' ? (
          <Typography variant="body2" color="text.secondary">
            Thinking…
          </Typography>
        ) : null}

        <Box sx={styles.footer}>
          {/*
            A real `<time>`: the machine-readable value is the one a screen reader
            and a future export both want, and the short label is for the eye.
          */}
          <Typography
            component="time"
            variant="caption"
            sx={styles.time[message.role]}
            dateTime={new Date(message.createdAt).toISOString()}
            title={FULL.format(message.createdAt)}
            data-testid="message-time"
          >
            {CLOCK.format(message.createdAt)}
          </Typography>
          {/*
            Copy only on a finished assistant answer: mid-stream it would copy half
            a reply, and the user's own message is already in their clipboard.
          */}
          {message.role === 'assistant' && !message.streaming && message.content !== '' ? (
            <CopyButton value={message.content} label="answer" />
          ) : null}
        </Box>

        {message.error ? (
          <Alert severity="error" sx={styles.errorAlert} variant="outlined">
            {message.error}
          </Alert>
        ) : null}
      </Paper>
    </Stack>
  );
};
