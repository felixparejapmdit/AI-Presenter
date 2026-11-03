import { expect, mock, test } from './support/fixtures';
import { generateDeck, SAMPLE_SCRIPT, waitForModels } from './support/helpers';

test.describe('Module B: script studio and AI pipeline', () => {
  test('the sample script gives a first-time user something to try', async ({ app }) => {
    await expect(app.getByTestId('empty-deck')).toBeVisible();
    await app.getByTestId('load-sample').click();
    await expect(app.getByTestId('script-editor')).not.toHaveValue('');
    await expect(app.getByTestId('word-count')).not.toHaveText('0 words');
    await expect(app.getByTestId('load-sample')).toHaveCount(0);
  });

  test('offers all four personas and three tones', async ({ app }) => {
    await app.getByTestId('persona-select').click();
    for (const persona of ['C-Suite Executive', 'Technical Stakeholder', 'Design Review', 'Investor Pitch']) {
      await expect(app.getByRole('option', { name: persona })).toBeVisible();
    }
    await app.getByRole('option', { name: 'Investor Pitch' }).click();
    await expect(app.getByTestId('persona-select')).toContainText('Investor Pitch');

    await app.getByTestId('tone-select').click();
    for (const tone of ['Concise & Direct', 'Persuasive', 'Analytical']) {
      await expect(app.getByRole('option', { name: tone })).toBeVisible();
    }
    await app.getByRole('option', { name: 'Analytical' }).click();
    await expect(app.getByTestId('tone-select')).toContainText('Analytical');
  });

  test('dropdowns work from the keyboard', async ({ app }) => {
    const select = app.getByTestId('tone-select');
    await select.focus();
    await app.keyboard.press('ArrowDown');
    await expect(app.getByRole('listbox')).toBeVisible();
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Enter');
    await expect(select).toContainText('Persuasive');
    await expect(app.getByRole('listbox')).toHaveCount(0);
    await select.focus();
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Escape');
    await expect(app.getByRole('listbox')).toHaveCount(0);
  });

  test('sends a schema-enforced chat request with the chosen persona and tone', async ({ app }) => {
    await waitForModels(app);
    await app.getByTestId('persona-select').click();
    await app.getByRole('option', { name: 'Investor Pitch' }).click();
    await app.getByTestId('tone-select').click();
    await app.getByRole('option', { name: 'Persuasive' }).click();
    await app.getByTestId('script-editor').fill(SAMPLE_SCRIPT);
    await app.getByTestId('analyze-button').click();
    await expect(app.getByTestId('slide-card')).toHaveCount(4, { timeout: 20000 });

    const [request] = await mock.chatRequests();
    const body = request!.body!;
    expect(body.model).toBe('llama3.2:3b');
    expect(body.stream).toBe(true);
    const required = body.format.properties.slides.items.required;
    for (const key of ['slideNumber', 'originalExcerpt', 'refinedTitle', 'executiveSummary', 'speakerNotes', 'layoutType', 'dropzones']) {
      expect(required).toContain(key);
    }
    expect(body.format.properties.slides.items.properties.layoutType.enum).toEqual(['single-visual', 'split-comparison', 'multi-grid', 'statement-only']);
    const system = body.messages[0].content;
    expect(system).toContain('Investor Pitch');
    expect(system).toContain('Persuasive');
    expect(system).toContain('Never use emojis');
    expect(body.messages[1].content).toContain(SAMPLE_SCRIPT);
  });

  test('generated slides carry every field in the plan, with dropzones per layout', async ({ app }) => {
    await generateDeck(app);
    const cards = app.getByTestId('slide-card');
    await expect(cards.nth(0).getByTestId('slide-title')).toHaveValue('Revenue up 38 percent, churn down');
    await expect(cards.nth(0).getByTestId('slide-layout')).toContainText('Single visual');
    await expect(cards.nth(0).getByTestId('dropzone')).toHaveCount(1);
    await expect(cards.nth(0).getByTestId('dropzone')).toContainText('Revenue dashboard screenshot');
    await expect(cards.nth(0).getByTestId('slide-summary')).toContainText;
    await expect(cards.nth(1).getByTestId('slide-layout')).toContainText('Split comparison');
    await expect(cards.nth(1).getByTestId('dropzone')).toHaveCount(2);
    await expect(cards.nth(2).getByTestId('slide-layout')).toContainText('Multi grid');
    await expect(cards.nth(2).getByTestId('dropzone')).toHaveCount(3);
    await expect(cards.nth(3).getByTestId('slide-layout')).toContainText('Statement only');
    await expect(cards.nth(3).getByTestId('dropzone')).toHaveCount(0);

    await cards.nth(0).getByTestId('speaker-notes').locator('summary').click();
    await expect(cards.nth(0).getByTestId('speaker-notes-input')).toHaveValue('Start with the headline number, then explain the driver.');
  });

  test('streams live output while analyzing and can be cancelled', async ({ app }) => {
    await mock.set({ chatDelayMs: 250 });
    await waitForModels(app);
    await app.getByTestId('script-editor').fill(SAMPLE_SCRIPT);
    await app.getByTestId('analyze-button').click();
    await expect(app.getByTestId('analysis-panel')).toBeVisible();
    await expect(app.getByTestId('analysis-live')).toContainText('slides', { timeout: 8000 });

    await app.getByTestId('cancel-analysis').click();
    await expect(app.getByTestId('analysis-panel')).toHaveCount(0);
    await expect(app.getByTestId('analyze-button')).toBeVisible();
    await expect(app.getByTestId('slide-card')).toHaveCount(0);
    await expect(app.locator('[role="status"]').filter({ hasText: 'Analysis cancelled' })).toBeVisible();
  });

  test('recovers from malformed JSON with one repair attempt', async ({ app }) => {
    await mock.set({ chatMode: 'repair', chatDelayMs: 5 });
    await waitForModels(app);
    await app.getByTestId('script-editor').fill(SAMPLE_SCRIPT);
    await app.getByTestId('analyze-button').click();
    await expect(app.getByTestId('slide-card')).toHaveCount(4, { timeout: 20000 });
    const requests = await mock.chatRequests();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.body!.format).toBe('json');
  });

  test('accepts reasoning tags and markdown fences around the JSON', async ({ app }) => {
    await mock.set({ chatMode: 'fenced', chatDelayMs: 5 });
    await generateDeck(app);
    await expect(app.getByTestId('slide-title').first()).toHaveValue('Revenue up 38 percent, churn down');
  });

  test('removes emoji even when a model ignores the prompt', async ({ app }) => {
    await mock.set({ chatMode: 'emoji', chatDelayMs: 5 });
    await waitForModels(app);
    await app.getByTestId('script-editor').fill(SAMPLE_SCRIPT);
    await app.getByTestId('analyze-button').click();
    await expect(app.getByTestId('slide-card')).toHaveCount(1, { timeout: 20000 });
    await expect(app.getByTestId('slide-title')).toHaveValue('Rocket launch ahead');
  });

  test('explains failures and leaves the script intact', async ({ app }) => {
    await waitForModels(app);
    await app.getByTestId('script-editor').fill(SAMPLE_SCRIPT);

    await mock.set({ chatMode: 'garbage', chatDelayMs: 5 });
    await app.getByTestId('analyze-button').click();
    await expect(app.getByTestId('analysis-error')).toContainText('did not produce a usable deck', { timeout: 20000 });
    await expect(app.getByTestId('slide-card')).toHaveCount(0);

    await mock.set({ chatMode: 'error' });
    await app.getByTestId('analyze-button').click();
    await expect(app.getByTestId('analysis-error')).toContainText('model runner has unexpectedly stopped');
    await expect(app.getByTestId('script-editor')).toHaveValue(SAMPLE_SCRIPT);
  });

  test('guards against an empty script and an offline daemon', async ({ app }) => {
    await waitForModels(app);
    await app.getByTestId('analyze-button').click();
    await expect(app.getByTestId('analysis-error')).toContainText('Add a script');

    await app.getByTestId('script-editor').fill(SAMPLE_SCRIPT);
    await mock.set({ online: false });
    await expect(app.getByTestId('ai-status')).toHaveAttribute('data-online', 'false', { timeout: 8000 });
    await app.getByTestId('analyze-button').click();
    await expect(app.getByTestId('analysis-error')).toContainText('Ollama is offline');
  });

  test('builds a deck from an outline with no AI at all', async ({ app }) => {
    await mock.set({ online: false });
    await app.getByTestId('script-editor').fill('## Growth\n- Up 40%\n- Churn down\n\nThe ask is two engineers');
    await app.getByTestId('outline-button').click();
    await expect(app.getByTestId('slide-card')).toHaveCount(2);
    await expect(app.getByTestId('slide-title').first()).toHaveValue('Growth');
    await expect(app.getByTestId('slide-layout').nth(1)).toContainText('Statement only');
  });

  test('the refinement diff compares the script with the AI result', async ({ app }) => {
    await generateDeck(app);
    await app.getByTestId('diff-tab').click();
    await expect(app.getByTestId('diff-view')).toBeVisible();
    await expect(app.getByTestId('diff-row')).toHaveCount(4);
    await expect(app.getByTestId('diff-row').first().locator('.diff-removed').first()).toBeVisible();
    await expect(app.getByTestId('diff-row').first().locator('.diff-added').first()).toBeVisible();
    await app.getByTestId('diff-row').nth(3).getByRole('button').click();
    await expect(app.getByTestId('slide-card').nth(3)).toBeInViewport({ timeout: 5000 });
  });

  test('slash commands open at the caret and insert structure', async ({ app }) => {
    const editor = app.getByTestId('script-editor');
    await editor.click();
    await app.keyboard.type('/');
    const menu = app.getByTestId('slash-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('option')).toHaveCount(6);

    await app.keyboard.type('bul');
    await expect(menu.getByRole('option')).toHaveCount(1);
    await app.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    await expect(editor).toHaveValue('- ');

    await app.keyboard.type('point\n/');
    await expect(menu).toBeVisible();
    await app.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });

  test('a slash command can start the analysis', async ({ app }) => {
    await waitForModels(app);
    const editor = app.getByTestId('script-editor');
    await editor.fill(`${SAMPLE_SCRIPT}\n`);
    await editor.press('End');
    await editor.focus();
    await app.keyboard.press('Control+End');
    await app.keyboard.type('/analyze');
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('slide-card')).toHaveCount(4, { timeout: 20000 });
    await expect(editor).toHaveValue(`${SAMPLE_SCRIPT}\n`);
  });
});

