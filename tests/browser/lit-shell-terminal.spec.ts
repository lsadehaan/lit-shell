import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import {
  expect,
  recordedEvents,
  test,
  visibleTerminalText,
  waitForTestPage,
} from './browser-test.js';
import {
  startBrowserFixture,
  type BrowserFixture,
} from '../fixtures/browser/lit-shell-fixture.js';

let fixture: BrowserFixture;

test.beforeAll(async () => {
  fixture = await startBrowserFixture();
});

test.afterAll(async () => {
  await fixture.close();
});

test('renders the documented controls with accessible semantics', async ({
  page,
  browserErrors: _browserErrors,
}) => {
  await page.goto(
    fixture.pageUrl({
      showConnectionPanel: true,
      showSettings: true,
      showStatusBar: true,
      showTabs: true,
    }),
  );
  await waitForTestPage(page);

  const terminal = page.locator('lit-shell-terminal');
  await expect(
    terminal.getByRole('button', { name: /connect|start session/i }),
  ).toBeVisible();
  await expect(
    terminal.getByRole('button', { name: /settings/i }),
  ).toBeVisible();
  await expect(terminal.getByRole('tablist')).toBeVisible();
  await expect(terminal.getByRole('tab')).toHaveCount(1);

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations,
    accessibility.violations
      .map((violation) => `${violation.id}: ${violation.help}`)
      .join('\n'),
  ).toEqual([]);
});

test('auto-connects, spawns, and carries terminal input and output end to end', async ({
  page,
  browserErrors: _browserErrors,
}) => {
  await page.goto(
    fixture.pageUrl({
      autoConnect: true,
      autoSpawn: true,
      showStatusBar: true,
    }),
  );
  await waitForTestPage(page);
  await expectEvent(page, 'connect');
  const spawned = await expectEvent(page, 'spawned');

  expect(spawned.detail).toMatchObject({
    session: { sessionId: expect.any(String) },
  });
  await expect(page.locator('lit-shell-terminal .xterm:visible')).toBeVisible();

  const marker = `lit-shell-browser-output-${Date.now()}`;
  await sendTerminalCommand(page, `printf '${marker}\\n'`);
  await expect.poll(() => visibleTerminalText(page)).toContain(marker);

  const events = await recordedEvents(page);
  expect(events.findIndex((event) => event.type === 'connect')).toBeLessThan(
    events.findIndex((event) => event.type === 'spawned'),
  );
  expect(events.filter((event) => event.type === 'error')).toEqual([]);
});

test('supports accessible tab creation, selection, and cleanup through the public API', async ({
  page,
  browserErrors: _browserErrors,
}) => {
  await page.goto(fixture.pageUrl({ showTabs: true, showStatusBar: true }));
  await waitForTestPage(page);

  const tabs = await page.evaluate(() => {
    const terminal = (
      window as unknown as {
        litShellTerminal: {
          createTab(label: string): { id: string; label: string };
          switchTab(id: string): void;
        };
      }
    ).litShellTerminal;
    const alpha = terminal.createTab('Alpha shell');
    const beta = terminal.createTab('Beta shell');
    terminal.switchTab(beta.id);
    return {
      alpha: { id: alpha.id, label: alpha.label },
      beta: { id: beta.id, label: beta.label },
    };
  });

  expect(tabs.alpha.id).not.toBe(tabs.beta.id);
  const terminal = page.locator('lit-shell-terminal');
  await expect(
    terminal.getByRole('tab', { name: 'Alpha shell' }),
  ).toBeVisible();
  await expect(
    terminal.getByRole('tab', { name: 'Beta shell' }),
  ).toHaveAttribute('aria-selected', 'true');

  await page.evaluate((tabId) => {
    const terminalElement = (
      window as unknown as {
        litShellTerminal: { closeTab(id: string): void };
      }
    ).litShellTerminal;
    terminalElement.closeTab(tabId);
  }, tabs.beta.id);

  await expect(terminal.getByRole('tab', { name: 'Beta shell' })).toHaveCount(
    0,
  );
  await expect(
    terminal.getByRole('tab', { name: 'Alpha shell' }),
  ).toBeVisible();
});

