export function pagesRemoteConfig(candidate) {
  if (!candidate) {
    return {
      connectSource: "'none'",
      enabled: false,
      origin: '',
    };
  }

  let url;
  try {
    url = new URL(candidate);
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
    url.origin !== candidate
  ) {
    throw new TypeError(
      'LIT_SHELL_REMOTE_DEMO_ORIGIN must be one exact HTTPS origin without credentials, path, query, or fragment',
    );
  }

  const webSocketOrigin = `wss://${url.host}`;
  return {
    connectSource: `${url.origin} ${webSocketOrigin}`,
    enabled: true,
    origin: url.origin,
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
