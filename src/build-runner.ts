import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { upsertBuild, type BuildRecord } from './build-store.js';

const execAsync = promisify(exec);

function reposBaseDir(): string {
  return process.env.REPOS_BASE_DIR ?? 'D:\\';
}

export function resolveRepoPath(repo: string): string | null {
  const repoPath = path.join(reposBaseDir(), repo);
  if (!fs.existsSync(repoPath)) return null;
  if (!fs.existsSync(path.join(repoPath, '.git'))) return null;
  return repoPath;
}

export function listRepos(): string[] {
  const base = reposBaseDir();
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(base, d.name, '.git')))
    .map((d) => d.name);
}

const CSPROJ_TYPE_GUID = 'FAE04EC0-301F-11D3-BF4B-00C04F79EFBC';
const SOLUTION_FOLDER_TYPE_GUID = '2150E333-8FDC-42A3-9474-1A3956D46DE8';

interface CsprojInfo {
  projectName: string;
  projectPath: string;
  projectGuid: string;
}

function normalizeGuid(guid: string): string {
  return guid.replace(/[{}]/g, '').toUpperCase();
}

function toGuidLiteral(guid: string): string {
  return `{${normalizeGuid(guid)}}`;
}

function findCsprojFiles(repoPath: string): string[] {
  const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'packages']);
  const results: string[] = [];

  function walk(dir: string, depth: number) {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.csproj')) {
        results.push(full);
      }
    }
  }

  walk(repoPath, 0);
  return results;
}

function indexCsprojByGuid(repoPath: string): Map<string, CsprojInfo> {
  const index = new Map<string, CsprojInfo>();
  const projectGuidRe = /<ProjectGuid>\s*\{?([0-9A-Fa-f-]{36})\}?\s*<\/ProjectGuid>/i;

  for (const csprojPath of findCsprojFiles(repoPath)) {
    let text = '';
    try { text = fs.readFileSync(csprojPath, 'utf-8'); } catch { continue; }
    const match = projectGuidRe.exec(text);
    if (!match) continue;
    const projectGuid = normalizeGuid(match[1]);
    index.set(projectGuid, {
      projectName: path.basename(csprojPath, '.csproj'),
      projectPath: csprojPath,
      projectGuid,
    });
  }

  return index;
}

function extractMsb4051Guids(text: string): { ownerGuid: string; missingGuid: string } | null {
  const msbIndex = text.toUpperCase().indexOf('MSB4051');
  if (msbIndex < 0) return null;

  const segment = text.slice(msbIndex, msbIndex + 2000);
  const guids = [...segment.matchAll(/\{([0-9A-Fa-f-]{36})\}/g)].map((m) => normalizeGuid(m[1]));
  if (guids.length < 2) return null;

  return {
    ownerGuid: guids[0],
    missingGuid: guids[1],
  };
}

function findNestedParentGuid(slnText: string, childGuid: string): string | null {
  const eol = slnText.includes('\r\n') ? '\r\n' : '\n';
  const header = `GlobalSection(NestedProjects) = preSolution`;
  const start = slnText.indexOf(header);
  if (start < 0) return null;

  const end = slnText.indexOf(`${eol}\tEndGlobalSection`, start);
  if (end < 0) return null;

  const section = slnText.slice(start, end);
  const wanted = normalizeGuid(childGuid);

  for (const match of section.matchAll(/\{([0-9A-Fa-f-]{36})\}\s*=\s*\{([0-9A-Fa-f-]{36})\}/g)) {
    if (normalizeGuid(match[1]) === wanted) {
      return normalizeGuid(match[2]);
    }
  }
  return null;
}

function findCommonFolderGuid(slnText: string): string | null {
  const re = new RegExp(
    `Project\\("\\{${SOLUTION_FOLDER_TYPE_GUID}\\}"\\)\\s*=\\s*"Common"\\s*,\\s*"[^"]*"\\s*,\\s*"\\{([0-9A-Fa-f-]{36})\\}"`,
    'i'
  );
  const match = re.exec(slnText);
  return match ? normalizeGuid(match[1]) : null;
}

