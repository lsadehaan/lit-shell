import { expect, test as base } from '@playwright/test';

interface BrowserObservability {
  browserErrors: string[];
}

export const test = base.extend<BrowserObservability>({
  browserErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      errors.push(`pageerror: ${error.stack ?? error.message}`);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(`console.error: ${message.text()}`);
      }
    });

    await use(errors);

    expect(
      errors,
      'the page must not emit uncaught errors or console errors',
    ).toEqual([]);
  },
});

export { expect } from '@playwright/test';

export interface RecordedEvent {
  type: string;
  detail: unknown;
  timestamp: number;
}

export async function recordedEvents(
  page: import('@playwright/test').Page,
): Promise<RecordedEvent[]> {
  return page.evaluate(() => {
    return (window as unknown as { litShellEvents: RecordedEvent[] })
      .litShellEvents;
  });
}

export async function waitForTestPage(
  page: import('@playwright/test').Page,
): Promise<void> {
  await page.waitForFunction(() => {
    return (
      (window as unknown as { litShellReady?: boolean }).litShellReady === true
    );
  });
  await expect(page.locator('lit-shell-terminal')).toBeVisible();
}

export async function visibleTerminalText(
  page: import('@playwright/test').Page,
): Promise<string> {
  return page
    .locator('lit-shell-terminal .xterm:visible')
    .evaluateAll((terminals) => {
      return terminals.map((terminal) => terminal.textContent ?? '').join('\n');
    });
}
