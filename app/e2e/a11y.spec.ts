import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

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
 * Both themes, because contrast is the one violation class that is invisible in
 * source and differs entirely between palettes. A light-mode regression would
 * otherwise ship unnoticed: the default test browser is dark.
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

    test('the folder dialog is reachable and labelled', async ({ page }) => {
      await page.getByTestId('add-folder').click();
      await expect(page.getByTestId('manual-path')).toBeFocused();

      expect(await scan(page)).toEqual([]);
    });
  });
}

/** The narrow layout swaps the permanent drawer for an overlay behind a button. */
test.describe('compact width', () => {
  test.use({ viewport: { width: 560, height: 800 } });

  test('opens the folder list from the app bar without violations', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toHaveText('connected');

    await page.getByRole('button', { name: 'Show indexed folders' }).click();
    await expect(page.getByTestId('add-folder')).toBeVisible();

    expect(await scan(page)).toEqual([]);
  });
});
