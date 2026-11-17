/**
 * Bridge lifecycle manager shared by the ACP adapter (on-demand auto-start)
 * and the plugin backend (control panel RPC).
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const base = (url) => url.replace(/\/v1\/?$/, "");

export async function bridgeHealth(url) {
  try {
    const r = await fetch(`${base(url)}/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

export function readProxy(repoPath) {
  let proxy = process.env.GEMINI_PROXY || "";
  const envFile = join(repoPath, ".env");
  if (!proxy && existsSync(envFile)) {
    const m = readFileSync(envFile, "utf8").match(/^GEMINI_PROXY=(.+)$/m);
    if (m) proxy = m[1].trim();
  }
  return proxy;
}

export function isRunning() {
  try {
    execSync("pgrep -f 'python.* -m gemini_bridge'", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function startBridge(repoPath, proxy) {
  const env = { ...process.env };
  if (proxy) env.GEMINI_PROXY = proxy;
  const child = spawn("uv", ["run", "python", "-m", "gemini_bridge"], {
    cwd: repoPath,
    env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid;
}

export function stopBridge() {
  try {
    execSync("pkill -f 'python.* -m gemini_bridge'");
  } catch {
    /* not running */
  }
}

/** Start the bridge if down and wait until healthy (on-demand). */
export async function ensureBridge(repoPath, url, timeoutMs = 75000) {
  if (await bridgeHealth(url)) return true;
  startBridge(repoPath, readProxy(repoPath));
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await bridgeHealth(url)) return true;
  }
  return false;
}

const activityFile = (repoPath) => join(repoPath, ".bridge-activity");

/** Mark bridge activity (resets the idle auto-stop window). */
export function touchActivity(repoPath) {
  try {
    writeFileSync(activityFile(repoPath), String(Date.now()));
  } catch {}
}

export function lastActivity(repoPath) {
  try {
    return Number(readFileSync(activityFile(repoPath), "utf8")) || 0;
  } catch {
    return 0;
  }
}