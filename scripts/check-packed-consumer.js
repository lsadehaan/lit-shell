import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'lit-shell-packed-consumer-'));
const compiler = join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');

function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : 'npm';
  const commandArgs = npmCli ? [npmCli, ...args] : args;

  return execFileSync(command, commandArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  });
}

try {
  const packOutput = runNpm([
    'pack',
    '--json',
    '--pack-destination',
    temporaryRoot,
    projectRoot,
  ]);
  const packResult = JSON.parse(packOutput);

  if (
    !Array.isArray(packResult) ||
    typeof packResult[0]?.filename !== 'string'
  ) {
    throw new Error(`npm pack returned an unexpected result: ${packOutput}`);
  }

  const tarballDependency = `file:./${packResult[0].filename}`;

  writeFileSync(
    join(temporaryRoot, 'package.json'),
    `${JSON.stringify({ private: true }, null, 2)}\n`,
  );

  // Keeping the fixture outside the repository prevents parent node_modules
  // directories from satisfying types.
  runNpm(
    [
      'install',
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      tarballDependency,
    ],
    { cwd: temporaryRoot },
  );

  const installedTypes = join(
    temporaryRoot,
    'node_modules',
    '@types',
    'ws',
    'package.json',
  );
  if (!existsSync(installedTypes)) {
    throw new Error(
      'Packed consumers do not receive the @types/ws declarations',
    );
  }

  const installedTypesPath = realpathSync(installedTypes);
  const expectedTypesRoot = `${realpathSync(join(temporaryRoot, 'node_modules'))}${sep}`;
  if (!installedTypesPath.startsWith(expectedTypesRoot)) {
    throw new Error(
      `@types/ws resolved outside the isolated consumer: ${installedTypesPath}`,
    );
  }

  const consumerSource = join(temporaryRoot, 'consumer.ts');
  const consumerConfig = join(temporaryRoot, 'tsconfig.json');
  writeFileSync(
    consumerSource,
    [
      "import type { TerminalServer, TerminalServerOptions } from 'lit-shell.js';",
      '',
      'declare const server: TerminalServer;',
      'declare const options: TerminalServerOptions;',
      'void server;',
      'void options;',
      '',
    ].join('\n'),
  );
  writeFileSync(
    consumerConfig,
    `${JSON.stringify(
      {
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: 'ES2022',
          typeRoots: ['./node_modules/@types'],
          types: [],
        },
        include: ['./consumer.ts'],
      },
      null,
      2,
    )}\n`,
  );

  execFileSync(process.execPath, [compiler, '--project', consumerConfig], {
    cwd: temporaryRoot,
    stdio: 'inherit',
  });

  const packageManifest = JSON.parse(
    readFileSync(
      join(temporaryRoot, 'node_modules', 'lit-shell.js', 'package.json'),
      'utf8',
    ),
  );
  if (packageManifest.dependencies?.['@types/ws'] === undefined) {
    throw new Error(
      'The packed manifest does not declare @types/ws as a production dependency',
    );
  }
  if (
    packageManifest.peerDependencies?.['node-pty'] !== '1.1.0' ||
    packageManifest.peerDependenciesMeta?.['node-pty']?.optional !== true ||
    packageManifest.optionalDependencies?.['node-pty'] !== undefined
  ) {
    throw new Error(
      'The packed manifest must expose node-pty 1.1.0 only as an optional peer',
    );
  }
  if (existsSync(join(temporaryRoot, 'node_modules', 'node-pty'))) {
    throw new Error(
      'A default client-only install unexpectedly fetched optional peer node-pty',
    );
  }

  for (const mapPath of [
    'dist/server/index.js.map',
    'dist/server/index.d.ts.map',
  ]) {
    const sourceMap = JSON.parse(
      readFileSync(
        join(temporaryRoot, 'node_modules', 'lit-shell.js', mapPath),
        'utf8',
      ),
    );
    if (
      !Array.isArray(sourceMap.sources) ||
      sourceMap.sources.length === 0 ||
      !Array.isArray(sourceMap.sourcesContent) ||
      sourceMap.sourcesContent.length !== sourceMap.sources.length ||
      sourceMap.sourcesContent.some(
        (source) => typeof source !== 'string' || source.length === 0,
      )
    ) {
      throw new Error(`${mapPath} does not embed its published source content`);
    }
  }

  console.log(
    'Packed TypeScript consumer compiled with isolated production dependencies.',
  );
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
