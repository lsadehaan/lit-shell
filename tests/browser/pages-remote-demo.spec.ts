import { AxeBuilder } from '@axe-core/playwright';
import type { Page, Request, WebSocketRoute } from '@playwright/test';

import { expect, test } from './browser-test.js';
import {
  startPagesDemoFixture,
  type PagesDemoFixture,
} from '../fixtures/browser/pages-demo-fixture.js';

const backendOrigin = 'https://remote.example.test';
const capability = 'a'.repeat(43);
const turnstileScriptUrl =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const turnstileToken = 'turnstile-test-token';
const remoteCsp = (connectSource: string, turnstile: boolean) =>
  `default-src 'none'; base-uri 'none'; connect-src ${connectSource}; font-src 'self'; form-action 'none'; frame-src ${turnstile ? 'https://challenges.cloudflare.com' : "'none'"}; img-src 'self' data:; object-src 'none'; script-src ${turnstile ? "'self' https://challenges.cloudflare.com" : "'self'"}; style-src 'self' 'unsafe-inline'`;

let disabledFixture: PagesDemoFixture;
let enabledFixture: PagesDemoFixture;

test.beforeAll(async () => {
  [disabledFixture, enabledFixture] = await Promise.all([
    startPagesDemoFixture(),
    startPagesDemoFixture({ siteDirectory: '_site-enabled' }),
  ]);
});

test.afterAll(async () => {
  await Promise.all([disabledFixture.close(), enabledFixture.close()]);
});

