// relayd skills.mjs — extracted verbatim from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { runHome, codexHome, claudeHome, maxSkillDiscoveryFiles, splitPathList } from "./config.mjs";
import { cleanApiText } from "./util.mjs";

function listProviderSkills(provider, workspacePath = null) {
  const roots = skillRoots(provider, workspacePath);
  const skills = [];
  const seen = new Set();

  for (const root of roots) {
    for (const file of findSkillFiles(root, 0, 10, [])) {
      const skill = parseSkillFile(provider, root, file);
      if (!skill || seen.has(skill.id)) continue;
      seen.add(skill.id);
      skills.push(skill);
      if (skills.length >= maxSkillDiscoveryFiles) return sortSkills(skills);
    }
  }

  return sortSkills(skills);
}


function skillRoots(provider, workspacePath = null) {
  const projectRoot = typeof workspacePath === "string" && workspacePath.trim()
    ? path.resolve(workspacePath)
    : null;
  if (provider === "claude") {
    return uniqueExistingDirectories([
      projectRoot && path.join(projectRoot, ".claude", "commands"),
      projectRoot && path.join(projectRoot, ".claude", "skills"),
      ...splitPathList(process.env.CLAUDE_SKILL_DIRS),
      path.join(claudeHome, "commands"),
      path.join(claudeHome, "skills"),
      path.join(claudeHome, "plugins", "cache"),
    ]);
  }

  if (provider === "cursor") {
    return uniqueExistingDirectories([
      ...splitPathList(process.env.CURSOR_SKILL_DIRS),
      path.join(runHome, ".cursor", "skills-cursor"),
      path.join(runHome, ".cursor", "skills"),
    ]);
  }

  return uniqueExistingDirectories([
    projectRoot && path.join(projectRoot, ".codex", "prompts"),
    projectRoot && path.join(projectRoot, ".codex", "skills"),
    projectRoot && path.join(projectRoot, ".agents", "skills"),
    ...splitPathList(process.env.CODEX_SKILL_DIRS),
    path.join(codexHome, "prompts"),
    path.join(codexHome, "skills"),
    path.join(codexHome, "plugins", "cache"),
    path.join(codexHome, "superpowers"),
    path.join(runHome, ".agents", "skills"),
  ]);
}


function uniqueExistingDirectories(entries) {
  const result = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry) continue;
    const resolved = path.resolve(entry);
    if (seen.has(resolved)) continue;
    try {
      if (!fs.statSync(resolved).isDirectory()) continue;
    } catch {
      continue;
    }
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}


function findSkillFiles(root, depth, maxDepth, files, includeMarkdown = isCommandRoot(root)) {
  if (files.length >= maxSkillDiscoveryFiles || depth > maxDepth) return files;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (files.length >= maxSkillDiscoveryFiles) break;
    if (entry.isSymbolicLink()) continue;
    if (entry.isFile() && (
      entry.name === "SKILL.md"
      || (includeMarkdown && entry.name.toLowerCase().endsWith(".md"))
    )) {
      files.push(path.join(root, entry.name));
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".cursor" || entry.name === ".windsurf") continue;
    findSkillFiles(path.join(root, entry.name), depth + 1, maxDepth, files, includeMarkdown);
  }
  return files;
}


function parseSkillFile(provider, root, file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }

  const frontmatter = raw.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  const fields = frontmatter ? parseFrontmatter(frontmatter[1]) : {};
  if (isCommandRoot(root)) {
    const relative = path.relative(root, file).replace(/\.md$/i, "");
    const name = relative
      .split(path.sep)
      .map(cleanSkillIdPart)
      .filter(Boolean)
      .join(":");
    if (!name) return null;
    return {
      id: `command:${name}`,
      name,
      title: cleanSkillMetadata(fields.name) || titleize(path.basename(file, path.extname(file))),
      provider,
      group: "Commands",
      kind: "command",
      description: cleanSkillMetadata(fields.description) || "Installed custom slash command.",
      file,
    };
  }
  const name = cleanSkillIdPart(cleanSkillMetadata(fields.name) || path.basename(path.dirname(file)));
  if (!name) return null;
  const description = cleanSkillMetadata(fields.description) || "";
  const plugin = pluginNameForSkill(root, file);
  const id = plugin ? `${plugin}:${name}` : name;
  return {
    id,
    name,
    title: titleize(name),
    provider,
    group: plugin ? titleize(plugin) : "Personal",
    kind: "skill",
    description,
    file,
  };
}


function isCommandRoot(root) {
  const name = path.basename(root).toLowerCase();
  return name === "commands" || name === "prompts";
}


function parseFrontmatter(value) {
  const fields = {};
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    fields[match[1]] = unquoteYamlScalar(match[2]);
  }
  return fields;
}


function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}


function cleanSkillMetadata(value) {
  if (typeof value !== "string") return "";
  return cleanApiText(value).replace(/\s+/g, " ").trim().slice(0, 1000);
}


function pluginNameForSkill(root, file) {
  if (path.basename(root) === "skills") return "";
  if (path.basename(root) === "superpowers") return "superpowers";

  const segments = file.split(path.sep).filter(Boolean);
  const cacheIndex = segments.lastIndexOf("cache");
  if (cacheIndex >= 0 && segments.length > cacheIndex + 2) {
    return cleanSkillIdPart(segments[cacheIndex + 2]);
  }

  const skillsIndex = segments.lastIndexOf("skills");
  if (skillsIndex > 0) {
    const parent = cleanSkillIdPart(segments[skillsIndex - 1]);
    const rootName = cleanSkillIdPart(path.basename(root));
    if (parent && rootName && parent !== rootName) return parent;
  }

  return "";
}


function cleanSkillIdPart(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}


function titleize(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}


function sortSkills(skills) {
  return skills.sort((left, right) => left.group.localeCompare(right.group) || left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
}


function publicSkill(skill) {
  return {
    id: skill.id,
    name: skill.name,
    title: skill.title,
    provider: skill.provider,
    group: skill.group,
    kind: skill.kind || "skill",
    description: skill.description,
  };
}


export {
  listProviderSkills,
  skillRoots,
  uniqueExistingDirectories,
  findSkillFiles,
  parseSkillFile,
  parseFrontmatter,
  unquoteYamlScalar,
  cleanSkillMetadata,
  pluginNameForSkill,
  cleanSkillIdPart,
  titleize,
  sortSkills,
  publicSkill,
};
