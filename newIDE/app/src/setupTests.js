/**
 * Set up the environment for tests.
 */

// * In the browser or in Electron, libGD.js is included as a separate file
// and imported using a <script> tag in index.html, so it's not part of the
// webpack build. It's made available as a global variable called gd.
// * To use it for tests, we need to require it, but without letting it being
// processed by Babel (it's a Emscripten generated file, so it's super heavy
// and will crash v8/node). Instead, we copied it to a node_modules directory
// so we can require it without having the Babel processing.
// * We use a convoluted name to avoid it being imported by mistake in the
// rest of the codebase. See scripts/import-libGD.js
const initializeGDevelopJs = require('libGD.js-for-tests-only');
const fs = require('fs');
const path = require('path');

// Give the wasm binary directly to libGD.js: in a test using the jsdom
// environment, it would otherwise try to fetch it with an XMLHttpRequest
// (which fails and logs an error) before falling back to the filesystem.
const wasmBinary = fs.readFileSync(
  path.join(
    path.dirname(require.resolve('libGD.js-for-tests-only')),
    'libGD.wasm'
  )
);

// We create the global "gd" object **synchronously** here. This is done as
// the source files are using `global.gd` as a "top level" object (after imports).
// This is a side effect, so this file must be imported before any test.
// See also GDevelopJsInitializerDecorator.js for Storybook.
global.gd = {
  I_AM_NOT_YET_INITIALIZED_YOU_MUST_USE_GD_INSIDE_A_TEST_ONLY: true,
};

beforeAll(done => {
  initializeGDevelopJs({ wasmBinary }).then(module => {
    // We're **updating** the global "gd" object here. This is done so that
    // the source files that are using `global.gd` have the proper reference to the
    // object.
    delete global.gd
      .I_AM_NOT_YET_INITIALIZED_YOU_MUST_USE_GD_INSIDE_A_TEST_ONLY;
    for (var key in module) {
      global.gd[key] = module[key];
    }
    done();
  });
});

// We increase the timeout for CIs (the default 5s can be too low sometimes, as a real browser is involved).
jest.setTimeout(10000);

// Mock worker files to prevent "self is not defined" errors in tests
// Jest will automatically use the mock implementations from the __mocks__ folders
jest.mock('./Utils/BackgroundSerializer.worker');
jest.mock('./ResourcesList/ResourcePreview/Resource3DPreview.worker');

// A React tree that a spec leaves mounted keeps its effects alive: the async
// ones (history loading, model choice loading, ...) resolve later and call a
// state setter on that dead-but-still-mounted tree. A full run is a single
// process (--maxWorkers=1), so the pending callback fires while a LATER test
// file is running — and that file's mocks are already installed. The render
// then runs against the wrong mocks and throws inside an unrelated suite,
// which is how this surfaced as "one different suite fails per full run and
// passes standalone". (useByokChatSeam.spec.js was the offender, and its
// uncaught exception could take the whole worker process down.)
//
// Draining the event loop in afterAll — before the environment is torn down
// and while THIS file's mocks are still installed — contains such a leak to
// the file that caused it instead of letting it surface somewhere else.
//
// The REAL setTimeout is captured here, at load: a suite that installs fake
// timers (UseLongTouch.spec.js does) replaces the global one, and a drain
// waiting on a fake timer that nobody advances never resolves — the hook
// would then time out and fail that suite, which is the very failure mode
// this net exists to prevent.
const realSetTimeout = setTimeout;

afterAll(async () => {
  // Several turns: React's scheduler hands work over through a MessageChannel
  // (jsdom) or setImmediate (node), and one fired callback can schedule the
  // next one.
  for (let turn = 0; turn < 3; turn++) {
    await new Promise(resolve => realSetTimeout(resolve, 0));
  }
});
