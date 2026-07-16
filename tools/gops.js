#!/usr/bin/env node
/**
 * GOPS launcher — after `npm run link`:
 *   gops k=2
 *   gops k=6 --table
 *   gops k=2 --seed 42
 *   gops n=13 k=2
 *   gops --full k=2
 *   gops k=5 --build
 *   gops k=5 --build --workers=1
 *   gops --stop
 *
 * Play commands talk to a background Python daemon (auto-started) so re-running
 * `gops k=N` after exit skips numpy/numba import+warmup.
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const PLAY_AI = path.join(__dirname, "..", "build", "gops", "play", "play_ai.py");
const GOPS_ROOT = path.join(__dirname, "..", "build", "gops");
const STATE_PATH = path.join(os.tmpdir(), "gops-daemon.json");
const DAEMON_WAIT_MS = 45_000;

/** Source files whose mtime bump should recycle the warm daemon. */
function watchedSources() {
  const nash = path.join(GOPS_ROOT, "nash");
  const files = [
    PLAY_AI,
    path.join(nash, "solve_nash.py"),
    path.join(nash, "matrix_game.py"),
    path.join(nash, "build_endgame.py"),
    path.join(nash, "solve_value.pyx"),
  ];
  try {
    for (const name of fs.readdirSync(nash)) {
      if (/\.(pyd|so|dll)$/i.test(name)) {
        files.push(path.join(nash, name));
      }
    }
  } catch {
    /* ignore */
  }
  return files;
}

function sourcesNewerThan(bootMs) {
  const boot = Number(bootMs) || 0;
  for (const f of watchedSources()) {
    try {
      if (fs.statSync(f).mtimeMs > boot) return true;
    } catch {
      /* missing file ok */
    }
  }
  return false;
}

function stopDaemonSync() {
  spawnSync("python", ["-u", PLAY_AI, "--stop"], {
    stdio: "ignore",
    shell: false,
  });
}

function printUsage() {
  console.error(`Usage:
  gops k=<K>              play N=13 endgame (on-demand LP; default K=2)
  gops n=<N> k=<K>        same, custom N (default N=13)
  gops k=6 --table        load exact/largest available table (never auto-builds)
  gops k=2 --seed 42
  gops --full [n=] [k=]   play from the opening
  gops k=<K> --build      build/rebuild endgame table only (does not play)
  gops n=<N> k=<K> --build
  gops k=<K> --build --workers=<N>   parallel workers (default 1)
  gops --stop             stop background daemon
  gops --vs k=<K>         enter each prize; AI bids first

Play uses a warm daemon (auto-started; restarts if play/nash sources change).`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function pingDaemon(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port, timeout: timeoutMs });
    let buf = "";
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    sock.on("connect", () => {
      sock.write(JSON.stringify({ cmd: "ping" }) + "\n");
    });
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      if (buf.includes("pong")) done(true);
    });
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
    sock.on("close", () => {
      if (!buf.includes("pong")) done(false);
    });
  });
}

async function ensureDaemon() {
  const existing = readState();
  if (existing && existing.port && (await pingDaemon(existing.port))) {
    if (sourcesNewerThan(existing.boot_ms)) {
      process.stderr.write(
        "gops sources changed — restarting daemon...\n"
      );
      stopDaemonSync();
    } else {
      return existing;
    }
  }

  process.stderr.write("Starting gops daemon (one-time warmup)...\n");
  const child = spawn("python", ["-u", PLAY_AI, "--daemon"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();

  const t0 = Date.now();
  while (Date.now() - t0 < DAEMON_WAIT_MS) {
    await sleep(100);
    const st = readState();
    if (st && st.port && (await pingDaemon(st.port))) {
      return st;
    }
  }
  throw new Error(
    `gops daemon failed to become ready within ${DAEMON_WAIT_MS}ms`
  );
}

function playViaDaemon(state, argv, wall0) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port: state.port });
    let exitCode = 0;

    const cleanup = (code) => {
      try {
        process.stdin.unpipe(sock);
      } catch {
        /* ignore */
      }
      resolve(code);
    };

    sock.on("connect", () => {
      sock.write(
        JSON.stringify({ cmd: "play", argv, wall0: String(wall0) }) + "\n"
      );
      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(false);
        } catch {
          /* ignore */
        }
      }
      process.stdin.resume();
      process.stdin.pipe(sock);
      sock.pipe(process.stdout);
    });

    sock.on("error", (err) => {
      console.error(`gops daemon connection failed: ${err.message}`);
      exitCode = 1;
      cleanup(1);
    });

    sock.on("close", () => cleanup(exitCode));

    const onSig = () => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      process.exit(130);
    };
    process.once("SIGINT", onSig);
    process.once("SIGTERM", onSig);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    printUsage();
    process.exit(0);
  }

  // Build stays out-of-band (writes tables); does not need the play daemon.
  if (argv.includes("--build") || argv.includes("--build-only")) {
    const r = spawnSync("python", ["-u", PLAY_AI, ...argv], {
      stdio: "inherit",
      shell: false,
    });
    process.exit(r.status == null ? 1 : r.status);
  }

  if (argv.includes("--stop")) {
    const r = spawnSync("python", ["-u", PLAY_AI, "--stop"], {
      stdio: "inherit",
      shell: false,
    });
    process.exit(r.status == null ? 1 : r.status);
  }

  if (argv.includes("--daemon")) {
    const r = spawnSync("python", ["-u", PLAY_AI, "--daemon"], {
      stdio: "inherit",
      shell: false,
    });
    process.exit(r.status == null ? 1 : r.status);
  }

  const wall0 = Date.now();
  process.env.GOPS_WALL0 = String(wall0);

  try {
    const state = await ensureDaemon();
    const code = await playViaDaemon(state, argv, wall0);
    process.exit(code);
  } catch (err) {
    console.error(String(err && err.message ? err.message : err));
    process.exit(1);
  }
}

main();
