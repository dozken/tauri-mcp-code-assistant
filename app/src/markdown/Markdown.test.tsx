import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { Markdown } from './Markdown';
import { theme } from '../theme/theme';

const show = (content: string) =>
  render(
    <ThemeProvider theme={theme}>
      <Markdown content={content} />
    </ThemeProvider>,
  );

describe('Markdown', () => {
  it('renders emphasis as real elements, never as markup', () => {
    const { container } = show('**bold** and _italic_ and `code`');

    expect(container.querySelector('strong')).toHaveTextContent('bold');
    expect(container.querySelector('em')).toHaveTextContent('italic');
    expect(container.querySelector('code')).toHaveTextContent('code');
  });

  it('renders a heading at the level the model asked for', () => {
    show('## How authentication works');

    expect(screen.getByRole('heading', { name: 'How authentication works' })).toBeInTheDocument();
  });

  it('renders an unordered list as a ul with one item per line', () => {
    const { container } = show('- first\n- second');

    expect(container.querySelector('ul')).toBeInTheDocument();
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  it('renders an ordered list as an ol', () => {
    const { container } = show('1. first\n2. second');

    expect(container.querySelector('ol')).toBeInTheDocument();
  });

  it('labels a code block by language and makes it reachable by keyboard', () => {
    // A snippet that scrolls sideways is unusable if it cannot be focused.
    show('```typescript\nconst a = 1;\n```');

    const block = screen.getByRole('region', { name: 'typescript code snippet' });
    expect(block).toHaveAttribute('tabindex', '0');
    expect(block).toHaveTextContent('const a = 1;');
  });

  it('colours a snippet without changing a character of it', () => {
    // `parseBlocks` hands back the fence body without its trailing newline.
    const source = 'const answer = 42; // why';
    const { container } = show(`\`\`\`ts\n${source}\n\`\`\``);

    const code = container.querySelector('pre code');
    // The rendered text is the source: highlighting adds spans, never content.
    expect(code?.textContent).toBe(source);
    expect([...(code?.querySelectorAll('span') ?? [])].map((span) => span.className)).toEqual([
      'tok-keyword',
      'tok-punctuation',
      'tok-number',
      'tok-punctuation',
      'tok-comment',
    ]);
  });

  it('leaves a language it does not know uncoloured rather than guessing', () => {
    const { container } = show('```brainfuck\n+[----->+++<]>+.\n```');

    const code = container.querySelector('pre code');
    expect(code?.querySelectorAll('span')).toHaveLength(0);
    expect(code?.textContent).toBe('+[----->+++<]>+.');
  });

  it('still labels a code block that carries no language', () => {
    show('```\nplain\n```');

    expect(screen.getByRole('region', { name: 'Code snippet' })).toBeInTheDocument();
  });

  it('renders nested marks, so a variable inside an italic run is still code', () => {
    const { container } = show('_set `API_KEY` first_');

    const emphasis = container.querySelector('em');
    expect(emphasis?.querySelector('code')).toHaveTextContent('API_KEY');
  });

  it('leaves an identifier that merely looks like markup alone', () => {
    const { container } = show('call some_long_name_here first');

    expect(container.querySelector('em')).toBeNull();
    expect(container).toHaveTextContent('call some_long_name_here first');
  });

  it('renders nothing for empty content rather than an empty paragraph', () => {
    const { container } = show('   ');

    expect(container).toBeEmptyDOMElement();
  });
});