function repairMissingProjectGuidInSln(
  slnPath: string,
  ownerGuid: string,
  missingProject: CsprojInfo
): { repaired: boolean; reason: string } {
  let slnText = '';
  try {
    slnText = fs.readFileSync(slnPath, 'utf-8');
  } catch {
    return { repaired: false, reason: `Cannot read solution file: ${slnPath}` };
  }

  const eol = slnText.includes('\r\n') ? '\r\n' : '\n';
  const missingGuid = normalizeGuid(missingProject.projectGuid);
  const missingGuidLit = toGuidLiteral(missingGuid);

  const existingProjectDecl = new RegExp(
    `Project\\("\\{[0-9A-Fa-f-]{36}\\}"\\)\\s*=\\s*"[^"]+"\\s*,\\s*"[^"]+"\\s*,\\s*"\\{${missingGuid}\\}"`,
    'i'
  );
  if (existingProjectDecl.test(slnText)) {
    return { repaired: false, reason: `GUID ${missingGuidLit} is already declared in .sln` };
  }

  const globalMarker = `${eol}Global${eol}`;
  const globalPos = slnText.indexOf(globalMarker);
  if (globalPos < 0) {
    return { repaired: false, reason: 'Cannot find Global section in .sln' };
  }

  const slnDir = path.dirname(slnPath);
  const relProjectPath = path.relative(slnDir, missingProject.projectPath).replace(/\//g, '\\');
  const projectBlock =
    `Project("{${CSPROJ_TYPE_GUID}}") = "${missingProject.projectName}", "${relProjectPath}", "${missingGuidLit}"${eol}` +
    `EndProject${eol}`;
  slnText =
    slnText.slice(0, globalPos + eol.length) +
    projectBlock +
    slnText.slice(globalPos + eol.length);

  const configHeader = `GlobalSection(ProjectConfigurationPlatforms) = postSolution`;
  const configStart = slnText.indexOf(configHeader);
  if (configStart >= 0) {
    const configEnd = slnText.indexOf(`${eol}\tEndGlobalSection`, configStart);
    if (configEnd >= 0) {
      const configSection = slnText.slice(configStart, configEnd);
      const activeCfgNeedle = `${missingGuidLit}.Debug|Any CPU.ActiveCfg`;
      if (!configSection.includes(activeCfgNeedle)) {
        const configLines = [
          `\t\t${missingGuidLit}.Debug|Any CPU.ActiveCfg = Debug|Any CPU`,
          `\t\t${missingGuidLit}.Debug|Any CPU.Build.0 = Debug|Any CPU`,
          `\t\t${missingGuidLit}.Release|Any CPU.ActiveCfg = Release|Any CPU`,
          `\t\t${missingGuidLit}.Release|Any CPU.Build.0 = Release|Any CPU`,
        ].join(eol);
        slnText = slnText.slice(0, configEnd) + eol + configLines + slnText.slice(configEnd);
      }
    }
  }

  const ownerParentGuid = findNestedParentGuid(slnText, ownerGuid);
  const fallbackParentGuid = findCommonFolderGuid(slnText);
  const parentGuid = ownerParentGuid ?? fallbackParentGuid;
  if (parentGuid) {
    const nestedHeader = `GlobalSection(NestedProjects) = preSolution`;
    const nestedStart = slnText.indexOf(nestedHeader);
    if (nestedStart >= 0) {
      const nestedEnd = slnText.indexOf(`${eol}\tEndGlobalSection`, nestedStart);
      if (nestedEnd >= 0) {
        const nestedSection = slnText.slice(nestedStart, nestedEnd);
        const mappingNeedle = `${missingGuidLit} = {${parentGuid}}`;
        if (!nestedSection.includes(mappingNeedle)) {
          const nestedLine = `\t\t${mappingNeedle}`;
          slnText = slnText.slice(0, nestedEnd) + eol + nestedLine + slnText.slice(nestedEnd);
        }
      }
    }
  }

  try {
    fs.writeFileSync(slnPath, slnText, 'utf-8');
    return { repaired: true, reason: `Inserted ${missingProject.projectName} (${missingGuidLit}) into ${path.basename(slnPath)}` };
  } catch {
    return { repaired: false, reason: `Failed to write repaired solution: ${slnPath}` };
  }
}

function removeDanglingProjectDependencyInSln(
  slnPath: string,
  ownerGuid: string,
  missingGuid: string
): { repaired: boolean; reason: string } {
  let slnText = '';
  try {
    slnText = fs.readFileSync(slnPath, 'utf-8');
  } catch {
    return { repaired: false, reason: `Cannot read solution file: ${slnPath}` };
  }

  const eol = slnText.includes('\r\n') ? '\r\n' : '\n';
  const lines = slnText.split(eol);
  const ownerGuidLit = toGuidLiteral(ownerGuid);
  const missingGuidLit = toGuidLiteral(missingGuid);

  let inOwnerProject = false;
  let inDependencies = false;
  let removed = false;
  const nextLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Project(')) {
      inOwnerProject = line.includes(`"${ownerGuidLit}"`);
      inDependencies = false;
    }

    if (inOwnerProject && trimmed.startsWith('ProjectSection(ProjectDependencies)')) {
      inDependencies = true;
      nextLines.push(line);
      continue;
    }

    if (inDependencies && trimmed.startsWith('EndProjectSection')) {
      inDependencies = false;
      nextLines.push(line);
      continue;
    }

    if (inDependencies && line.includes(missingGuidLit)) {
      removed = true;
      continue;
    }

    nextLines.push(line);
    if (inOwnerProject && trimmed === 'EndProject') {
      inOwnerProject = false;
      inDependencies = false;
    }
  }

  if (!removed) {
    return {
      repaired: false,
      reason: `Missing GUID ${missingGuidLit} was not found in ProjectDependencies of owner ${ownerGuidLit}`,
    };
  }

  try {
    fs.writeFileSync(slnPath, nextLines.join(eol), 'utf-8');
    return {
      repaired: true,
      reason: `Removed dangling ProjectDependencies entry ${missingGuidLit} from owner ${ownerGuidLit} in ${path.basename(slnPath)}`,
    };
  } catch {
    return { repaired: false, reason: `Failed to write repaired solution: ${slnPath}` };
  }
}

