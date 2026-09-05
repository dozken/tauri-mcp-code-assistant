import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { API_ROUTES, type IndexStatus } from '@ai-code-companion/contracts';

/**
 * `jsx-a11y` checks what it can see in the source; axe checks the rendered tree —
 * contrast against the actual theme, focus order, names computed from MUI's own
 * markup. The two catch different things, and only this one runs on real output.
 */
const scan = async (page: Page): Promise<string[]> => {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return violations.map((violation) => `${violation.id}: ${violation.help}`);
};

/**
 * The sidebar only renders its folder rows — and the chips on them — when the
 * backend reports roots, and a root is only `stale` after a restart. Waiting for
 * that to happen by chance is what hid a real bug: `warning.main` failed contrast
 * in light mode, and the scans caught it only on runs where a folder left over
 * from the previous run happened to come back stale. Stubbing `/status` puts
 * every chip on screen on every run instead.
 */
const POPULATED: IndexStatus = {
  activeJob: null,
  vectorStore: 'chroma',
  metadataStore: 'sqlite',
  totalChunks: 271,
  roots: [
    {
      path: '/home/dev/service',
      fileCount: 65,
      chunkCount: 263,
      lastIndexedAt: '2026-01-01T00:00:00.000Z',
      stale: false,
    },
    {
      path: '/home/dev/tooling',
      fileCount: 2,
      chunkCount: 8,
      lastIndexedAt: '2026-01-01T00:00:00.000Z',
      stale: true,
    },
  ],
};

const stubStatus = async (page: Page): Promise<void> => {
  await page.route(`**${API_ROUTES.status}`, async (route) => {
    await route.fulfill({ json: POPULATED });
  });
};

/**
 * Both themes, because contrast is the one violation class that is invisible in
 * source and differs entirely between palettes: the two are different hues, not
 * the same hue inverted, so passing in one says nothing about the other.
 */
for (const colorScheme of ['dark', 'light'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.getByTestId('connection-status')).toHaveText('connected');
    });

    test('the empty state has no accessibility violations', async ({ page }) => {
      expect(await scan(page)).toEqual([]);
    });

    test('a rendered conversation has no accessibility violations', async ({ page }) => {
      await page.getByTestId('chat-input').fill('Where is authentication handled?');
      await page.getByTestId('send-button').click();
      await expect(page.getByTestId('message-assistant').first()).toBeVisible();

      expect(await scan(page)).toEqual([]);
    });

    test('a populated folder list has no accessibility violations', async ({ page }) => {
      await stubStatus(page);
      await page.reload();
      await expect(page.getByTestId('connection-status')).toHaveText('connected');
      await expect(page.getByText('needs re-index')).toBeVisible();

      expect(await scan(page)).toEqual([]);
    });

    test('the folder dialog is reachable and labelled', async ({ page }) => {
      await page.getByTestId('add-folder').click();
      await expect(page.getByTestId('manual-path')).toBeFocused();

      expect(await scan(page)).toEqual([]);
    });
  });
}

/** The narrow layout swaps the permanent drawer for an overlay behind a button. */
test.describe('compact width', () => {
  // Light is Playwright's default anyway; naming it keeps this from silently
  // changing engine if that default ever does.
  test.use({ viewport: { width: 560, height: 800 }, colorScheme: 'light' });

  test('opens the folder list from the app bar without violations', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toHaveText('connected');

    await page.getByRole('button', { name: 'Show indexed folders' }).click();
    await expect(page.getByTestId('add-folder')).toBeVisible();

    expect(await scan(page)).toEqual([]);
  });
});
