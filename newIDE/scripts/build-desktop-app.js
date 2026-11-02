#!/usr/bin/env node
/**
 * Build the GDevelop desktop application (Electron) without using a terminal.
 *
 * This script only orchestrates the existing npm pipeline, it does not
 * reimplement any part of it:
 *   - `newIDE/app`         -> `npm run build` (import the resources, compile the React app)
 *   - `newIDE/electron-app`-> `node scripts/app-build.js` (copy the IDE into `app/www`)
 *                           -> `node scripts/build.js` (package it with Electron Builder)
 *
 * Usage:
 *   node newIDE/scripts/build-desktop-app.js [options]
 *
 * Options:
 *   --dev             Build the IDE in development mode (unminified, and the game
 *                     engine is served from the build folder).
 *   --web             Only build the web app (the IDE in `newIDE/app/build`),
 *                     without packaging the desktop app.
 *   --skip-app-build  Do not rebuild the IDE, package the one already built.
 *   --skip-install    Never run `npm install`.
 *   --portable        Build without code signing (GD_PORTABLE_BUILD).
 *   --dry-run         Print the commands that would be run, without running them.
 *   --open-folder     Open the folder containing the build at the end.
 *   --help            Print this help.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const newIdeDirectory = path.join(__dirname, '..');
const repositoryRoot = path.join(newIdeDirectory, '..');

const paths = {
  repositoryRoot,
  newIdeDirectory,
  appDirectory: path.join(newIdeDirectory, 'app'),
  appBuildDirectory: path.join(newIdeDirectory, 'app', 'build'),
  appNodeModules: path.join(newIdeDirectory, 'app', 'node_modules'),
  appLibGdFile: path.join(newIdeDirectory, 'app', 'public', 'libGD.js'),
  electronAppDirectory: path.join(newIdeDirectory, 'electron-app'),
  electronMainDirectory: path.join(newIdeDirectory, 'electron-app', 'app'),
  electronNodeModules: path.join(
    newIdeDirectory,
    'electron-app',
    'node_modules'
  ),
  electronMainNodeModules: path.join(
    newIdeDirectory,
    'electron-app',
    'app',
    'node_modules'
  ),
  electronDistDirectory: path.join(newIdeDirectory, 'electron-app', 'dist'),
  gdjsDirectory: path.join(repositoryRoot, 'GDJS'),
  gdjsNodeModules: path.join(repositoryRoot, 'GDJS', 'node_modules'),
};

/**
 * Read the options given on the command line.
 * @param {string[]} argv The arguments, without the node executable and the script.
 */
const parseArgs = argv => {
  const options = {
    dev: false,
    web: false,
    skipAppBuild: false,
    skipInstall: false,
    portable: false,
    dryRun: false,
    openFolder: false,
    help: false,
  };
  const unknownOptions = [];

  argv.forEach(argument => {
    switch (argument) {
      case '--dev':
        options.dev = true;
        break;
      case '--web':
        options.web = true;
        break;
      case '--skip-app-build':
        options.skipAppBuild = true;
        break;
      case '--skip-install':
        options.skipInstall = true;
        break;
      case '--portable':
        options.portable = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--open-folder':
        options.openFolder = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        unknownOptions.push(argument);
        break;
    }
  });

  return { options, unknownOptions };
};

/**
 * The steps building the IDE itself (the React app and the resources it needs).
 * @param {boolean} dev True to build in development mode.
 */
const rendererSteps = dev => {
  if (!dev) {
    return [
      {
        title: 'Build the IDE (import the resources, compile the React app)',
        command: 'npm run build',
        cwd: paths.appDirectory,
      },
    ];
  }

  // The "build:dev" npm script cannot be used as is on Windows: it sets
  // REACT_APP_ENV with the "VAR=value command" syntax, which the Windows
  // command line does not understand. The environment variable is passed
  // through the spawn environment instead.
  return [
    {
      title: 'Import the resources of the IDE',
      command: 'npm run import-resources',
      cwd: paths.appDirectory,
    },
    {
      title: 'Build the IDE in development mode',
      command: 'node node_modules/react-app-rewired/bin/index.js build',
      cwd: paths.appDirectory,
      env: { REACT_APP_ENV: 'development' },
    },
    {
      title: 'Check the content of the build folder',
      command: 'node scripts/check-build-output.js',
      cwd: paths.appDirectory,
    },
    {
      title: 'Copy the game engine into the build folder',
      command: 'node scripts/copy-GDJS-Runtime-to-build.js',
      cwd: paths.appDirectory,
    },
  ];
};

