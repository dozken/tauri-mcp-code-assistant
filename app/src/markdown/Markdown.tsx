import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { MONOSPACE } from '../theme/theme';
import { parseBlocks, type Block, type Inline } from './parse';

export interface MarkdownProps {
  content: string;
}

const HEADING_VARIANTS = {
  1: 'h6',
  2: 'h6',
  3: 'subtitle1',
  4: 'subtitle2',
  5: 'subtitle2',
  6: 'subtitle2',
} as const;

/**
 * Every span becomes an element, never a string of markup — which is what keeps
 * model output off the HTML injection path entirely.
 */
const renderInline = (spans: readonly Inline[]) =>
  spans.map((span, index) => {
    const key = `${span.kind}-${String(index)}`;
    if (span.kind === 'code') {
      return (
        <Box
          key={key}
          component="code"
          sx={{
            fontFamily: MONOSPACE,
            fontSize: '0.875em',
            px: 0.5,
            py: 0.125,
            borderRadius: 0.75,
            bgcolor: 'action.hover',
            // A long identifier must not push the bubble wider than its column.
            overflowWrap: 'anywhere',
          }}
        >
          {span.value}
        </Box>
      );
    }
    if (span.kind === 'strong') {
      return (
        <Box key={key} component="strong" sx={{ fontWeight: 600 }}>
          {renderInline(span.children)}
        </Box>
      );
    }
    if (span.kind === 'emphasis') {
      return (
        <Box key={key} component="em" sx={{ fontStyle: 'italic' }}>
          {renderInline(span.children)}
        </Box>
      );
    }
    return <span key={key}>{span.value}</span>;
  });

const renderBlock = (block: Block, index: number) => {
  const key = `${block.kind}-${String(index)}`;

  switch (block.kind) {
    case 'codeBlock': {
      return (
        <Box
          key={key}
          component="pre"
          // Focusable and labelled: a snippet that scrolls sideways has to be
          // reachable without a mouse.
          tabIndex={0}
          role="region"
          aria-label={block.language ? `${block.language} code snippet` : 'Code snippet'}
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
          <code>{block.content}</code>
        </Box>
      );
    }

    case 'heading': {
      return (
        <Typography
          key={key}
          variant={HEADING_VARIANTS[block.level]}
          component={`h${String(Math.min(block.level + 2, 6))}` as 'h3'}
          sx={{ mt: index === 0 ? 0 : 1.5, mb: 0.5, fontWeight: 600 }}
        >
          {renderInline(block.spans)}
        </Typography>
      );
    }

    case 'list': {
      return (
        <Box
          key={key}
          component={block.ordered ? 'ol' : 'ul'}
          sx={{ my: 0.5, pl: 3, '& li': { mb: 0.25 } }}
        >
          {block.items.map((item, itemIndex) => (
            <Typography key={itemIndex} component="li" variant="body2">
              {renderInline(item)}
            </Typography>
          ))}
        </Box>
      );
    }

    case 'paragraph': {
      return (
        <Typography
          key={key}
          variant="body2"
          // Newlines inside one paragraph are meaningful in an answer about code.
          sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
        >
          {renderInline(block.spans)}
        </Typography>
      );
    }
  }
};

/** Renders the Markdown subset a model actually emits. See `parse.ts`. */
export const Markdown = ({ content }: MarkdownProps) => (
  <>{parseBlocks(content).map((block, index) => renderBlock(block, index))}</>
);
