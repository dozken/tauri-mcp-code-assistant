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
import { MONOSPACE } from '../theme/theme';
import { Markdown } from '../markdown/Markdown';
import type { ChatMessage } from '../types';

export interface MessageBubbleProps {
  message: ChatMessage;
}

export const MessageBubble = ({ message }: MessageBubbleProps) => {
  const isUser = message.role === 'user';

  return (
    <Stack
      direction="row"
      sx={{ justifyContent: isUser ? 'flex-end' : 'flex-start' }}
      data-testid={`message-${message.role}`}
    >
      <Paper
        variant="outlined"
        sx={{
          maxWidth: isUser ? '75%' : '92%',
          px: 2,
          py: 1.25,
          // `primary.main` with its own `contrastText`, rather than `primary.dark`
          // with inherited body text: MUI guarantees that pair meets contrast in
          // both palettes, and the inherited version was 1.94:1 in light mode.
          bgcolor: isUser ? 'primary.main' : 'background.paper',
          color: isUser ? 'primary.contrastText' : 'text.primary',
          borderColor: isUser ? 'primary.main' : 'divider',
        }}
      >
        {message.toolCalls.length > 0 && (
          <Accordion disableGutters elevation={0} sx={{ bgcolor: 'transparent', mb: 1 }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 0, px: 0 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
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

        <Markdown content={message.content} />

        {message.streaming && message.content.trim() === '' ? (
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
