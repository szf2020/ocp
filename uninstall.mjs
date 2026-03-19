#!/usr/bin/env node
/**
 * openclaw-claude-proxy uninstaller
 *
 * Stops and removes the launchd (macOS) or systemd (Linux) auto-start entry.
 * Run: node uninstall.mjs
 */
import { existsSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();

function log(msg) { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }

console.log("\n🗑  Uninstalling openclaw-claude-proxy auto-start...\n");

const platform = process.platform;

if (platform === "darwin") {
  const plistPath = join(HOME, "Library", "LaunchAgents", "ai.openclaw.proxy.plist");

  if (existsSync(plistPath)) {
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null`);
      log("launchd service stopped and unloaded");
    } catch {
      warn("launchctl unload failed (service may not have been running)");
    }
    unlinkSync(plistPath);
    log(`Plist removed: ${plistPath}`);
  } else {
    warn(`Plist not found: ${plistPath}`);
  }

} else if (platform === "linux") {
  const servicePath = join(HOME, ".config", "systemd", "user", "openclaw-proxy.service");

  try { execSync(`systemctl --user stop openclaw-proxy 2>/dev/null`); } catch { /* ignore */ }
  log("systemd service stopped");

  try { execSync(`systemctl --user disable openclaw-proxy 2>/dev/null`); } catch { /* ignore */ }
  log("systemd service disabled");

  if (existsSync(servicePath)) {
    unlinkSync(servicePath);
    log(`Service file removed: ${servicePath}`);
  } else {
    warn(`Service file not found: ${servicePath}`);
  }

  try { execSync(`systemctl --user daemon-reload`); } catch { /* ignore */ }

} else {
  warn(`Auto-start not supported on ${platform} — nothing to remove`);
}

console.log("\n✅ Auto-start removed — proxy will no longer start on login\n");
