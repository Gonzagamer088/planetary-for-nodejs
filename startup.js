/* eslint-disable */
// Orbit (Planetary) - automatic startup for Node.js (no console needed).
// Usage: node startup.js   (or set "startup.js" as the start file in your hosting panel)
//
// It does the following, in order, by itself:
//   1. Reads .env (or the panel's environment variables) and checks the essentials.
//   2. Installs dependencies if they are missing.
//   3. Waits for the MySQL database to respond.
//   4. Creates / updates the tables (scripts/db-setup.js).
//   5. Generates the Prisma client if missing and builds Orbit if there is no build.
//   6. Starts Orbit. Scheduled tasks (cron jobs) start automatically with the server.
//   7. If the server crashes, it restarts it automatically.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
process.chdir(ROOT);
const LOG_DIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'orbit.log');

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    }
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {}
}

// ---------- 1. environment variables ----------
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, '');
    }
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = val;
  }
}
loadEnv(path.join(ROOT, '.env'));

// ---------- 1b. dependencies (installed automatically on first run) ----------
function ensureDependencies() {
  const need = ['next', 'mariadb', '@prisma/client', 'prisma', 'zxcvbn'];
  const missing = need.filter((m) => !fs.existsSync(path.join(ROOT, 'node_modules', m, 'package.json')));
  if (!missing.length) return;
  log(`Missing dependencies (${missing.join(', ')}). Installing with npm; the first run takes 2-5 minutes...`);
  const npmCli = path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const args = ['install', '--omit=dev', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'];
  let r;
  if (fs.existsSync(npmCli)) r = spawnSync(process.execPath, [npmCli, ...args], { cwd: ROOT, stdio: 'inherit', env: process.env });
  else r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (r.status !== 0) {
    log('ERROR installing dependencies (npm install). Check that the server has internet access to registry.npmjs.org.');
    process.exit(1);
  }
  log('Dependencies installed.');
}
ensureDependencies();

// SESSION_SECRET: Orbit requires a "strong" key (score 4/4 in zxcvbn). If it is missing or weak,
// a valid one is generated once and saved so sessions survive restarts.
function strongSecret(v) {
  if (!v || v.length < 32 || v === 'supersecretpassword') return false;
  try { return require('zxcvbn')(v).score >= 4; } catch (e) { return v.length >= 32; }
}
if (!strongSecret(process.env.SESSION_SECRET)) {
  const f = path.join(ROOT, '.session-secret');
  let secret = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '';
  if (!strongSecret(secret)) {
    do { secret = crypto.randomBytes(48).toString('base64'); } while (!strongSecret(secret));
    fs.writeFileSync(f, secret, { mode: 0o600 });
    log(process.env.SESSION_SECRET
      ? 'WARNING: your SESSION_SECRET is too weak for Orbit; using an automatically generated one (.session-secret)'
      : 'SESSION_SECRET generated automatically and saved to .session-secret');
  }
  process.env.SESSION_SECRET = secret;
}
if (!process.env.CRON_SECRET) {
  const f = path.join(ROOT, '.cron-secret');
  let s = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '';
  if (!s) { s = crypto.randomBytes(24).toString('hex'); fs.writeFileSync(f, s, { mode: 0o600 }); }
  process.env.CRON_SECRET = s;
}

const PORT = process.env.PORT || process.env.SERVER_PORT || '3000';
process.env.PORT = PORT;
process.env.NODE_ENV = 'production';
process.env.NEXT_TELEMETRY_DISABLED = '1';

if (!process.env.DATABASE_URL) {
  log('ERROR: DATABASE_URL is missing. Add this to .env:  DATABASE_URL=mysql://USER:PASSWORD@IP:3306/DATABASE');
  process.exit(1);
}
if (!/^(mysql|mariadb|jdbc:mysql):\/\//i.test(process.env.DATABASE_URL)) {
  log('ERROR: DATABASE_URL must start with mysql://  (this version of Orbit uses MySQL, not PostgreSQL)');
  process.exit(1);
}
if (!process.env.NEXTAUTH_URL && !process.env.PUBLIC_URL) {
  log('WARNING: NEXTAUTH_URL is not set (the public URL of your panel, without a trailing "/"). Some links and login may fail.');
}

// ---------- helpers ----------
function fakeEngine() {
  // Prisma 7 no longer needs the migration engine to generate the client; this no-op file avoids downloading it.
  const f = path.join(ROOT, 'scripts', 'noop-engine.js');
  return f;
}
function run(cmd, args, extraEnv) {
  log('>', cmd, args.join(' '));
  const r = spawnSync(cmd, args, {
    cwd: ROOT, stdio: 'inherit', env: Object.assign({}, process.env, extraEnv || {}),
  });
  return r.status === 0;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDb() {
  const mariadb = require('mariadb');
  const u = new URL(process.env.DATABASE_URL.replace(/^jdbc:/, ''));
  for (let i = 1; i <= 30; i++) {
    try {
      const c = await mariadb.createConnection({
        host: u.hostname, port: u.port ? Number(u.port) : 3306,
        user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
        database: u.pathname.replace(/^\//, ''), connectTimeout: 8000,
      });
      await c.end();
      log(`Database reachable at ${u.hostname}:${u.port || 3306}`);
      return;
    } catch (e) {
      log(`Waiting for the database (${i}/30): ${e.message.split('\n')[0]}`);
      await sleep(4000);
    }
  }
  log('ERROR: could not connect to the database. Check DATABASE_URL, the username and password, and that your MySQL host allows connections from this server\'s IP.');
  process.exit(1);
}

function prismaClientReady() {
  // the generated client lives in .prisma/client (resolved from @prisma/client)
  try {
    const base = path.dirname(require.resolve('@prisma/client/package.json'));
    require.resolve('.prisma/client/default', { paths: [base] });
    return true;
  } catch (e) {
    return false;
  }
}

function startNext() {
  const nextBin = path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
  const heap = process.env.ORBIT_MAX_MEMORY || '1536';
  const env = Object.assign({}, process.env, {
    NODE_OPTIONS: `--max-old-space-size=${heap} ${process.env.NODE_OPTIONS || ''}`.trim(),
  });
  log(`Starting Orbit on port ${PORT} ...`);
  return spawn(process.execPath, [nextBin, 'start', '-p', PORT, '-H', '0.0.0.0'], { cwd: ROOT, env, stdio: 'inherit' });
}

(async () => {
  log('=== Orbit startup ===');
  await waitForDb();

  // 3. tables
  try {
    await require('./scripts/db-setup.js').main();
  } catch (e) {
    log('ERROR creating the tables:', e.message);
    process.exit(1);
  }

  const engineEnv = { PRISMA_SCHEMA_ENGINE_BINARY: fakeEngine(), PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING: '1' };
  // 4a. prisma client
  if (!prismaClientReady()) {
    log('Generating the Prisma client...');
    const prismaBin = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
    if (!run(process.execPath, [prismaBin, 'generate'], engineEnv)) {
      log('ERROR generating the Prisma client');
      process.exit(1);
    }
  }
  // 4b. build
  if (!fs.existsSync(path.join(ROOT, '.next', 'BUILD_ID'))) {
    log('No build found (.next). Building (this can take several minutes and needs ~3 GB of RAM)...');
    const nextBin = path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
    if (!run(process.execPath, [nextBin, 'build', '--webpack'], { NODE_OPTIONS: '--max-old-space-size=2560' })) {
      log('ERROR building Orbit. Upload a pre-built .next folder instead.');
      process.exit(1);
    }
  }

  // 5-6. server with automatic restart
  let stopping = false;
  let restarts = 0;
  let lastStart = 0;
  function launch() {
    lastStart = Date.now();
    const child = startNext();
    const stop = () => { stopping = true; child.kill('SIGTERM'); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    child.on('exit', (code, sig) => {
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      if (stopping) process.exit(0);
      if (Date.now() - lastStart > 5 * 60 * 1000) restarts = 0;
      restarts++;
      const wait = Math.min(30000, restarts * 3000);
      log(`Orbit stopped (code ${code}${sig ? ', signal ' + sig : ''}). Restarting in ${wait / 1000}s (attempt ${restarts})...`);
      setTimeout(launch, wait);
    });
  }
  launch();
})().catch((e) => { log('FATAL ERROR:', e && e.stack ? e.stack : e); process.exit(1); });
