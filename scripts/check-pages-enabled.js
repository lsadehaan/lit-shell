#!/usr/bin/env node

process.env.LIT_SHELL_PAGES_OUTPUT_DIR = '_site-enabled';
process.env.LIT_SHELL_REMOTE_DEMO_ORIGIN = 'https://remote.example.test';
process.env.LIT_SHELL_TURNSTILE_SITE_KEY = '1x00000000000000000000AA';

await import('./build-pages.js');
await import('./check-pages.js');
