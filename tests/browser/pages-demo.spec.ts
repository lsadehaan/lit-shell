import { AxeBuilder } from '@axe-core/playwright';
import type { Page, Request, Response, WebSocket } from '@playwright/test';
import { expect, test } from './browser-test.js';
import {
  startPagesDemoFixture,
  type PagesDemoFixture,
} from '../fixtures/browser/pages-demo-fixture.js';

let fixture: PagesDemoFixture;

test.beforeAll(async () => {
  fixture = await startPagesDemoFixture();
});

test.afterAll(async () => {
  await fixture.close();
});

test('loads the exact static artifact from the GitHub project subpath', async ({
  page,
  browserErrors: _browserErrors,
}) => {
  const observations = observeNetwork(page);
  await loadDemo(page);

  expect(observations.failures, 'all static requests must succeed').toEqual([]);
  expect(observations.webSockets, 'the demo must open no WebSocket').toEqual(
    [],
  );
  expect(
    observations.dynamicRequests,
    'the demo must make no API call',
  ).toEqual([]);

  for (const request of observations.requests) {
    const url = new URL(request.url());
    expect(url.origin).toBe(fixture.origin);
    expect(url.pathname).toMatch(/^\/lit-shell\//u);
  }
  for (const response of observations.responses) {
    expect(response.ok(), `${response.status()} ${response.url()}`).toBe(true);
  }

  const requestedPaths = [
    ...new Set(observations.requests.map((request) => request.url())),
  ]
    .map((url) => new URL(url).pathname)
    .sort();
  expect(requestedPaths).toEqual(
    expect.arrayContaining([
      '/lit-shell/',
      '/lit-shell/assets/demo.js',
      '/lit-shell/style.css',
    ]),
  );
  expect(
    requestedPaths.filter(
      (path) =>
        ![
          '/lit-shell/',
          '/lit-shell/assets/demo.js',
          '/lit-shell/favicon.svg',
          '/lit-shell/style.css',
        ].includes(path),
    ),
    'the page must request only allowlisted artifact files',
  ).toEqual([]);
});

test('runs allowlisted commands and rejects unsupported commands without a backend', async ({
  page,
  browserErrors: _browserErrors,
}) => {
  const observations = observeNetwork(page);
  await loadDemo(page);

  await sendTerminalCommand(page, 'help');
  await expect
    .poll(() => demoTerminalText(page), { timeout: 10_000 })
    .toContain('Available simulated commands');

  await sendTerminalCommand(page, 'echo pages-demo-ok');
  await expect
    .poll(() => demoTerminalText(page), { timeout: 10_000 })
    .toContain('pages-demo-ok');

  await sendTerminalCommand(page, 'cat README.md');
  await expect
    .poll(() => demoTerminalText(page), { timeout: 10_000 })
    .toContain('static, safe simulation');

  await sendTerminalCommand(page, 'curl https://example.test/private');
  await expect
    .poll(() => demoTerminalText(page), { timeout: 10_000 })
    .toContain('Command "curl" is not available in this browser demo.');

  await sendTerminalCommand(page, 'clear');
  await expect
    .poll(() => demoTerminalText(page), { timeout: 10_000 })
    .not.toContain('SAFE SIMULATION');

  const component = page.locator('lit-shell-terminal');
  await component.getByRole('button', { name: 'Stop' }).click();
  await expect(component.getByRole('button', { name: 'Start' })).toBeVisible();
  await component.getByRole('button', { name: 'Start' }).click();
  await expect(component.getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect
    .poll(() => demoTerminalText(page), { timeout: 10_000 })
    .toContain('SAFE SIMULATION');

  expect(observations.webSockets).toEqual([]);
  expect(observations.dynamicRequests).toEqual([]);
});

test('is accessible after the live terminal has initialized', async ({
  page,
  browserErrors: _browserErrors,
}) => {
  await loadDemo(page);

  await expect(page.getByRole('main')).toBeVisible();
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'See the real lit-shell UI, safely.',
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: 'No server. No PTY. No OS commands.',
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Simulated terminal input' }),
  ).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations,
    accessibility.violations
      .map((violation) => `${violation.id}: ${violation.help}`)
      .join('\n'),
  ).toEqual([]);
});

test('honors its static CSP and fits a narrow mobile viewport', async ({
  page,
  browserErrors: _browserErrors,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installCspRecorder(page);
  await loadDemo(page, false);

  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("connect-src 'none'");
  expect(await cspViolations(page)).toEqual([]);
  await expect(page.locator('html')).not.toHaveAttribute('data-csp-violation');

  const dimensions = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    terminalRight:
      document.querySelector('lit-shell-terminal')?.getBoundingClientRect()
        .right ?? Number.POSITIVE_INFINITY,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(
    dimensions.viewportWidth,
  );
  expect(dimensions.terminalRight).toBeLessThanOrEqual(
    dimensions.viewportWidth,
  );
});

async function loadDemo(page: Page, installCsp = true): Promise<void> {
  if (installCsp) await installCspRecorder(page);
  await page.goto(fixture.pageUrl);
  await expect(page.locator('[data-demo-status]')).toContainText('Ready.');
  const terminal = page.locator('lit-shell-terminal .xterm');
  await expect(terminal).toBeVisible();
  await terminal.scrollIntoViewIfNeeded();
  await expect
    .poll(() => demoTerminalText(page), { timeout: 15_000 })
    .toContain('guest@lit-shell:~$');
}

async function demoTerminalText(page: Page): Promise<string> {
  return page
    .locator('lit-shell-terminal .xterm:visible .xterm-rows')
    .evaluateAll((rows) => rows.map((row) => row.textContent ?? '').join('\n'));
}

async function sendTerminalCommand(page: Page, command: string): Promise<void> {
  const terminal = page.locator('lit-shell-terminal .xterm:visible');
  await expect(terminal).toBeVisible();
  await terminal.click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

async function installCspRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const violations: string[] = [];
    (
      window as unknown as { litShellCspViolations: string[] }
    ).litShellCspViolations = violations;
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push(`${event.violatedDirective}: ${event.blockedURI}`);
    });
  });
}

async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (window as unknown as { litShellCspViolations?: string[] })
        .litShellCspViolations ?? [],
  );
}

function observeNetwork(page: Page): {
  requests: Request[];
  responses: Response[];
  failures: string[];
  dynamicRequests: string[];
  webSockets: string[];
} {
  const observations = {
    requests: [] as Request[],
    responses: [] as Response[],
    failures: [] as string[],
    dynamicRequests: [] as string[],
    webSockets: [] as string[],
  };
  page.on('request', (request) => {
    observations.requests.push(request);
    if (['fetch', 'xhr'].includes(request.resourceType())) {
      observations.dynamicRequests.push(request.url());
    }
  });
  page.on('response', (response) => observations.responses.push(response));
  page.on('requestfailed', (request) => {
    observations.failures.push(
      `${request.url()}: ${request.failure()?.errorText ?? 'unknown failure'}`,
    );
  });
  page.on('websocket', (socket: WebSocket) => {
    observations.webSockets.push(socket.url());
  });
  return observations;
}