test.describe('Editing slides', () => {
  test('titles, talking points and notes are editable', async ({ app }) => {
    await generateDeck(app);
    const card = app.getByTestId('slide-card').first();
    await card.getByTestId('slide-title').fill('A new headline');
    await expect(app.getByTestId('tree-slide').first()).toContainText('A new headline');

    await card.getByTestId('add-point').click();
    const points = card.getByTestId('slide-summary').locator('textarea');
    await expect(points).toHaveCount(3);
    await points.nth(2).fill('A third point');
    await expect(points.nth(2)).toHaveValue('A third point');

    await card.getByTestId('slide-summary').locator('li').nth(2).hover();
    await card.getByRole('button', { name: 'Remove talking point 3' }).click();
    await expect(points).toHaveCount(2);
  });

  test('slides can be added, reordered and deleted, with undo', async ({ app }) => {
    await generateDeck(app);
    const cards = app.getByTestId('slide-card');

    await cards.first().getByRole('button', { name: 'Move slide down' }).click();
    await expect(cards.nth(1).getByTestId('slide-title')).toHaveValue('Revenue up 38 percent, churn down');
    await expect(cards.nth(1).getByTestId('slide-number')).toHaveText('Slide 2');
    await expect(cards.first().getByRole('button', { name: 'Move slide up' })).toBeDisabled();

    await app.getByTestId('add-slide').click();
    await expect(cards).toHaveCount(5);

    await cards.first().getByTestId('delete-slide').click();
    await expect(cards).toHaveCount(4);
    await expect(cards.first().getByTestId('slide-number')).toHaveText('Slide 1');
    await app.getByRole('button', { name: 'Undo' }).click();
    await expect(cards).toHaveCount(5);
  });

  test('changing the layout adjusts the dropzones', async ({ app }) => {
    await generateDeck(app);
    const card = app.getByTestId('slide-card').first();
    await card.getByTestId('slide-layout').click();
    await app.getByRole('option', { name: 'Multi grid' }).click();
    await expect(card.getByTestId('dropzone')).toHaveCount(3);
    await card.getByTestId('slide-layout').click();
    await app.getByRole('option', { name: 'Statement only' }).click();
    await expect(card.getByTestId('dropzone')).toHaveCount(0);
  });

  test('Ctrl+Z and Ctrl+Shift+Z undo and redo deck changes outside text fields', async ({ app }) => {
    await generateDeck(app);
    const cards = app.getByTestId('slide-card');
    await cards.first().getByTestId('delete-slide').click();
    await expect(cards).toHaveCount(3);
    await app.getByTestId('slide-number').first().click();
    await app.keyboard.press('Control+z');
    await expect(cards).toHaveCount(4);
    await app.keyboard.press('Control+Shift+z');
    await expect(cards).toHaveCount(3);
  });

  test('undo restores the deck and never rolls back the script', async ({ app }) => {
    await generateDeck(app);
    const cards = app.getByTestId('slide-card');
    const editor = app.getByTestId('script-editor');
    await cards.first().getByTestId('delete-slide').click();
    await expect(cards).toHaveCount(3);
    await editor.fill('Paragraphs typed after the deletion');

    await app.getByTestId('slide-number').first().click();
    await app.keyboard.press('Control+z');
    await expect(cards).toHaveCount(4);
    await expect(editor).toHaveValue('Paragraphs typed after the deletion');

    await editor.fill('Newer text');
    await app.getByTestId('slide-number').first().click();
    await app.keyboard.press('Control+Shift+z');
    await expect(cards).toHaveCount(3);
    await expect(editor).toHaveValue('Newer text');
  });

  test('an undo offer disappears once the deck changes, so it cannot undo the wrong thing', async ({ app }) => {
    await generateDeck(app);
    const cards = app.getByTestId('slide-card');
    await cards.first().getByTestId('delete-slide').click();
    const undo = app.getByRole('button', { name: 'Undo' });
    await expect(undo).toBeVisible();
    await cards.first().getByTestId('slide-title').fill('A later edit');
    await expect(undo).toHaveCount(0);
    await expect(cards.first().getByTestId('slide-title')).toHaveValue('A later edit');
  });

  test('generating again offers a way back to the previous slides', async ({ app }) => {
    await generateDeck(app);
    const title = app.getByTestId('slide-title').first();
    await title.fill('My hand-edited headline');
    await app.getByTestId('analyze-button').click();
    await expect(title).toHaveValue('Revenue up 38 percent, churn down', { timeout: 20000 });
    await app.getByRole('button', { name: 'Undo' }).click();
    await expect(title).toHaveValue('My hand-edited headline');
  });

  test('an analysis finishing in another project never overwrites its slides', async ({ app }) => {
    await generateDeck(app);
    await app.getByTestId('slide-title').first().fill('Pin work worth keeping');
    await mock.set({ chatDelayMs: 150 });
    await app.getByTestId('analyze-button').click();
    await expect(app.getByTestId('analysis-panel')).toBeVisible();
    await app.getByTestId('new-project').click();

    // The original, the new one, and a draft holding the analysis result.
    await expect(app.getByTestId('project-node')).toHaveCount(3, { timeout: 20000 });
    await expect(app.getByTestId('project-node').nth(2)).toContainText('(new draft)');

    await app.getByTestId('project-open').first().click();
    await expect(app.getByTestId('slide-title').first()).toHaveValue('Pin work worth keeping');
    await app.getByTestId('project-open').nth(2).click();
    await expect(app.getByTestId('slide-title').first()).toHaveValue('Revenue up 38 percent, churn down');
  });

  test('a response cut off by the context window explains itself without retrying', async ({ app }) => {
    await mock.set({ chatMode: 'truncated', chatDelayMs: 5 });
    await waitForModels(app);
    await app.getByTestId('script-editor').fill(SAMPLE_SCRIPT);
    await app.getByTestId('analyze-button').click();
    await expect(app.getByTestId('analysis-error')).toContainText('too long', { timeout: 20000 });
    expect(await mock.chatRequests()).toHaveLength(1);
  });

  test('a script too long for any context window is refused up front', async ({ app }) => {
    await waitForModels(app);
    await app.getByTestId('script-editor').fill('word '.repeat(14000));
    await app.getByTestId('analyze-button').click();
    await expect(app.getByTestId('analysis-error')).toContainText('too long');
    expect(await mock.chatRequests()).toHaveLength(0);
  });
});
