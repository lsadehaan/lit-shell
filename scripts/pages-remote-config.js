export function pagesRemoteConfig(originCandidate, siteKeyCandidate) {
  if (!originCandidate && !siteKeyCandidate) {
    return {
      connectSource: "'none'",
      enabled: false,
      frameSource: "'none'",
      origin: '',
      scriptSource: "'self'",
      siteKey: '',
    };
  }
  if (!originCandidate || !siteKeyCandidate) {
    throw new TypeError(
      'LIT_SHELL_REMOTE_DEMO_ORIGIN and LIT_SHELL_TURNSTILE_SITE_KEY must be configured together',
    );
  }

  let url;
  try {
    url = new URL(originCandidate);
  } catch (error) {
    throw new TypeError('LIT_SHELL_REMOTE_DEMO_ORIGIN must be a valid URL', {
      cause: error,
    });
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.origin !== originCandidate
  ) {
    throw new TypeError(
      'LIT_SHELL_REMOTE_DEMO_ORIGIN must be one exact HTTPS origin without credentials, path, query, or fragment',
    );
  }
  if (!/^[A-Za-z0-9_-]{20,64}$/u.test(siteKeyCandidate)) {
    throw new TypeError(
      'LIT_SHELL_TURNSTILE_SITE_KEY must be a valid public Turnstile sitekey',
    );
  }

  const webSocketOrigin = `wss://${url.host}`;
  return {
    connectSource: `${url.origin} ${webSocketOrigin}`,
    enabled: true,
    frameSource: 'https://challenges.cloudflare.com',
    origin: url.origin,
    scriptSource: "'self' https://challenges.cloudflare.com",
    siteKey: siteKeyCandidate,
  };
}

export function pagesOutputDirectory(value) {
  const directory = value || '_site';
  if (!/^_site(?:-[a-z0-9-]+)?$/u.test(directory)) {
    throw new TypeError(
      'LIT_SHELL_PAGES_OUTPUT_DIR must be _site or an _site-* directory name',
    );
  }
  return directory;
}