function findAllSlnFiles(repoPath: string): string[] {
  const SKIP_DIRS = new Set(['node_modules', 'BuildSolution', '.git', 'bin', 'obj', 'packages']);
  const results: string[] = [];

  function walk(dir: string, depth: number) {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.sln')) {
        results.push(full);
      }
    }
  }
  walk(repoPath, 0);
  results.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
  return results;
}

async function getChangedFiles(repoPath: string): Promise<string[]> {
  const tryBase = async (base: string): Promise<string[] | null> => {
    try {
      const { stdout: mbOut } = await execAsync(`git merge-base HEAD origin/${base}`, { cwd: repoPath, timeout: 15000 });
      const mergeBase = mbOut.trim();
      const { stdout } = await execAsync(`git diff --name-only ${mergeBase} HEAD`, { cwd: repoPath, timeout: 15000 });
      return stdout.trim().split('\n').filter((f) => f.trim());
    } catch { return null; }
  };

  let files = await tryBase('master') ?? await tryBase('main');
  if (!files || files.length === 0) {
    try {
      const { stdout } = await execAsync('git diff --name-only HEAD~1 HEAD', { cwd: repoPath, timeout: 10000 });
      files = stdout.trim().split('\n').filter((f) => f.trim());
    } catch { files = []; }
  }
  return files ?? [];
}

