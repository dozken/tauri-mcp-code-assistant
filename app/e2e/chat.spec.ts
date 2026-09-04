import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const backendSrc = fileURLToPath(new URL('../../backend/src', import.meta.url));

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // Socket.IO has to connect before the composer is enabled.
  await expect(page.getByTestId('connection-status')).toHaveText('connected');
});

test('answers a question with a grounded, streamed response', async ({ page }) => {
  await page.getByTestId('chat-input').fill('Where is authentication handled?');
  await page.getByTestId('send-button').click();

  await expect(page.getByTestId('message-user')).toHaveText(/Where is authentication handled\?/);

  const assistant = page.getByTestId('message-assistant').first();
  await expect(assistant).toBeVisible();
  await expect(assistant).toContainText('Offline stub model');

  // The agent must have gone through the retrieval tool before answering.
  await expect(assistant.getByText(/^search_code · \d+ms$/)).toBeVisible();

  // Once the turn ends the composer accepts input again (the send button stays
  // disabled only because the draft is empty).
  await expect(page.getByTestId('chat-input')).toBeEditable();
  await page.getByTestId('chat-input').fill('follow-up');
  await expect(page.getByTestId('send-button')).toBeEnabled();
});

test('indexes a folder and then cites files from it', async ({ page }) => {
  await page.getByTestId('add-folder').click();
  await page.getByTestId('manual-path').fill(backendSrc);
  await page.getByTestId('manual-path-submit').click();

  // Progress appears, then the folder lands in the sidebar with a chunk count.
  const rootList = page.getByTestId('root-list');
  await expect(rootList).toContainText(backendSrc, { timeout: 60_000 });
  await expect(rootList).toContainText(/\d+ files · \d+ chunks/, { timeout: 60_000 });

  await page.getByTestId('chat-input').fill('how are files chunked?');
  await page.getByTestId('send-button').click();

  // Grounding, not ranking: the answer must cite a real file:line range from the
  // folder we just indexed. Asserting one specific filename would make the test
  // hostage to retrieval scores.
  const assistant = page.getByTestId('message-assistant').first();
  await expect(assistant).toContainText(/[\w-]+\.ts:\d+-\d+/, { timeout: 30_000 });
  await expect(assistant.getByText(/^search_code · \d+ms$/)).toBeVisible();
});

test('rejects a folder outside the allowed roots with a readable error', async ({ page }) => {
  await page.getByTestId('add-folder').click();
  await page.getByTestId('manual-path').fill('/etc');
  await page.getByTestId('manual-path-submit').click();

  await expect(page.getByText(/outside the allowed roots/)).toBeVisible();
});
