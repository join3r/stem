// Settings → Models, driven for real: the model you chat with has to reach the
// server, and the shared background model has to be storable.
//
// This is the regression that started the whole roles list. `defaults.model` was
// written ONCE at sign-in and never again, while the model you actually chat
// with lived only in the renderer's localStorage — so every background job (chat
// subjects, memory, skills curation, the safety check) ran forever on whatever
// the wizard picked, and Quick Chat's "Same as main" confidently named it. None
// of that is visible from a unit test: the write-through lives in an App effect,
// and what it writes is only interesting once it has crossed the IPC boundary.
import { test, expect, openSettings } from './electron';

type Defaults = { model: string | null; backgroundModel: string | null; backgroundEffort: string | null };

/**
 * Settings → Models with every role group expanded. The groups fold to a
 * one-line summary ("what runs on what") and only "You chat with these" opens
 * by default, so the pickers these tests drive must be unfolded first.
 */
const openModelRoles = async (win: Parameters<typeof openSettings>[0]): Promise<void> => {
  await openSettings(win, 'Models');
  await win.getByRole('button', { name: /^Judgment work/ }).click();
  // The lookahead keeps this off the "Quick tasks model" picker button.
  await win.getByRole('button', { name: /^Quick tasks(?! model)/ }).click();
};

const readDefaults = (win: Parameters<typeof openSettings>[0]): Promise<Defaults> =>
  win.evaluate(() =>
    (
      window as unknown as { stem: { getSettings(): Promise<{ defaults: Defaults }> } }
    ).stem.getSettings().then((s) => s.defaults)
  );

test('the model you chat with reaches the server, where background jobs can see it', async ({
  mainWindow
}) => {
  await openModelRoles(mainWindow);

  // The picker shows it; the store has to agree, or "same as main" is a guess.
  await expect(mainWindow.getByLabel('Model', { exact: true })).toContainText('Stem E2E model');
  await expect.poll(async () => (await readDefaults(mainWindow)).model).toBe('e2e/stem-e2e-model');
});

test('the background model is its own setting, and starts unset', async ({ mainWindow }) => {
  await openModelRoles(mainWindow);

  // Unset = the quick-tasks roles follow the model you chat with, which is
  // what their pickers say. Nothing is guessed on your behalf.
  const picker = mainWindow.getByLabel('Quick tasks model', { exact: true });
  await expect(picker).toContainText('Same as main');
  expect((await readDefaults(mainWindow)).backgroundModel).toBeNull();

  await picker.click();
  await mainWindow.getByRole('option', { name: 'Stem E2E model' }).click();

  await expect.poll(async () => (await readDefaults(mainWindow)).backgroundModel).toBe('e2e/stem-e2e-model');
  // …and setting it must not clobber the model you chat with, which is patched
  // from a different place on every model change.
  expect((await readDefaults(mainWindow)).model).toBe('e2e/stem-e2e-model');
});

test('each role falls back to its own group, and the judgment roles are not in the cheap one', async ({
  mainWindow
}) => {
  await openModelRoles(mainWindow);

  // The cheap group holds exactly the two extraction jobs. Skills used to be
  // the third member, which meant "point Background work at something small"
  // silently had every skill authored by that small model.
  for (const role of ['Subject model', 'Safety-check model']) {
    await expect(mainWindow.getByLabel(role, { exact: true })).toContainText('Quick tasks');
  }
  // The rest follow the model you chat with, each for its own reason: you read
  // Quick Chat's output word for word; memory and skills are judgment work that
  // CANNOT be made cheap safely — memory reads whole transcripts, and skills
  // writes the library the assistant will follow later. A model too small for
  // either fails quietly, so the cheap knob must not be able to reach them.
  for (const role of ['Quick Chat default model', 'Memory model', 'Skills model']) {
    await expect(mainWindow.getByLabel(role, { exact: true })).toContainText('Same as main');
  }
});

