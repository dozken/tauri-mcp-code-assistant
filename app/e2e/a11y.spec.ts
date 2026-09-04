import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * `jsx-a11y` checks what it can see in the source; axe checks the rendered tree —
 * contrast against the actual theme, focus order, names computed from MUI's own
 * markup. The two catch different things, and only this one runs on real output.
 */
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('connection-status')).toHaveText('connected');
});

test('the empty state has no accessibility violations', async ({ page }) => {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  expect(violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
});

test('a rendered conversation has no accessibility violations', async ({ page }) => {
  await page.getByTestId('chat-input').fill('Where is authentication handled?');
  await page.getByTestId('send-button').click();
  await expect(page.getByTestId('message-assistant').first()).toBeVisible();

  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  expect(violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
});

test('the folder dialog is reachable and labelled', async ({ page }) => {
  await page.getByTestId('add-folder').click();
  await expect(page.getByTestId('manual-path')).toBeFocused();

  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  expect(violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
});