/**
 * The steps installing the dependencies, only run when they are missing.
 */
const installSteps = () => [
  {
    title: 'Install the dependencies of the IDE',
    command: 'npm install',
    cwd: paths.appDirectory,
    skipIf: () => fs.existsSync(paths.appNodeModules),
  },
  {
    title: 'Install the dependencies of the game engine',
    command: 'npm install',
    cwd: paths.gdjsDirectory,
    skipIf: () => fs.existsSync(paths.gdjsNodeModules),
  },
  {
    title: 'Install the dependencies of the desktop app',
    command: 'npm install',
    cwd: paths.electronAppDirectory,
    skipIf: () => fs.existsSync(paths.electronNodeModules),
  },
  {
    title: 'Install the dependencies of the desktop app (main process)',
    command: 'npm install',
    cwd: paths.electronMainDirectory,
    skipIf: () => fs.existsSync(paths.electronMainNodeModules),
  },
];

/**
 * Build the list of steps to run for the given options.
 * @param {Object} options The options returned by parseArgs.
 */
const buildPlan = options => {
  const steps = [];

  if (!options.skipInstall) {
    steps.push(...installSteps());
  }

  if (options.web) {
    steps.push(...rendererSteps(options.dev));
    return steps;
  }

  if (!options.skipAppBuild) {
    steps.push(...rendererSteps(options.dev));
  }

  steps.push({
    title: 'Copy the IDE into the desktop app',
    command: 'node scripts/app-build.js --skip-app-build',
    cwd: paths.electronAppDirectory,
  });
  steps.push({
    title: 'Package the desktop app (Electron Builder)',
    command: 'node scripts/build.js --skip-app-build',
    cwd: paths.electronAppDirectory,
    env: options.portable ? { GD_PORTABLE_BUILD: 'true' } : {},
  });

  return steps;
};

/**
 * Check that the machine can run the build, and return what is missing.
 * @param {Object} options The options returned by parseArgs.
 * @param {Object} dependencies The injectable dependencies (for the tests).
 */
const checkPreflight = (options, dependencies) => {
  const fileExists = dependencies.fileExists || fs.existsSync;
  const problems = [];
  const warnings = [];

  if (!fileExists(paths.appNodeModules)) {
    problems.push(
      `The dependencies of the IDE are missing (${paths.appNodeModules}).`
    );
  }
  if (!fileExists(paths.electronNodeModules)) {
    problems.push(
      `The dependencies of the desktop app are missing (${
        paths.electronNodeModules
      }).`
    );
  }
  if (!fileExists(paths.electronMainNodeModules)) {
    problems.push(
      `The dependencies of the desktop app main process are missing (${
        paths.electronMainNodeModules
      }).`
    );
  }
  if (!fileExists(paths.gdjsNodeModules)) {
    problems.push(
      `The dependencies of the game engine are missing (${
        paths.gdjsNodeModules
      }).`
    );
  }
  if (!fileExists(paths.appLibGdFile)) {
    warnings.push(
      'libGD.js is missing: it will be downloaded during the build (this needs an internet connection).'
    );
  }
  if (
    options.skipAppBuild &&
    !fileExists(paths.appBuildDirectory) &&
    !fileExists(paths.electronWwwDirectory)
  ) {
    problems.push(
      'No IDE build was found: run the build without "--skip-app-build" first.'
    );
  }

  return { problems, warnings };
};

/**
 * The heap size given to the Node processes of the build.
 * The production build of the IDE (webpack minifying the whole editor) needs
 * more memory than Node allows by default (about 4 GB): without this, the
 * build dies with "Reached heap limit Allocation failed - JavaScript heap out
 * of memory".
 */
const defaultMaxOldSpaceSizeInMiB = 12288;

/**
 * Compute the environment of a build step.
 * @param {Object} extraEnvironment The environment variables of the step.
 */
const buildEnvironment = extraEnvironment => {
  const environment = Object.assign({}, extraEnvironment || {});
  if (!process.env.NODE_OPTIONS) {
    environment.NODE_OPTIONS = `--max-old-space-size=${defaultMaxOldSpaceSizeInMiB}`;
  }
  return environment;
};

/**
 * Run a command, letting its output flow to the console.
 * @param {string} command The command to run.
 * @param {Object} options The cwd and the environment variables of the command.
 */