test('is inert and network-disabled until a backend origin is configured', async ({
  page,
  browserErrors: _browserErrors,
}) => {
  const dynamicRequests: string[] = [];
  const webSockets: string[] = [];
  page.on('request', (request) => {
    if (['fetch', 'xhr'].includes(request.resourceType())) {
      dynamicRequests.push(request.url());
    }
  });
  page.on('websocket', (socket) => webSockets.push(socket.url()));

  await page.goto(disabledFixture.remotePageUrl);

  await expect(
    page.getByRole('button', { name: 'Start real demo' }),
  ).toBeDisabled();
  await expect(page.locator('[data-remote-status]')).toContainText(
    'not connected yet',
  );
  await expect(
    page.getByRole('link', { name: 'Register interest or leave feedback' }),
  ).toHaveAttribute(
    'href',
    'https://github.com/lsadehaan/lit-shell/discussions/34',
  );
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(csp).toBe(remoteCsp("'none'", false));
  expect(dynamicRequests).toEqual([]);
  expect(webSockets).toEqual([]);

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test('keeps the visible human-verification panel accessible', async ({
  page,
  browserErrors: _browserErrors,
}) => {
  await installTurnstileMock(page, { autoComplete: false });

  await page.goto(enabledFixture.remotePageUrl);
  await page.getByRole('button', { name: 'Start real demo' }).click();

  await expect(page.locator('[data-turnstile-panel]')).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Human verification' }),
  ).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test('reuses one pending Turnstile script when a timed-out load finishes late', async ({
  page,
  browserErrors: _browserErrors,
}) => {
  await page.clock.install();
  await installAdmissionBackendMock(page);
  await page.routeWebSocket(
    `${backendOrigin.replace('https:', 'wss:')}/terminal`,
    (route) => installProtocolMock(route, []),
  );
  let releaseScript: () => void = () => undefined;
  const scriptMayLoad = new Promise<void>((resolve) => {
    releaseScript = resolve;
  });
  let scriptRequests = 0;
  await page.route(turnstileScriptUrl, async (route) => {
    scriptRequests += 1;
    await scriptMayLoad;
    await route.fulfill({
      body: turnstileMockSource(),
      contentType: 'text/javascript',
      status: 200,
    });
  });

  await page.goto(enabledFixture.remotePageUrl);
  await page.getByRole('button', { name: 'Start real demo' }).click();
  await expect.poll(() => scriptRequests).toBe(1);
  await page.clock.fastForward(20_001);
  await expect(page.locator('[data-remote-status]')).toContainText(
    'did not load in time',
  );

  await page.getByRole('button', { name: 'Start real demo' }).click();
  await expect.poll(() => scriptRequests).toBe(1);
  releaseScript();

  await expect(page.locator('[data-remote-status]')).toContainText('Connected');
  expect(scriptRequests).toBe(1);
  await expect(page.locator(`script[src="${turnstileScriptUrl}"]`)).toHaveCount(
    1,
  );
});

test('starts only on click and keeps the one-use capability out of URLs and storage', async ({
  page,
  browserErrors: _browserErrors,
}) => {
  const backendRequests: Request[] = [];
  const webSocketUrls: string[] = [];
  const routedWebSocketUrls: string[] = [];
  const routedWebSocketProtocols: string[][] = [];
  const spawnOptions: Record<string, unknown>[] = [];
  await installTurnstileMock(page);
  await page.route(`${backendOrigin}/**`, async (route) => {
    backendRequests.push(route.request());
    const url = new URL(route.request().url());
    const commonHeaders = {
      'access-control-allow-origin': enabledFixture.origin,
      'access-control-expose-headers': 'Retry-After',
      'cache-control': 'no-store',
    };
    if (url.pathname === '/health/ready') {
      await route.fulfill({
        body: JSON.stringify({ status: 'ready' }),
        contentType: 'application/json',
        headers: commonHeaders,
        status: 200,
      });
      return;
    }
    if (url.pathname === '/v1/admissions') {
      await route.fulfill({
        body: JSON.stringify({
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          protocol: 'lit-shell.v1',
          resetAt: new Date(Date.now() + 240_000).toISOString(),
          sessionLifetimeMs: 240_000,
          token: capability,
          webSocketPath: '/terminal',
        }),
        contentType: 'application/json',
        headers: commonHeaders,
        status: 201,
      });
      return;
    }
    await route.fulfill({ status: 404 });
  });
  await page.routeWebSocket(
    `${backendOrigin.replace('https:', 'wss:')}/terminal`,
    (route) => {
      routedWebSocketUrls.push(route.url());
      routedWebSocketProtocols.push(route.protocols());
      installProtocolMock(route, spawnOptions);
    },
  );
  page.on('websocket', (socket) => webSocketUrls.push(socket.url()));

  await page.goto(enabledFixture.remotePageUrl);
  expect(backendRequests).toEqual([]);
  expect(webSocketUrls).toEqual([]);

  await page.getByRole('button', { name: 'Start real demo' }).click();
  await expect(page.locator('[data-remote-status]')).toContainText(
    'Connected to the shared disposable container.',
  );
  await expect(
    page.getByRole('textbox', { name: 'Remote shell terminal input' }),
  ).toBeVisible();
  await expect(page.locator('lit-shell-terminal .header')).toHaveCount(0);
  expect(
    backendRequests.map((request) => new URL(request.url()).pathname),
  ).toEqual(['/health/ready', '/v1/admissions']);
  expect(backendRequests[1]?.method()).toBe('POST');
  expect(backendRequests[1]?.postData()).toBe(
    `turnstileToken=${turnstileToken}`,
  );
  expect(routedWebSocketUrls).toEqual(['wss://remote.example.test/terminal']);
  expect(routedWebSocketUrls[0]).not.toContain(capability);
  expect(spawnOptions).toEqual([expect.objectContaining({ allowJoin: false })]);
  expect(routedWebSocketProtocols).toEqual([
    ['lit-shell.v1', `lit-shell.admission.${capability}`],
  ]);
  expect(routedWebSocketProtocols.flat()).not.toContain(turnstileToken);
  expect(
    backendRequests.every(
      (request) =>
        !request.url().includes(capability) &&
        !request.url().includes(turnstileToken),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __turnstileConfig?: unknown })
          .__turnstileConfig,
    ),
  ).toMatchObject({
    action: 'remote_shell_admission',
    sitekey: '1x00000000000000000000AA',
  });
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __turnstileRemoved?: number })
          .__turnstileRemoved,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    })),
  ).toEqual({ local: [], session: [] });

  const terminal = page.locator('lit-shell-terminal .xterm:visible');
  await terminal.click();
  await page.keyboard.type('id');
  await page.keyboard.press('Enter');
  await expect
    .poll(() => terminalText(page))
    .toContain('uid=65532(guest) gid=65532(guest) groups=65532(guest)');

  const connectedAccessibility = await new AxeBuilder({ page }).analyze();
  expect(connectedAccessibility.violations).toEqual([]);

  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-remote-status]')).toContainText(
    'shell process exited',
  );
  await expect(
    page.getByRole('button', { name: 'Start real demo' }),
  ).toBeEnabled();
  await expect(page.locator('lit-shell-terminal')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'End session' })).toBeHidden();
  await expect(page.locator('.remote-placeholder')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Start real demo' }),
  ).toBeFocused();
  await page.waitForTimeout(250);
  expect(routedWebSocketUrls).toHaveLength(1);
});

