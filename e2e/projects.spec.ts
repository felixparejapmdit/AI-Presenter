import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, launchDesktopApp, MOCK_URL, test, waitForApp } from './support/fixtures';
import { generateDeck } from './support/helpers';

test.describe('Sidebar and projects', () => {
  test('creates, renames and deletes projects, and the tree reflects them', async ({ app }) => {
    const nodes = app.getByTestId('project-node');
    await expect(nodes).toHaveCount(1);

    await app.getByTestId('new-project').click();
    await expect(nodes).toHaveCount(2);
    await expect(nodes.nth(1)).toHaveAttribute('data-active', 'true');

    await nodes.nth(1).hover();
    await nodes.nth(1).getByTestId('project-rename').click();
    const input = app.getByTestId('project-rename-input');
    await input.fill('Northwind QBR');
    await input.press('Enter');
    await expect(nodes.nth(1).getByTestId('project-name')).toHaveText('Northwind QBR');
    await expect(app.getByTestId('breadcrumb-project')).toHaveText('Northwind QBR');

    await nodes.nth(1).hover();
    await nodes.nth(1).getByTestId('project-delete').click();
    await expect(app.getByTestId('confirm-dialog')).toBeVisible();
    await app.getByTestId('confirm-accept').click();
    await expect(nodes).toHaveCount(1);
    await expect(app.getByTestId('confirm-dialog')).toHaveCount(0);
  });

  test('cancelling a rename keeps the name, and an empty rename is refused', async ({ app }) => {
    const node = app.getByTestId('project-node').first();
    const original = await node.getByTestId('project-name').textContent();
    await node.getByTestId('project-open').dblclick();
    await app.getByTestId('project-rename-input').fill('Discarded');
    await app.getByTestId('project-rename-input').press('Escape');
    await expect(node.getByTestId('project-name')).toHaveText(original!);

    await node.getByTestId('project-open').dblclick();
    await app.getByTestId('project-rename-input').fill('   ');
    await app.getByTestId('project-rename-input').press('Enter');
    await expect(node.getByTestId('project-name')).toHaveText(original!);
  });

  test('switching projects swaps the script and slides', async ({ app }) => {
    await app.getByTestId('script-editor').fill('First project script');
    await app.getByTestId('new-project').click();
    await expect(app.getByTestId('script-editor')).toHaveValue('');
    await app.getByTestId('script-editor').fill('Second project script');
    await app.getByTestId('project-open').first().click();
    await expect(app.getByTestId('script-editor')).toHaveValue('First project script');
  });

  test('the sidebar collapses, restores and remembers its state', async ({ app }) => {
    await app.getByTestId('collapse-sidebar').click();
    await expect(app.getByTestId('sidebar')).toHaveCount(0);
    await app.getByTestId('expand-sidebar').click();
    await expect(app.getByTestId('sidebar')).toBeVisible();

    await app.keyboard.press('Control+\\');
    await expect(app.getByTestId('sidebar')).toHaveCount(0);
    await app.waitForTimeout(200);
    await app.reload();
    await app.waitForSelector('[data-testid="app-shell"]');
    await expect(app.getByTestId('sidebar')).toHaveCount(0);
  });

  test('the project tree lists slides and jumps to them', async ({ app }) => {
    await generateDeck(app);
    const treeSlides = app.getByTestId('tree-slide');
    await expect(treeSlides).toHaveCount(4);
    await expect(treeSlides.first()).toContainText('Revenue up 38 percent');

    await treeSlides.nth(3).click();
    await expect(app.getByTestId('slide-card').nth(3)).toBeInViewport({ timeout: 5000 });
  });

  test('work persists across a restart, including slides and settings', async ({ app }) => {
    await generateDeck(app);
    await app.getByTestId('slide-title').first().fill('Edited headline');
    await expect(app.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');

    await app.reload();
    await app.waitForSelector('[data-testid="app-shell"]');
    await expect(app.getByTestId('slide-card')).toHaveCount(4);
    await expect(app.getByTestId('slide-title').first()).toHaveValue('Edited headline');
    await expect(app.getByTestId('script-editor')).not.toHaveValue('');
  });

  test('saving shows progress and Ctrl+S flushes immediately', async ({ app }) => {
    await app.getByTestId('script-editor').fill('Saved right now');
    await expect(app.getByTestId('save-state')).toHaveAttribute('data-state', 'pending');
    await app.keyboard.press('Control+s');
    await expect(app.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
    await app.reload();
    await app.waitForSelector('[data-testid="app-shell"]');
    await expect(app.getByTestId('script-editor')).toHaveValue('Saved right now');
  });

  test('edits made just before closing the window are saved', async ({ mode }) => {
    test.skip(mode === 'web', 'Only the desktop app has a window to close');
    const dataDir = mkdtempSync(join(tmpdir(), 'vanguard-close-data-'));
    const profileDir = mkdtempSync(join(tmpdir(), 'vanguard-close-profile-'));

    const first = await launchDesktopApp({ ollamaUrl: MOCK_URL, dataDir, profileDir, keepData: true });
    await waitForApp(first.page);
    await first.page.getByTestId('script-editor').fill('Typed a moment before closing');
    // Without /F this posts WM_CLOSE, which is what the title bar button and Alt+F4 send.
    execSync(`taskkill /PID ${first.process.pid}`, { stdio: 'ignore' });
    await new Promise<void>((resolve) => {
      if (first.process.exitCode !== null) resolve();
      else first.process.once('exit', () => resolve());
    });
    await first.close();

    const second = await launchDesktopApp({ ollamaUrl: MOCK_URL, dataDir, profileDir, keepData: true });
    try {
      await waitForApp(second.page);
      await expect(second.page.getByTestId('script-editor')).toHaveValue('Typed a moment before closing');
    } finally {
      await second.close();
    }
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
});