test('effort is a setting on the two roles that chose a model, and it persists', async ({
  mainWindow
}) => {
  await openModelRoles(mainWindow);

  // Unset everywhere = what every background job did before this existed: the
  // model's own default, chosen by pi rather than by anyone.
  expect((await readDefaults(mainWindow)).backgroundEffort).toBeNull();
  const background = mainWindow.getByLabel('Quick tasks effort', { exact: true });
  await expect(background).toHaveValue('');

  await background.selectOption('low');
  await expect.poll(async () => (await readDefaults(mainWindow)).backgroundEffort).toBe('low');
  // Same patch as the background MODEL — one must not blank the other.
  expect((await readDefaults(mainWindow)).backgroundModel).toBeNull();

  // Memory keeps its own, because it is not on the background chain at all.
  await mainWindow.getByLabel('Memory effort', { exact: true }).selectOption('high');
  await expect
    .poll(() =>
      mainWindow.evaluate(() =>
        (window as unknown as { stem: { getSettings(): Promise<{ memory: { effort: string | null } }> } })
          .stem.getSettings()
          .then((s) => s.memory.effort)
      )
    )
    .toBe('high');
  expect((await readDefaults(mainWindow)).backgroundEffort).toBe('low');
});

test('each background job can be told how hard to think, without leaving the group', async ({
  mainWindow
}) => {
  // The two jobs under Quick tasks share a model picker and share an effort the
  // same way: unset means "follow Quick tasks", so turning the group down still
  // turns both down. Skills carries its own level too, but OUTSIDE the group —
  // its empty option means the model's own default, never the cheap level. What
  // this guards is the half-wired version — a select that saves into
  // settings.json and is then read by nobody, or one that quietly writes over
  // the group's own level on its way past.
  await openModelRoles(mainWindow);

  const roleEfforts = async (): Promise<Record<string, string | null>> =>
    mainWindow.evaluate(() =>
      (
        window as unknown as {
          stem: {
            getSettings(): Promise<{
              chats: { subjectEffort: string | null };
              exec: { judgeEffort: string | null };
              skills: { effort: string | null };
            }>;
          };
        }
      ).stem.getSettings().then((s) => ({
        subject: s.chats.subjectEffort,
        judge: s.exec.judgeEffort,
        skills: s.skills.effort
      }))
    );

  for (const label of ['Subject effort', 'Safety-check effort']) {
    const select = mainWindow.getByLabel(label, { exact: true });
    await expect(select).toHaveValue('');
    // The empty option has to name the rung above it. "Model default" would be a
    // lie here: these two follow Quick tasks, not pi.
    await expect(select.locator('option', { hasText: 'Quick tasks' })).toHaveCount(1);
  }
  // Skills is not in the group, and its empty option says what unset really
  // means there — the model's own default.
  const skillsEffort = mainWindow.getByLabel('Skills effort', { exact: true });
  await expect(skillsEffort).toHaveValue('');
  await expect(skillsEffort.locator('option', { hasText: 'Model default' })).toHaveCount(1);
  await expect(skillsEffort.locator('option', { hasText: 'Quick tasks' })).toHaveCount(0);
  expect(await roleEfforts()).toEqual({ subject: null, judge: null, skills: null });

  // Unset is not the same as undecided: with nothing set anywhere the two cheap
  // jobs land on a level chosen for them, and the row says which. This is what
  // stops "sane defaults" from being a comment in a file nobody reads.
  //
  // The subject writer's floor is Off, but the model here offers Low as its
  // lowest — so the row says Low, which is what pi will clamp it to. A note that
  // reported the asked-for level would be wrong in exactly this case.
  const rows = mainWindow.locator('.mp-effort');
  await expect(rows.filter({ has: mainWindow.getByLabel('Subject effort', { exact: true }) })).toContainText(
    'uses Low'
  );
  await expect(rows.filter({ has: mainWindow.getByLabel('Safety-check effort', { exact: true }) })).toContainText(
    'uses Low'
  );

  await mainWindow.getByLabel('Safety-check effort', { exact: true }).selectOption('low');
  await expect.poll(async () => (await roleEfforts()).judge).toBe('low');
  // One role's level is one role's: the others stay unset, and the
  // group's own level is untouched.
  expect(await roleEfforts()).toMatchObject({ subject: null, skills: null });
  expect((await readDefaults(mainWindow)).backgroundEffort).toBeNull();

  await skillsEffort.selectOption('high');
  await expect.poll(async () => (await roleEfforts()).skills).toBe('high');
  expect(await roleEfforts()).toMatchObject({ judge: 'low' });
});