test('uses monotonic session time across extreme browser clock skew', async ({
  page,
  browserErrors: _browserErrors,
}) => {
  await page.clock.setFixedTime('2126-01-01T00:00:00Z');
  await installAdmissionMock(page, {
    body: validAdmission({ sessionLifetimeMs: 75_000 }),
    status: 201,
  });
  await page.routeWebSocket(
    `${backendOrigin.replace('https:', 'wss:')}/terminal`,
    (route) => installProtocolMock(route, []),
  );

  await page.goto(enabledFixture.remotePageUrl);
  await page.getByRole('button', { name: 'Start real demo' }).click();

  await expect(page.locator('[data-remote-status]')).toContainText('Connected');
  const countdown = page.locator('[data-remote-countdown]');
  await expect(countdown).toHaveText(/Shared reset in 1:(?:14|15)/u);

  await page.clock.setFixedTime('1970-01-01T00:00:00Z');
  await page.waitForTimeout(350);
  await expect(countdown).toHaveText(/Shared reset in 1:(?:14|15)/u);
});

test('fails closed when the human check fails without contacting the shell backend', async ({
  page,
  browserErrors: _browserErrors,
}) => {
  const backendRequests: string[] = [];
  const webSockets: string[] = [];
  await page.route(turnstileScriptUrl, async (route) => {
    await route.fulfill({
      body: `
        window.turnstile = {
          render(_container, options) {
            queueMicrotask(() => options['error-callback']());
            return 'failed-widget';
          },
          remove() {}
        };
      `,
      contentType: 'text/javascript',
      status: 200,
    });
  });
  page.on('request', (request) => {
    if (new URL(request.url()).origin === backendOrigin) {
      backendRequests.push(request.url());
    }
  });
  page.on('websocket', (socket) => webSockets.push(socket.url()));

  await page.goto(enabledFixture.remotePageUrl);
  await page.getByRole('button', { name: 'Start real demo' }).click();

  await expect(page.locator('[data-remote-status]')).toContainText(
    'Human verification failed to run',
  );
  await expect(page.locator('[data-remote-status]')).toHaveAttribute(
    'role',
    'alert',
  );
  await expect(
    page.getByRole('button', { name: 'Start real demo' }),
  ).toBeEnabled();
  expect(backendRequests).toEqual([]);
  expect(webSockets).toEqual([]);
});

test('releases a sessionClosed-only lease and restores keyboard focus', async ({
  page,
  browserErrors: _browserErrors,
}) => {
  await installAdmissionMock(page);
  await page.routeWebSocket(
    `${backendOrigin.replace('https:', 'wss:')}/terminal`,
    (route) => installProtocolMock(route, []),
  );

  await page.goto(enabledFixture.remotePageUrl);
  await page.getByRole('button', { name: 'Start real demo' }).click();
  await expect(page.locator('[data-remote-status]')).toContainText('Connected');
  await page
    .getByRole('textbox', { name: 'Remote shell terminal input' })
    .pressSequentially('logout');
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-remote-status]')).toContainText(
    'Session ended',
  );
  await expect(page.locator('lit-shell-terminal')).toHaveCount(0);
  await expect(page.locator('.remote-placeholder')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Start real demo' }),
  ).toBeFocused();
});