function findRelatedSolutions(repoPath: string, changedFiles: string[], allSlns: string[]): string[] {
  if (changedFiles.length === 0) return allSlns;

  const related: string[] = [];
  for (const sln of allSlns) {
    const slnRelDir = path.relative(repoPath, path.dirname(sln));
    const isRoot = slnRelDir === '' || slnRelDir === '.';

    const matches = changedFiles.some((file) => {
      const normalFile = file.replace(/\//g, path.sep);
      return isRoot || normalFile.toLowerCase().startsWith(slnRelDir.toLowerCase() + path.sep);
    });

    if (matches) related.push(sln);
  }

  return related.length > 0 ? related : allSlns;
}

function buildScope(): 'all' | 'related' {
  const scope = (process.env.BUILD_SCOPE ?? 'all').toLowerCase();
  return scope === 'related' ? 'related' : 'all';
}

function isWebApplicationTargetsMissing(text: string): boolean {
  const upper = text.toUpperCase();
  return upper.includes('MSB4019') && upper.includes('MICROSOFT.WEBAPPLICATION.TARGETS');
}

function inferVisualStudioVersionFromVSToolsPath(vsToolsPath: string): string {
  const match = /\\v(\d+\.\d+)(\\|$)/i.exec(vsToolsPath);
  return match?.[1] ?? '17.0';
}

function addCandidateIfExists(candidates: string[], candidate: string): void {
  const target = path.join(candidate, 'WebApplications', 'Microsoft.WebApplication.targets');
  if (fs.existsSync(target)) {
    candidates.push(candidate);
  }
}

function findVSToolsPathForWebTargets(): string | null {
  const candidates: string[] = [];
  const envOverride = process.env.VSTOOLS_PATH;
  if (envOverride) {
    addCandidateIfExists(candidates, envOverride);
  }

  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';

  for (const yearSku of [
    ['2022', 'BuildTools'],
    ['2022', 'Enterprise'],
    ['2022', 'Professional'],
    ['2022', 'Community'],
    ['2019', 'BuildTools'],
    ['2019', 'Enterprise'],
    ['2019', 'Professional'],
    ['2019', 'Community'],
  ] as const) {
    const [year, sku] = yearSku;
    addCandidateIfExists(
      candidates,
      path.join(programFiles, 'Microsoft Visual Studio', year, sku, 'MSBuild', 'Microsoft', 'VisualStudio', 'v17.0')
    );
    addCandidateIfExists(
      candidates,
      path.join(programFilesX86, 'Microsoft Visual Studio', year, sku, 'MSBuild', 'Microsoft', 'VisualStudio', 'v17.0')
    );
    addCandidateIfExists(
      candidates,
      path.join(programFiles, 'Microsoft Visual Studio', year, sku, 'MSBuild', 'Microsoft', 'VisualStudio', 'v16.0')
    );
    addCandidateIfExists(
      candidates,
      path.join(programFilesX86, 'Microsoft Visual Studio', year, sku, 'MSBuild', 'Microsoft', 'VisualStudio', 'v16.0')
    );
  }

  addCandidateIfExists(candidates, path.join(programFilesX86, 'MSBuild', 'Microsoft', 'VisualStudio', 'v17.0'));
  addCandidateIfExists(candidates, path.join(programFilesX86, 'MSBuild', 'Microsoft', 'VisualStudio', 'v16.0'));
  addCandidateIfExists(candidates, path.join(programFiles, 'MSBuild', 'Microsoft', 'VisualStudio', 'v17.0'));
  addCandidateIfExists(candidates, path.join(programFiles, 'MSBuild', 'Microsoft', 'VisualStudio', 'v16.0'));

  const dotnetSdkDir = path.join(programFiles, 'dotnet', 'sdk');
  if (fs.existsSync(dotnetSdkDir)) {
    let sdkVersions: string[] = [];
    try {
      sdkVersions = fs.readdirSync(dotnetSdkDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse();
    } catch {
      sdkVersions = [];
    }
    for (const ver of sdkVersions) {
      const base = path.join(dotnetSdkDir, ver, 'Microsoft', 'VisualStudio');
      addCandidateIfExists(candidates, path.join(base, 'v18.0'));
      addCandidateIfExists(candidates, path.join(base, 'v17.0'));
      addCandidateIfExists(candidates, path.join(base, 'v16.0'));
    }
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    return candidate;
  }

  return null;
}

async function runCommand(
  cmd: string,
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(cmd, args, { cwd, shell: false });
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

function createTempWorktreePath(repo: string): string {
  const base = path.join(os.tmpdir(), 'mcp-build-worktrees');
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  return path.join(base, `${repo}-${suffix}`);
}

export async function triggerBuild(repo: string, branch: string): Promise<BuildRecord> {
  const repoPath = resolveRepoPath(repo);
  const id = crypto.randomUUID();
  const triggeredAt = new Date().toISOString();

  const runningRecord: BuildRecord = {
    id, repo, branch, triggeredAt, finishedAt: null,
    status: 'running', output: '', errorOutput: '',
  };
  upsertBuild(runningRecord);

  if (!repoPath) {
    const failed: BuildRecord = {
      ...runningRecord,
      finishedAt: new Date().toISOString(),
      status: 'failure',
      errorOutput: `Repo "${repo}" not found under ${reposBaseDir()}`,
    };
    upsertBuild(failed);
    return failed;
  }

  let allOutput = '';
  let allError = '';
  let success = true;
  let tempWorktreePath: string | null = null;

  try {
    // Step 1: create temporary worktree for branch build
    console.log(`[build] git fetch origin ${branch} in ${repoPath}`);
    const fetch = await runCommand('git', ['fetch', 'origin', branch], repoPath);
    allOutput += `=== git fetch ===\n${fetch.stdout}`;
    allError += fetch.stderr;
    if (fetch.code !== 0) {
      success = false;
      allError += `\ngit fetch failed with exit code ${fetch.code}`;
    }

    if (success) {
      tempWorktreePath = createTempWorktreePath(repo);
      fs.mkdirSync(path.dirname(tempWorktreePath), { recursive: true });
      console.log(`[build] git worktree add --detach ${tempWorktreePath} origin/${branch}`);
      const addWorktree = await runCommand('git', ['worktree', 'add', '--detach', tempWorktreePath, `origin/${branch}`], repoPath);
      allOutput += `\n=== git worktree add ${branch} ===\n${addWorktree.stdout}`;
      allError += addWorktree.stderr;
      if (addWorktree.code !== 0) {
        success = false;
        allError += `\ngit worktree add failed with exit code ${addWorktree.code}`;
      } else {
        const checkout = await runCommand('git', ['checkout', '-B', branch, `origin/${branch}`], tempWorktreePath);
        allOutput += `\n=== git checkout ${branch} (temp worktree) ===\n${checkout.stdout}`;
        allError += checkout.stderr;
        if (checkout.code !== 0) {
          success = false;
          allError += `\ngit checkout in temp worktree failed with exit code ${checkout.code}`;
        }
      }
    }

    // Step 2: dotnet build in temporary worktree only
    if (success && tempWorktreePath) {
      const buildRepoPath = tempWorktreePath;
      const allSlns = findAllSlnFiles(buildRepoPath);
      const scope = buildScope();
      let slnFiles = allSlns;
      if (scope === 'related') {
        const changedFiles = await getChangedFiles(buildRepoPath);
        console.log(`[build] Changed files (${changedFiles.length}): ${changedFiles.slice(0, 5).join(', ')}${changedFiles.length > 5 ? '...' : ''}`);
        slnFiles = findRelatedSolutions(buildRepoPath, changedFiles, allSlns);
        console.log(`[build] Related solutions (${slnFiles.length}): ${slnFiles.map((s) => path.relative(buildRepoPath, s)).join(', ')}`);
      } else {
        console.log(`[build] Build scope=all; solutions (${slnFiles.length}): ${slnFiles.map((s) => path.relative(buildRepoPath, s)).join(', ')}`);
      }

      let csprojIndex: Map<string, CsprojInfo> | null = null;
      let vsToolsPathForRetry: string | null = null;

      if (slnFiles.length === 0) {
        console.log('[build] No .sln found, running dotnet build in root (temp worktree)');
        const bld = await runCommand('dotnet', ['build', '--nologo'], buildRepoPath);
        allOutput += `\n=== dotnet build ===\n${bld.stdout}`;
        allError += bld.stderr;
        if (bld.code !== 0) success = false;
      } else {
        for (const sln of slnFiles) {
          const slnRel = path.relative(tempWorktreePath, sln);
          console.log(`[build] dotnet build ${slnRel}`);
          const bld = await runCommand('dotnet', ['build', sln, '--nologo'], buildRepoPath);
          allOutput += `\n=== dotnet build ${slnRel} ===\n${bld.stdout}`;
          allError += bld.stderr;
          let lastBuildStdout = bld.stdout;
          let lastBuildStderr = bld.stderr;

          let solutionSucceeded = bld.code === 0;
          if (!solutionSucceeded) {
            const msb4051 = extractMsb4051Guids(`${bld.stdout}\n${bld.stderr}`);
            if (msb4051) {
              if (!csprojIndex) {
                csprojIndex = indexCsprojByGuid(buildRepoPath);
              }
              const missingProject = csprojIndex.get(msb4051.missingGuid);
              if (missingProject) {
                const repair = repairMissingProjectGuidInSln(sln, msb4051.ownerGuid, missingProject);
                allOutput += `\n=== auto-repair ${slnRel} ===\n${repair.reason}\n`;
                if (repair.repaired) {
                  console.log(`[build] auto-repair applied to ${slnRel}; retrying once`);
                  const retry = await runCommand('dotnet', ['build', sln, '--nologo'], buildRepoPath);
                  allOutput += `\n=== dotnet build (retry after auto-repair) ${slnRel} ===\n${retry.stdout}`;
                  allError += retry.stderr;
                  lastBuildStdout = retry.stdout;
                  lastBuildStderr = retry.stderr;
                  solutionSucceeded = retry.code === 0;
                }
              } else {
                const cleanup = removeDanglingProjectDependencyInSln(sln, msb4051.ownerGuid, msb4051.missingGuid);
                allOutput += `\n=== auto-repair ${slnRel} ===\n${cleanup.reason}\n`;
                if (cleanup.repaired) {
                  console.log(`[build] removed dangling dependency in ${slnRel}; retrying once`);
                  const retry = await runCommand('dotnet', ['build', sln, '--nologo'], buildRepoPath);
                  allOutput += `\n=== dotnet build (retry after dependency cleanup) ${slnRel} ===\n${retry.stdout}`;
                  allError += retry.stderr;
                  lastBuildStdout = retry.stdout;
                  lastBuildStderr = retry.stderr;
                  solutionSucceeded = retry.code === 0;
                } else {
                  allError += `\n[auto-repair] MSB4051 detected in ${slnRel}, but missing GUID {${msb4051.missingGuid}} was not found in any .csproj ProjectGuid and dependency cleanup did not apply.\n`;
                }
              }
            }
          }

          if (!solutionSucceeded && isWebApplicationTargetsMissing(`${lastBuildStdout}\n${lastBuildStderr}`)) {
            if (!vsToolsPathForRetry) {
              vsToolsPathForRetry = findVSToolsPathForWebTargets();
            }
            if (vsToolsPathForRetry) {
              const vsVersion = inferVisualStudioVersionFromVSToolsPath(vsToolsPathForRetry);
              allOutput += `\n=== web-targets fallback ${slnRel} ===\nUsing VSToolsPath=${vsToolsPathForRetry} (VisualStudioVersion=${vsVersion})\n`;
              console.log(`[build] MSB4019 fallback for ${slnRel} using ${vsToolsPathForRetry}`);
              const retryWithVSTools = await runCommand(
                'dotnet',
                [
                  'build',
                  sln,
                  '--nologo',
                  `/p:VSToolsPath=${vsToolsPathForRetry}`,
                  `/p:VisualStudioVersion=${vsVersion}`,
                ],
                buildRepoPath
              );
              allOutput += `\n=== dotnet build (retry with VSToolsPath) ${slnRel} ===\n${retryWithVSTools.stdout}`;
              allError += retryWithVSTools.stderr;
              solutionSucceeded = retryWithVSTools.code === 0;
            } else {
              allError += `\n[web-targets] MSB4019 detected in ${slnRel}, but no usable VSToolsPath with WebApplications\\Microsoft.WebApplication.targets was found.\n`;
            }
          }

          if (!solutionSucceeded) success = false;
        }
      }
    }
  } finally {
    if (tempWorktreePath) {
      const removeWorktree = await runCommand('git', ['worktree', 'remove', '--force', tempWorktreePath], repoPath);
      allOutput += `\n=== git worktree remove ===\n${removeWorktree.stdout}`;
      allError += removeWorktree.stderr;
      if (removeWorktree.code !== 0) {
        success = false;
        allError += `\ngit worktree remove failed with exit code ${removeWorktree.code}`;
      }

      const prune = await runCommand('git', ['worktree', 'prune'], repoPath);
      allOutput += `\n=== git worktree prune ===\n${prune.stdout}`;
      allError += prune.stderr;

      try {
        fs.rmSync(tempWorktreePath, { recursive: true, force: true });
      } catch (e) {
        success = false;
        allError += `\nfailed to remove temp worktree directory: ${(e as Error).message}`;
      }
    }
  }

  const finished: BuildRecord = {
    id, repo, branch, triggeredAt,
    finishedAt: new Date().toISOString(),
    status: success ? 'success' : 'failure',
    output: allOutput.slice(0, 20_000),
    errorOutput: allError.slice(0, 5_000),
  };
  upsertBuild(finished);
  console.log(`[build] ${repo}@${branch} → ${finished.status}`);
  return finished;
}