const runCommand = (command, options) => {
  const result = spawnSync(command, {
    cwd: options.cwd,
    env: Object.assign({}, process.env, buildEnvironment(options.env)),
    stdio: 'inherit',
    shell: true,
  });

  if (result.error) {
    console.error(`❌ ${result.error.message}`);
    return 1;
  }
  if (result.status === null) {
    console.error('❌ The command was interrupted.');
    return 1;
  }
  return result.status;
};

/**
 * List the files of a directory, with their size.
 * @param {string} directory The directory to list.
 */
const listFiles = directory => {
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs
    .readdirSync(directory)
    .filter(file => fs.statSync(path.join(directory, file)).isFile())
    .map(file => {
      const stats = fs.statSync(path.join(directory, file));
      return { name: file, sizeInMiB: stats.size / (1024 * 1024) };
    });
};

/**
 * Open a folder with the file manager of the operating system.
 * @param {string} directory The directory to open.
 */
const openFolder = directory => {
  if (!fs.existsSync(directory)) {
    return;
  }

  if (process.platform === 'win32') {
    spawnSync('explorer.exe', [directory], { stdio: 'ignore', detached: true });
    return;
  }
  if (process.platform === 'darwin') {
    spawnSync('open', [directory], { stdio: 'ignore', detached: true });
    return;
  }
  spawnSync('xdg-open', [directory], { stdio: 'ignore', detached: true });
};

const printHelp = () => {
  console.log(`Build the GDevelop desktop app (Electron).

Usage:
  node newIDE/scripts/build-desktop-app.js [options]

Options:
  --dev             Build the IDE in development mode.
  --web             Only build the web app, without packaging the desktop app.
  --skip-app-build  Do not rebuild the IDE, package the one already built.
  --skip-install    Never run "npm install".
  --portable        Build without code signing.
  --dry-run         Print the commands that would be run, without running them.
  --open-folder     Open the folder containing the build at the end.
  --help            Print this help.
`);
};

const main = () => {
  const { options, unknownOptions } = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return 0;
  }

  if (unknownOptions.length > 0) {
    console.error(
      `❌ Unknown option(s): ${unknownOptions.join(', ')}. Run with --help.`
    );
    return 1;
  }

  console.log('GDevelop - build the desktop app');
  console.log(`Repository: ${paths.repositoryRoot}`);
  console.log('');

  const { problems, warnings } = checkPreflight(options, {});
  warnings.forEach(warning => console.log(`⚠️  ${warning}`));
  if (problems.length > 0) {
    problems.forEach(problem => console.log(`❌ ${problem}`));
    if (options.skipInstall) {
      console.error(
        '❌ The build cannot start. Run "npm install" in the folders above, or remove "--skip-install".'
      );
      return 1;
    }
    console.log(
      'ℹ️  The missing dependencies will be installed before the build starts.'
    );
  }
  console.log('');

  const steps = buildPlan(options);

  if (options.dryRun) {
    steps.forEach(step => {
      console.log(`> ${step.title}`);
      console.log(`  ${step.command}`);
      console.log(`  (in ${step.cwd})`);
    });
    return 0;
  }

  for (const step of steps) {
    if (step.skipIf && step.skipIf()) {
      console.log(`⏭️  ${step.title} (already installed, skipped)`);
      continue;
    }

    console.log(`▶️  ${step.title}`);
    const startedAt = Date.now();
    const status = runCommand(step.command, { cwd: step.cwd, env: step.env });
    const durationInSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);

    if (status !== 0) {
      console.error(
        `❌ "${
          step.title
        }" failed with the exit code ${status} (after ${durationInSeconds}s).`
      );
      return status;
    }
    console.log(`✅ ${step.title} (${durationInSeconds}s)`);
    console.log('');
  }

  const outputDirectory = options.web
    ? paths.appBuildDirectory
    : paths.electronDistDirectory;
  const files = listFiles(outputDirectory);

  console.log('✅ The build is done.');
  console.log(`   Output: ${outputDirectory}`);
  files.forEach(file => {
    console.log(`   - ${file.name} (${file.sizeInMiB.toFixed(1)} MiB)`);
  });

  if (options.openFolder) {
    openFolder(outputDirectory);
  }

  return 0;
};

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  parseArgs,
  buildPlan,
  buildEnvironment,
  checkPreflight,
  listFiles,
  defaultMaxOldSpaceSizeInMiB,
  paths,
};
