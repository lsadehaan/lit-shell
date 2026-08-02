#!/usr/bin/env node

process.env.LIT_SHELL_PAGES_OUTPUT_DIR = '_site-enabled';
process.env.LIT_SHELL_REMOTE_DEMO_ORIGIN = 'https://remote.example.test';

await import('./build-pages.js');
await import('./check-pages.js');
