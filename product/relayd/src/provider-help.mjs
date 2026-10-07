// relayd provider-help.mjs — what an installed provider CLI says about itself.
//
// A leaf module on purpose: it needs only config and util. harness.mjs uses it
// to decide whether Claude Code has --effort at all, and catalog.mjs uses it
// to advertise the effort levels that CLI accepts. catalog.mjs cannot import
// harness.mjs for this, because harness reaches jobs.mjs (through events.mjs)
// and jobs.mjs imports the catalog.

import { execFileSync } from "node:child_process";

import { codexBin, claudeBin, kimiBin, runHome, codexHome, kimiHome } from "./config.mjs";
import { cleanApiText } from "./util.mjs";

const providerHelpCacheMs = 5 * 60 * 1000;
const providerHelpCache = new Map();

function providerBinary(provider) {
  if (provider === "claude") return claudeBin;
  if (provider === "kimi") return kimiBin;
  return codexBin;
}

// Every readiness probe must see the same home and credential boundary as a
// real job. A successful login in the operator's account is irrelevant when
// the isolated Relay runner cannot read it.
function providerEnv(provider) {
  const env = {
    ...process.env,
    HOME: runHome,
    CODEX_HOME: codexHome,
    KIMI_CODE_HOME: kimiHome,
  };
  if (provider === "claude" || provider === "kimi") {
    delete env.AWS_ACCESS_KEY_ID;
    delete env.AWS_SECRET_ACCESS_KEY;
    delete env.AWS_SESSION_TOKEN;
    delete env.AWS_PROFILE;
    delete env.AWS_DEFAULT_PROFILE;
    delete env.AWS_REGION;
    delete env.AWS_DEFAULT_REGION;
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.CLAUDE_AWS_PROFILE;
  }
  return env;
}

function providerHelp(provider) {
  const bin = providerBinary(provider);
  const cached = providerHelpCache.get(provider);
  if (cached && cached.bin === bin && cached.expiresAt > Date.now()) return cached.text;
  let help = "";
  try {
    help = cleanApiText(execFileSync(bin, ["--help"], {
      encoding: "utf8",
      timeout: 10000,
      env: providerEnv(provider),
      cwd: runHome,
    }));
  } catch {}
  providerHelpCache.set(provider, { bin, text: help, expiresAt: Date.now() + providerHelpCacheMs });
  return help;
}

// The effort levels relayd will ever pass through, in the order the app lists
// them. Anything the CLI names outside this set is ignored.
const relayEffortLevels = ["low", "medium", "high", "xhigh", "max", "ultra"];

// Reads the levels a Claude Code CLI accepts out of its own help, e.g.
//   --effort <level>   Effort level for the current session
//                      (low, medium, high, xhigh, max)
// The list wraps onto a continuation line on real terminals, so the match runs
// from the flag to the first parenthesised group, stopping at the next option.
// Returns null when the help has no --effort, or no list we recognise; callers
// then keep whatever they advertised before.
function parseClaudeEffortLevels(help) {
  const text = String(help || "");
  const flag = text.match(/(?:^|\s)--effort\s+<[^>\n]*>/);
  if (!flag) return null;
  const rest = text.slice(flag.index + flag[0].length);
  const nextOption = rest.search(/\n\s*-{1,2}[A-Za-z]/);
  const description = nextOption === -1 ? rest.slice(0, 400) : rest.slice(0, Math.min(nextOption, 400));
  const list = description.match(/\(([^()]*)\)/);
  if (!list) return null;
  const named = new Set(list[1].split(/[,|/\s]+/).map((level) => level.trim().toLowerCase()).filter(Boolean));
  const levels = relayEffortLevels.filter((level) => named.has(level));
  return levels.length ? levels : null;
}

// What the installed Claude Code accepts for --effort, or null when its help
// cannot be read or parsed. Rides on providerHelp's cache, so this costs one
// `claude --help` per cache window however many catalog requests arrive.
function claudeEffortLevels() {
  return parseClaudeEffortLevels(providerHelp("claude"));
}

export {
  providerBinary,
  providerEnv,
  providerHelp,
  parseClaudeEffortLevels,
  claudeEffortLevels,
};
