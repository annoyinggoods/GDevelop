/**
 * Tests of the one-click build script.
 *
 * Run them with:
 *   node --test newIDE/scripts/build-desktop-app.test.js
 */

'use strict';

const assert = require('node:assert');
const test = require('node:test');

const {
  parseArgs,
  buildPlan,
  buildEnvironment,
  checkPreflight,
  defaultMaxOldSpaceSizeInMiB,
  paths,
} = require('./build-desktop-app');

/**
 * @param {Object} options The options to parse.
 */
const parse = options => parseArgs(options).options;

test('parseArgs returns the default options when nothing is given', () => {
  const options = parse([]);

  assert.strictEqual(options.dev, false);
  assert.strictEqual(options.web, false);
  assert.strictEqual(options.skipAppBuild, false);
  assert.strictEqual(options.skipInstall, false);
  assert.strictEqual(options.portable, false);
  assert.strictEqual(options.dryRun, false);
  assert.strictEqual(options.openFolder, false);
  assert.strictEqual(options.help, false);
});

test('parseArgs reads every option', () => {
  const options = parse([
    '--dev',
    '--web',
    '--skip-app-build',
    '--skip-install',
    '--portable',
    '--dry-run',
    '--open-folder',
  ]);

  assert.strictEqual(options.dev, true);
  assert.strictEqual(options.web, true);
  assert.strictEqual(options.skipAppBuild, true);
  assert.strictEqual(options.skipInstall, true);
  assert.strictEqual(options.portable, true);
  assert.strictEqual(options.dryRun, true);
  assert.strictEqual(options.openFolder, true);
});

test('parseArgs collects the unknown options instead of ignoring them', () => {
  const { options, unknownOptions } = parseArgs(['--dev', '--nope', '-x']);

  assert.strictEqual(options.dev, true);
  assert.deepStrictEqual(unknownOptions, ['--nope', '-x']);
});

test('buildPlan installs the dependencies of the four packages', () => {
  const steps = buildPlan(parse([]));
  const installSteps = steps.filter(step => step.command === 'npm install');

  assert.strictEqual(installSteps.length, 4);
  assert.deepStrictEqual(installSteps.map(step => step.cwd), [
    paths.appDirectory,
    paths.gdjsDirectory,
    paths.electronAppDirectory,
    paths.electronMainDirectory,
  ]);
});

test('buildPlan does not install anything with --skip-install', () => {
  const steps = buildPlan(parse(['--skip-install']));
  const installSteps = steps.filter(step => step.command === 'npm install');

  assert.strictEqual(installSteps.length, 0);
});

test('buildPlan builds the IDE and packages the desktop app by default', () => {
  const steps = buildPlan(parse([]));
  const commands = steps.map(step => step.command);

  assert.ok(commands.includes('npm run build'));
  assert.ok(
    commands.includes('node scripts/app-build.js --skip-app-build'),
    'The IDE must be copied into the desktop app.'
  );
  assert.ok(
    commands.includes('node scripts/build.js --skip-app-build'),
    'Electron Builder must package the desktop app.'
  );
});

test('buildPlan with --web does not package the desktop app', () => {
  const steps = buildPlan(parse(['--web']));
  const commands = steps.map(step => step.command);

  assert.ok(commands.includes('npm run build'));
  assert.ok(!commands.includes('node scripts/build.js --skip-app-build'));
});

test('buildPlan with --skip-app-build does not rebuild the IDE', () => {
  const steps = buildPlan(parse(['--skip-app-build']));
  const commands = steps.map(step => step.command);

  assert.ok(!commands.includes('npm run build'));
  assert.ok(commands.includes('node scripts/build.js --skip-app-build'));
});

test('buildPlan with --dev builds the IDE in development mode', () => {
  const steps = buildPlan(parse(['--dev']));
  const buildStep = steps.find(
    step => step.command.indexOf('react-app-rewired') !== -1
  );

  assert.ok(buildStep, 'The development build step must be present.');
  assert.strictEqual(buildStep.env.REACT_APP_ENV, 'development');
});

test('buildPlan with --portable disables the code signing', () => {
  const steps = buildPlan(parse(['--portable']));
  const packageStep = steps.find(
    step => step.command === 'node scripts/build.js --skip-app-build'
  );

  assert.strictEqual(packageStep.env.GD_PORTABLE_BUILD, 'true');
});

test('buildPlan without --portable does not set the signing environment', () => {
  const steps = buildPlan(parse([]));
  const packageStep = steps.find(
    step => step.command === 'node scripts/build.js --skip-app-build'
  );

  assert.ok(
    !packageStep.env || !packageStep.env.GD_PORTABLE_BUILD,
    'The signing must not be disabled without --portable.'
  );
});

test('checkPreflight reports the missing dependencies', () => {
  const { problems } = checkPreflight(parse([]), { fileExists: () => false });

  assert.strictEqual(problems.length, 4);
});

test('checkPreflight is happy when everything is installed', () => {
  const { problems, warnings } = checkPreflight(parse([]), {
    fileExists: () => true,
  });

  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual(warnings, []);
});

test('checkPreflight warns when libGD.js is missing', () => {
  const { warnings } = checkPreflight(parse([]), {
    fileExists: filePath => filePath !== paths.appLibGdFile,
  });

  assert.strictEqual(warnings.length, 1);
  assert.ok(warnings[0].indexOf('libGD.js') !== -1);
});

test('checkPreflight refuses to package when no IDE build exists', () => {
  const { problems } = checkPreflight(parse(['--skip-app-build']), {
    fileExists: () => false,
  });

  assert.ok(
    problems.some(problem => problem.indexOf('No IDE build was found') !== -1)
  );
});

test('buildEnvironment gives enough memory to the Node processes of the build', () => {
  const previousNodeOptions = process.env.NODE_OPTIONS;
  delete process.env.NODE_OPTIONS;

  try {
    const environment = buildEnvironment({});
    assert.strictEqual(
      environment.NODE_OPTIONS,
      `--max-old-space-size=${defaultMaxOldSpaceSizeInMiB}`
    );
  } finally {
    if (previousNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = previousNodeOptions;
    }
  }
});

test('buildEnvironment keeps the environment variables of the step', () => {
  const previousNodeOptions = process.env.NODE_OPTIONS;
  delete process.env.NODE_OPTIONS;

  try {
    const environment = buildEnvironment({ GD_PORTABLE_BUILD: 'true' });
    assert.strictEqual(environment.GD_PORTABLE_BUILD, 'true');
  } finally {
    if (previousNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = previousNodeOptions;
    }
  }
});

test('buildEnvironment does not override the memory set by the user', () => {
  const previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--max-old-space-size=2048';

  try {
    const environment = buildEnvironment({});
    assert.strictEqual(environment.NODE_OPTIONS, undefined);
  } finally {
    if (previousNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = previousNodeOptions;
    }
  }
});