test('explicit End closes once and never reconnects', async ({
  page,
  browserErrors: _browserErrors,
}) => {
  let routedWebSockets = 0;
  await installAdmissionMock(page);
  await page.routeWebSocket(
    `${backendOrigin.replace('https:', 'wss:')}/terminal`,
    (route) => {
      routedWebSockets += 1;
      installProtocolMock(route, []);
    },
  );

  await page.goto(enabledFixture.remotePageUrl);
  await page.getByRole('button', { name: 'Start real demo' }).click();
  await expect(page.locator('[data-remote-status]')).toContainText('Connected');
  await page.getByRole('button', { name: 'End session' }).click();

  await expect(page.locator('[data-remote-status]')).toContainText(
    'ended by you',
  );
  await expect(
    page.getByRole('button', { name: 'Start real demo' }),
  ).toBeFocused();
  await page.waitForTimeout(1_250);
  expect(routedWebSockets).toBe(1);
});

test('a server-initiated close cleans up without automatic reconnection', async ({
  page,
  browserErrors: _browserErrors,
}) => {
  let routedWebSockets = 0;
  await installAdmissionMock(page);
  await page.routeWebSocket(
    `${backendOrigin.replace('https:', 'wss:')}/terminal`,
    (route) => {
      routedWebSockets += 1;
      installProtocolMock(route, [], {
        afterSpawn: () => {
          setTimeout(
            () => void route.close({ code: 1011, reason: 'test close' }),
            50,
          );
        },
      });
    },
  );

  await page.goto(enabledFixture.remotePageUrl);
  await page.getByRole('button', { name: 'Start real demo' }).click();
  await expect(page.locator('lit-shell-terminal')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Start real demo' }),
  ).toBeEnabled();
  await page.waitForTimeout(1_250);
  expect(routedWebSockets).toBe(1);
});

test('surfaces a post-connect protocol error and removes the capability holder', async ({
  page,
  browserErrors: _browserErrors,
}) => {
  await installAdmissionMock(page);
  await page.routeWebSocket(
    `${backendOrigin.replace('https:', 'wss:')}/terminal`,
    (route) =>
      installProtocolMock(route, [], {
        afterSpawn: () => {
          setTimeout(
            () =>
              route.send(
                JSON.stringify({
                  error: 'synthetic protocol failure',
                  type: 'error',
                }),
              ),
            50,
          );
        },
      }),
  );

  await page.goto(enabledFixture.remotePageUrl);
  await page.getByRole('button', { name: 'Start real demo' }).click();

  await expect(page.locator('[data-remote-status]')).toContainText(
    'synthetic protocol failure',
  );
  await expect(page.locator('lit-shell-terminal')).toHaveCount(0);
  await expect(page.locator('.remote-placeholder')).toBeVisible();
});

test('reports a busy anonymous slot without attempting a WebSocket', async ({
  page,
  browserErrors,
}) => {
  const webSockets: string[] = [];
  await installAdmissionMock(page, {
    body: { error: 'busy' },
    headers: { 'retry-after': '7' },
    status: 429,
  });
  page.on('websocket', (socket) => webSockets.push(socket.url()));

  await page.goto(enabledFixture.remotePageUrl);
  await page.getByRole('button', { name: 'Start real demo' }).click();

  await expect(page.locator('[data-remote-status]')).toContainText(
    'Try again in about 7 seconds',
  );
  await expect(page.locator('[data-remote-status]')).toHaveAttribute(
    'role',
    'alert',
  );
  await expect(page.locator('.remote-placeholder')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Start real demo' }),
  ).toBeFocused();
  expect(webSockets).toEqual([]);
  for (let index = browserErrors.length - 1; index >= 0; index -= 1) {
    if (/\b429\b/u.test(browserErrors[index] ?? '')) {
      browserErrors.splice(index, 1);
    }
  }
});

