const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const root = path.resolve(__dirname, '../..');

function checkSyntax(directory = root) {
  let checked = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', 'uploads'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      checked += checkSyntax(file);
    } else if (entry.isFile() && /\.(?:js|cjs|mjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', file], {
        stdio: 'inherit', timeout: 10000,
      });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `Syntax check failed: ${path.relative(root, file)}`);
      checked++;
    }
  }
  return checked;
}

function runTests() {
  const { scripts = {} } = require(path.join(root, 'package.json'));
  const tests = Object.keys(scripts).filter(name =>
    /^test(?::|$)/.test(name) && scripts[name].trim() &&
    !/no test specified/i.test(scripts[name]));
  if (!tests.length) {
    console.log('No automated test scripts configured; skipping tests.');
  }
  for (const name of tests) {
    console.log(`Running npm run ${name}`);
    const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', name], {
      cwd: root, stdio: 'inherit', shell: process.platform === 'win32', timeout: 120000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Automated tests failed: ${name}`);
  }
}

async function checkStartup() {
  // Refuse to run against a developer's or production database configuration.
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.DB_HOST, '127.0.0.1');
  assert.equal(process.env.DB_NAME, 'backend_ci');
  assert.equal(process.env.DB_USER, 'backend_ci');
  assert.ok(process.env.JWT_SECRET, 'A temporary JWT_SECRET is required');
  assert.ok(!fs.existsSync(path.join(root, '.env')), 'Use a clean checkout without .env');
  assert.ok(!fs.existsSync(path.join(root, 'configuration/firebase-service-account.json')),
    'Use a clean checkout without Firebase credentials');

  const server = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'inherit' });
  let failure;
  const stopped = new Promise(resolve => {
    server.once('error', error => { failure = error; resolve(); });
    server.once('exit', (code, signal) => {
      failure = new Error(`Backend exited before validation completed (${code ?? signal})`);
      resolve();
    });
  });

  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      let response;
      try {
        response = await fetch(`http://127.0.0.1:${process.env.PORT || '5001'}/health`, {
          signal: AbortSignal.timeout(1000),
        });
      } catch (error) {
        if (!['TypeError', 'TimeoutError'].includes(error.name)) throw error;
      }
      if (response) {
        assert.equal(response.status, 200, 'Health endpoint must return HTTP 200');
        assert.deepEqual(await response.json(), { status: 'ok', socket: 'enabled' });
        // Give immediate asynchronous startup failures time to surface.
        await delay(250);
        if (failure) throw failure;
        console.log('Backend startup, imports, database connection and /health validated.');
        return;
      }
      await delay(250);
    }
    throw new Error('Backend did not become healthy within 20 seconds');
  } finally {
    server.kill('SIGTERM');
    await Promise.race([stopped, delay(2000)]);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGKILL');
      await stopped;
    }
  }
}

async function main() {
  switch (process.argv[2]) {
    case 'syntax': console.log(`Syntax checked ${checkSyntax()} JavaScript files.`); break;
    case 'tests': runTests(); break;
    case 'startup': await checkStartup(); break;
    default: throw new Error('Usage: node .github/scripts/backend-check.cjs syntax|tests|startup');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