test('shares a session between tabs and leaving does not kill the owner session', async ({
  page,
  browserErrors: _browserErrors,
}) => {
  await page.goto(fixture.pageUrl({ showTabs: true, showStatusBar: true }));
  await waitForTestPage(page);

  const owner = await createAndSelectTab(page, 'Owner');
  await page.evaluate(async () => {
    const terminal = (
      window as unknown as {
        litShellTerminal: {
          connect(): Promise<void>;
          spawn(options: { allowJoin: boolean }): Promise<void>;
        };
      }
    ).litShellTerminal;
    await terminal.connect();
    await terminal.spawn({ allowJoin: true });
  });
  const spawned = await expectEvent(page, 'spawned');
  const sessionId = sessionIdFrom(spawned.detail);

  const guest = await createAndSelectTab(page, 'Guest');
  await page.evaluate(async (sharedSessionId) => {
    const terminal = (
      window as unknown as {
        litShellTerminal: {
          connect(): Promise<void>;
          join(sessionId: string): Promise<void>;
        };
      }
    ).litShellTerminal;
    await terminal.connect();
    await terminal.join(sharedSessionId);
  }, sessionId);

  const sharedMarker = `lit-shell-shared-output-${Date.now()}`;
  await sendTerminalCommand(page, `printf '${sharedMarker}\\n'`);
  await selectTab(page, owner.id);
  await expect.poll(() => visibleTerminalText(page)).toContain(sharedMarker);

  await selectTab(page, guest.id);
  await page.evaluate(() => {
    const terminal = (
      window as unknown as {
        litShellTerminal: { leave(): void };
      }
    ).litShellTerminal;
    terminal.leave();
  });

  await selectTab(page, owner.id);
  const ownerMarker = `lit-shell-owner-survived-${Date.now()}`;
  await sendTerminalCommand(page, `printf '${ownerMarker}\\n'`);
  await expect.poll(() => visibleTerminalText(page)).toContain(ownerMarker);
});

test('reconnects after a transport interruption and recovers the active session', async ({
  page,
  browserErrors: _browserErrors,
}) => {
  await page.goto(
    fixture.pageUrl({
      autoConnect: true,
      autoSpawn: true,
      showStatusBar: true,
    }),
  );
  await waitForTestPage(page);
  await expectEvent(page, 'spawned');

  const beforeMarker = `lit-shell-before-reconnect-${Date.now()}`;
  await sendTerminalCommand(page, `printf '${beforeMarker}\\n'`);
  await expect.poll(() => visibleTerminalText(page)).toContain(beforeMarker);

  await fixture.disconnectBrowsers();
  await expectEvent(page, 'disconnect');
  await expect
    .poll(
      async () =>
        (await recordedEvents(page)).filter((event) => event.type === 'connect')
          .length,
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(2);

  const afterMarker = `lit-shell-after-reconnect-${Date.now()}`;
  await sendTerminalCommand(page, `printf '${afterMarker}\\n'`);
  await expect
    .poll(() => visibleTerminalText(page), { timeout: 10_000 })
    .toContain(afterMarker);

  const events = await recordedEvents(page);
  expect(events.filter((event) => event.type === 'spawned')).toHaveLength(1);
  expect(events.filter((event) => event.type === 'error')).toEqual([]);
});

async function expectEvent(page: Page, type: string) {
  let matchingEvent:
    Awaited<ReturnType<typeof recordedEvents>>[number] | undefined;
  await expect
    .poll(async () => {
      matchingEvent = (await recordedEvents(page)).find(
        (event) => event.type === type,
      );
      return matchingEvent !== undefined;
    })
    .toBe(true);
  return matchingEvent!;
}

async function sendTerminalCommand(page: Page, command: string): Promise<void> {
  const terminal = page.locator('lit-shell-terminal .xterm:visible');
  await expect(terminal).toBeVisible();
  await terminal.click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

async function createAndSelectTab(
  page: Page,
  label: string,
): Promise<{ id: string; label: string }> {
  return page.evaluate((tabLabel) => {
    const terminal = (
      window as unknown as {
        litShellTerminal: {
          createTab(label: string): { id: string; label: string };
          switchTab(id: string): void;
        };
      }
    ).litShellTerminal;
    const tab = terminal.createTab(tabLabel);
    terminal.switchTab(tab.id);
    return { id: tab.id, label: tab.label };
  }, label);
}

async function selectTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    const terminal = (
      window as unknown as {
        litShellTerminal: { switchTab(id: string): void };
      }
    ).litShellTerminal;
    terminal.switchTab(id);
  }, tabId);
}

function sessionIdFrom(detail: unknown): string {
  if (
    typeof detail !== 'object' ||
    detail === null ||
    !('session' in detail) ||
    typeof detail.session !== 'object' ||
    detail.session === null ||
    !('sessionId' in detail.session) ||
    typeof detail.session.sessionId !== 'string'
  ) {
    throw new Error(
      `spawned event did not contain a session id: ${JSON.stringify(detail)}`,
    );
  }
  return detail.session.sessionId;
}