test('disables the real shell when GitHub Pages is embedded by another site', async ({
  page,
  browserErrors: _browserErrors,
}) => {
  await page.setContent(
    `<iframe title="embedded demo" src="${enabledFixture.remotePageUrl}"></iframe>`,
  );
  const embedded = page.frameLocator('iframe[title="embedded demo"]');

  await expect(
    embedded.getByRole('button', { name: 'Start real demo' }),
  ).toBeDisabled();
  await expect(embedded.locator('[data-remote-status]')).toContainText(
    'cannot run inside an embedded frame',
  );
});

for (const invalidAdmission of [
  {
    name: 'malformed',
    value: { token: 'short' },
    message: 'failed validation',
  },
  {
    name: 'zero-lifetime',
    value: { sessionLifetimeMs: 0 },
    message: 'failed validation',
  },
] as const) {
  test(`rejects a ${invalidAdmission.name} admission response before WebSocket use`, async ({
    page,
    browserErrors: _browserErrors,
  }) => {
    const webSockets: string[] = [];
    await installAdmissionMock(page, {
      body: validAdmission(invalidAdmission.value),
      status: 201,
    });
    page.on('websocket', (socket) => webSockets.push(socket.url()));

    await page.goto(enabledFixture.remotePageUrl);
    await page.getByRole('button', { name: 'Start real demo' }).click();

    await expect(page.locator('[data-remote-status]')).toContainText(
      invalidAdmission.message,
    );
    await expect(page.locator('.remote-placeholder')).toBeVisible();
    expect(webSockets).toEqual([]);
  });
}

test('has an exact remote CSP and fits a narrow viewport', async ({
  page,
  browserErrors: _browserErrors,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(enabledFixture.remotePageUrl);

  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(csp).toBe(
    remoteCsp('https://remote.example.test wss://remote.example.test', true),
  );
  const width = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(width.document).toBeLessThanOrEqual(width.viewport);
});

test.describe('touch-sized remote demo', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('connects with usable touch controls and no horizontal overflow', async ({
    page,
    browserErrors: _browserErrors,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', {
        configurable: true,
        get: () => 1,
      });
    });
    await installAdmissionMock(page);
    await page.routeWebSocket(
      `${backendOrigin.replace('https:', 'wss:')}/terminal`,
      (route) => installProtocolMock(route, []),
    );

    await page.goto(enabledFixture.remotePageUrl);
    await page.getByRole('button', { name: 'Start real demo' }).tap();

    await expect(page.locator('lit-shell-terminal[mobile]')).toBeVisible();
    await expect(
      page.locator('lit-shell-terminal .touch-keyboard'),
    ).toBeVisible();
    await expect(
      page.locator('lit-shell-terminal .touch-key', { hasText: 'ESC' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'End session' }),
    ).toBeVisible();
    const width = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    expect(width.document).toBeLessThanOrEqual(width.viewport);

    await page.getByRole('button', { name: 'End session' }).tap();
    await expect(
      page.getByRole('button', { name: 'Start real demo' }),
    ).toBeEnabled();
  });
});

function installProtocolMock(
  socket: WebSocketRoute,
  spawnOptions: Record<string, unknown>[],
  options: { afterSpawn?: () => void } = {},
): void {
  let input = '';
  socket.send(
    JSON.stringify({
      type: 'serverInfo',
      info: {
        allowedShells: ['/usr/local/bin/lit-shell-guest'],
        defaultShell: '/usr/local/bin/lit-shell-guest',
        dockerEnabled: false,
        localEnabled: true,
      },
    }),
  );
  socket.onMessage((raw) => {
    const message = JSON.parse(raw.toString()) as Record<string, unknown>;
    const requestId = message.requestId;
    if (message.type === 'listSessions') {
      socket.send(
        JSON.stringify({ type: 'sessionList', requestId, sessions: [] }),
      );
      return;
    }
    if (message.type === 'spawn') {
      spawnOptions.push(message.options as Record<string, unknown>);
      socket.send(
        JSON.stringify({
          cols: 80,
          cwd: '/workspace/shared',
          requestId,
          rows: 24,
          sessionId: 'remote-session',
          shell: '/bin/sh',
          type: 'spawned',
        }),
      );
      socket.send(
        JSON.stringify({
          data: 'guest@shared-lit-shell:~$ ',
          sessionId: 'remote-session',
          type: 'data',
        }),
      );
      options.afterSpawn?.();
      return;
    }
    if (message.type === 'data' && typeof message.data === 'string') {
      input += message.data;
    }
    if (input.includes('id\r')) {
      input = '';
      socket.send(
        JSON.stringify({
          data: 'id\r\nuid=65532(guest) gid=65532(guest) groups=65532(guest)\r\nguest@shared-lit-shell:~$ ',
          sessionId: 'remote-session',
          type: 'data',
        }),
      );
    }
    if (input.includes('exit\r')) {
      input = '';
      socket.send(
        JSON.stringify({
          exitCode: 0,
          sessionId: 'remote-session',
          type: 'exit',
        }),
      );
      socket.send(
        JSON.stringify({
          reason: 'process_exit',
          sessionId: 'remote-session',
          type: 'sessionClosed',
        }),
      );
    }
    if (input.includes('logout\r')) {
      input = '';
      socket.send(
        JSON.stringify({
          reason: 'process_exit',
          sessionId: 'remote-session',
          type: 'sessionClosed',
        }),
      );
    }
  });
}

