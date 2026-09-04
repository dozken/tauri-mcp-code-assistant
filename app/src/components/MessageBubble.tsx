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
import { MONOSPACE } from '../theme';
import type { ChatMessage } from '../types';

export interface MessageBubbleProps {
  message: ChatMessage;
}

/** A union, so a prose segment cannot accidentally carry a language. */
export type Segment =
  { kind: 'text'; content: string } | { kind: 'code'; language?: string; content: string };

/** A fence line on its own: optional indent, three-or-more backticks, optional info string. */
const FENCE_LINE = /^[ \t]*(`{3,})([\w+-]*)[ \t]*$/;

interface Fence {
  marker: string;
  language?: string;
}

const matchFence = (line: string): Fence | undefined => {
  const match = FENCE_LINE.exec(line);
  if (match?.[1] === undefined) return undefined;
  return { marker: match[1], language: match[2] === '' ? undefined : match[2] };
};

/**
 * Splits an answer into prose and fenced code blocks.
 *
 * A full Markdown renderer is overkill here: the only structure the agent emits is
 * ``` fences around retrieved snippets, and keeping the parser inline avoids
 * shipping a Markdown dependency (and its sanitiser) into the webview.
 *
 * Scanned line by line rather than with one big regex. A lazy `([\s\S]*?)` closed
 * by a backreference is quadratic on unbalanced input, and this runs on every
 * render of every streamed token — so a half-typed fence would be re-scanned
 * hundreds of times per answer.
 */
export const splitFences = (content: string): Segment[] => {
  const segments: Segment[] = [];
  const buffer: string[] = [];
  let fence: Fence | undefined;

  const flush = (kind: Segment['kind'], language?: string): void => {
    const text = buffer.join('\n');
    if (text.trim().length > 0) {
      segments.push(kind === 'code' ? { kind, language, content: text } : { kind, content: text });
    }
    buffer.length = 0;
  };

  for (const line of content.split('\n')) {
    if (fence === undefined) {
      const opener = matchFence(line);
      if (opener) {
        flush('text');
        fence = opener;
        continue;
      }
      buffer.push(line);
      continue;
    }

    // Only a fence at least as long as the opener closes it, so an inner ``` inside
    // a ```` block stays part of the snippet.
    const closer = matchFence(line);
    if (closer && closer.marker.length >= fence.marker.length && closer.language === undefined) {
      flush('code', fence.language);
      fence = undefined;
      continue;
    }
    buffer.push(line);
  }

  // An unterminated fence is the normal mid-stream state, not an error.
  flush(fence === undefined ? 'text' : 'code', fence?.language);
  return segments;
};

export const MessageBubble = ({ message }: MessageBubbleProps) => {
  const isUser = message.role === 'user';
  const segments = splitFences(message.content);

  return (
    <Stack
      direction="row"
      justifyContent={isUser ? 'flex-end' : 'flex-start'}
      data-testid={`message-${message.role}`}
    >
      <Paper
        variant="outlined"
        sx={{
          maxWidth: isUser ? '75%' : '92%',
          px: 2,
          py: 1.25,
          bgcolor: isUser ? 'primary.dark' : 'background.paper',
          borderColor: isUser ? 'primary.main' : 'divider',
        }}
      >
        {message.toolCalls.length > 0 && (
          <Accordion disableGutters elevation={0} sx={{ bgcolor: 'transparent', mb: 1 }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 0, px: 0 }}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
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
            <AccordionDetails sx={{ px: 0 }}>
              {message.toolCalls.map((call, index) => (
                <Box key={`${call.name}-detail-${index}`} sx={{ mb: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    {call.name}({JSON.stringify(call.args)})
                  </Typography>
                  <Box
                    component="pre"
                    sx={{
                      m: 0,
                      p: 1,
                      fontFamily: MONOSPACE,
                      fontSize: 12,
                      maxHeight: 180,
                      overflow: 'auto',
                      bgcolor: 'action.hover',
                      borderRadius: 1,
                    }}
                  >
                    {call.result}
                  </Box>
                </Box>
              ))}
            </AccordionDetails>
          </Accordion>
        )}

        {segments.map((segment, index) =>
          segment.kind === 'code' ? (
            <Box
              key={index}
              component="pre"
              sx={{
                my: 1,
                p: 1.5,
                fontFamily: MONOSPACE,
                fontSize: 12.5,
                lineHeight: 1.5,
                overflowX: 'auto',
                bgcolor: 'action.hover',
                borderRadius: 1,
              }}
            >
              <code>{segment.content}</code>
            </Box>
          ) : (
            <Typography key={index} variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
              {segment.content}
            </Typography>
          ),
        )}

        {message.streaming && segments.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            Thinking…
          </Typography>
        ) : null}

        {message.error ? (
          <Alert severity="error" sx={{ mt: 1 }} variant="outlined">
            {message.error}
          </Alert>
        ) : null}
      </Paper>
    </Stack>
  );
};
