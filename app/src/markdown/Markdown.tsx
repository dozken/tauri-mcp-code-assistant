import { memo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import * as styles from './Markdown.styles';
import * as copyStyles from './CopyButton.styles';
import { CopyButton } from './CopyButton';
import { highlight } from './highlight';
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
        <Box key={key} component="code" sx={styles.codeSpan}>
          {span.value}
        </Box>
      );
    }
    if (span.kind === 'strong') {
      return (
        <Box key={key} component="strong" sx={styles.strong}>
          {renderInline(span.children)}
        </Box>
      );
    }
    if (span.kind === 'emphasis') {
      return (
        <Box key={key} component="em" sx={styles.emphasis}>
          {renderInline(span.children)}
        </Box>
      );
    }
    return <span key={key}>{span.value}</span>;
  });

interface CodeBlockProps {
  readonly content: string;
  readonly language?: string;
}

/**
 * Memoised on its own text: an answer with three snippets re-renders on every
 * streamed token, and only the last block is ever the one that changed.
 */
const CodeBlock = memo(({ content, language }: CodeBlockProps) => (
  <Box sx={copyStyles.anchor}>
    <Box sx={copyStyles.corner}>
      <CopyButton value={content} label="snippet" className={copyStyles.REVEAL_ON_HOVER} />
    </Box>
    <Box
      component="pre"
      // Focusable and labelled: a snippet that scrolls sideways has to be
      // reachable without a mouse.
      tabIndex={0}
      role="region"
      aria-label={language ? `${language} code snippet` : 'Code snippet'}
      sx={styles.codeBlock}
    >
      <code>
        {highlight(content, language).map((token, index) =>
          // Plain runs stay bare text: a span that carries no colour is a DOM node
          // per line of indentation and nothing else.
          token.kind === 'plain' ? (
            token.value
          ) : (
            <span key={`${String(index)}-${token.kind}`} className={styles.tokenClass(token.kind)}>
              {token.value}
            </span>
          ),
        )}
      </code>
    </Box>
  </Box>
));
CodeBlock.displayName = 'CodeBlock';

const renderBlock = (block: Block, index: number) => {
  const key = `${block.kind}-${String(index)}`;

  switch (block.kind) {
    case 'codeBlock': {
      return <CodeBlock key={key} content={block.content} language={block.language} />;
    }

    case 'heading': {
      return (
        <Typography
          key={key}
          variant={HEADING_VARIANTS[block.level]}
          component={`h${String(Math.min(block.level + 2, 6))}` as 'h3'}
          sx={styles.heading[index === 0 ? 'first' : 'later']}
        >
          {renderInline(block.spans)}
        </Typography>
      );
    }

    case 'list': {
      return (
        <Box key={key} component={block.ordered ? 'ol' : 'ul'} sx={styles.list}>
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
        <Typography key={key} variant="body2" sx={styles.paragraph}>
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