interface AdmissionMock {
  readonly body: Record<string, unknown>;
  readonly headers?: Record<string, string>;
  readonly status: number;
}

async function installAdmissionMock(
  page: Page,
  admission: AdmissionMock = { body: validAdmission(), status: 201 },
): Promise<void> {
  await installTurnstileMock(page);
  await installAdmissionBackendMock(page, admission);
}

async function installAdmissionBackendMock(
  page: Page,
  admission: AdmissionMock = { body: validAdmission(), status: 201 },
): Promise<void> {
  await page.route(`${backendOrigin}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const headers = {
      'access-control-allow-origin': enabledFixture.origin,
      'access-control-expose-headers': 'Retry-After',
      'cache-control': 'no-store',
      ...admission.headers,
    };
    if (pathname === '/health/ready') {
      await route.fulfill({
        body: JSON.stringify({ status: 'ready' }),
        contentType: 'application/json',
        headers,
        status: 200,
      });
      return;
    }
    if (pathname === '/v1/admissions') {
      await route.fulfill({
        body: JSON.stringify(admission.body),
        contentType: 'application/json',
        headers,
        status: admission.status,
      });
      return;
    }
    await route.fulfill({ status: 404 });
  });
}

function validAdmission(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    protocol: 'lit-shell.v1',
    resetAt: new Date(Date.now() + 240_000).toISOString(),
    sessionLifetimeMs: 240_000,
    token: capability,
    webSocketPath: '/terminal',
    ...overrides,
  };
}

async function installTurnstileMock(
  page: Page,
  options: { autoComplete?: boolean } = {},
): Promise<void> {
  await page.route(turnstileScriptUrl, async (route) => {
    await route.fulfill({
      body: turnstileMockSource(options.autoComplete),
      contentType: 'text/javascript',
      status: 200,
    });
  });
}

function turnstileMockSource(autoComplete = true): string {
  if (autoComplete) {
    return `
    window.turnstile = {
      render(container, options) {
        window.__turnstileConfig = options;
        const marker = document.createElement('p');
        marker.textContent = 'Human check complete';
        container.replaceChildren(marker);
        queueMicrotask(() => options.callback('turnstile-test-token'));
        return 'test-widget';
      },
      remove() {
        window.__turnstileRemoved = (window.__turnstileRemoved || 0) + 1;
      }
    };
  `;
  }
  return `
    window.turnstile = {
      render(container, options) {
        window.__turnstileConfig = options;
        const marker = document.createElement('p');
        marker.textContent = 'Human check pending';
        container.replaceChildren(marker);
        return 'test-widget';
      },
      remove() {
        window.__turnstileRemoved = (window.__turnstileRemoved || 0) + 1;
      }
    };
  `;
}

async function terminalText(page: Page): Promise<string> {
  return page
    .locator('lit-shell-terminal .xterm:visible .xterm-rows')
    .evaluateAll((rows) => rows.map((row) => row.textContent ?? '').join('\n'));
}
