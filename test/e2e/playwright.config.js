// const { devices } = require('@playwright/test')
const path = require('path')
const webuiPort = 3001
const rpcPort = 55001

const config = {
  testDir: './',
  timeout: process.env.CI ? 90 * 1000 : 30 * 1000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: (process.env.DEBUG || process.env.CI) ? 1 : undefined,
  reporter: [
    ['list'],
    [
      '@bgotink/playwright-coverage',
      /** @type {import('@bgotink/playwright-coverage').CoverageReporterOptions} */ {
        // Path to the root files should be resolved from, most likely your repository root
        sourceRoot: path.join(__dirname, '..'),
        // Files to ignore in coverage, useful
        // - if you're testing the demo app of a component library and want to exclude the demo sources
        // - or part of the code is generated
        // - or if you're running into any of the other many reasons people have for excluding files
        // exclude: ['path/to/ignored/code/**'],
        // Directory in which to write coverage reports
        resultDir: path.join(__dirname, 'results/e2e-coverage'),
        // Configure the reports to generate.
        // The value is an array of istanbul reports, with optional configuration attached.
        reports: [
          // Create an HTML view at <resultDir>/index.html
          ['html'],
          // Create <resultDir>/coverage.lcov for consumption by tooling
          [
            'lcovonly',
            {
              file: 'coverage.lcov'
            }
          ],
          // Log a coverage summary at the end of the test run
          [
            'text-summary',
            {
              file: null
            }
          ]
        ]
        // Configure watermarks, see https://github.com/istanbuljs/nyc#high-and-low-watermarks
        // watermarks: {},
      }
    ]
  ],
  use: {
    headless: !process.env.DEBUG,
    viewport: { width: 1366, height: 768 },
    baseURL: `http://localhost:${webuiPort}/`,
    storageState: 'test/e2e/state.json',
    // actionTimeout: 30* 1000,
    trace: 'on-first-retry'
  },
  /* TODO: test against other engines?
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
      },
    },

    {
      name: 'webkit',
      use: {
        ...devices['Desktop Safari'],
      },
    },
  ],
  */
  globalSetup: require.resolve('./setup/global-setup'),
  globalTeardown: require.resolve('./setup/global-teardown'),
  webServer: [
    {
      command: `node ipfs-backend.js ${rpcPort}`,
      url: `http://127.0.0.1:${rpcPort}/webui`, // we don't use webui bundled with daemon, but it is a good test of when its http server is fully booted
      cwd: './setup',
      reuseExistingServer: !process.env.CI
    },
    {
      command: `http-server ./build/ -c-1 -a 127.0.0.1 -p ${webuiPort}`,
      port: webuiPort,
      cwd: '../../',
      reuseExistingServer: !process.env.CI
    }
  ]
  // collectCoverage: true
}

module.exports = config
