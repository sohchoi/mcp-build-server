import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
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

interface RepoBuildConfig {
  solutions?: string[];  // explicit list of sln paths (relative to repo root)
  excluded?: string[];   // sln paths to always skip (relative to repo root)
}

function readRepoBuildConfig(repoPath: string): RepoBuildConfig {
  const cfgPath = path.join(repoPath, '.mcp-build.json');
  if (!fs.existsSync(cfgPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as RepoBuildConfig;
  } catch {
    return {};
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

  // Step 1: fetch + checkout the target branch
  console.log(`[build] git fetch origin ${branch} in ${repoPath}`);
  const fetch = await runCommand('git', ['fetch', 'origin', branch], repoPath);
  allOutput += `=== git fetch ===\n${fetch.stdout}`;
  allError += fetch.stderr;

  console.log(`[build] git checkout -B ${branch} origin/${branch}`);
  const checkout = await runCommand('git', ['checkout', '-B', branch, `origin/${branch}`], repoPath);
  allOutput += `\n=== git checkout ${branch} ===\n${checkout.stdout}`;
  allError += checkout.stderr;
  if (checkout.code !== 0) {
    success = false;
    allError += `\ngit checkout failed with exit code ${checkout.code}`;
  }

  // Step 2: dotnet build relevant solutions
  if (success) {
    const cfg = readRepoBuildConfig(repoPath);

    let slnFiles: string[];
    if (cfg.solutions && cfg.solutions.length > 0) {
      slnFiles = cfg.solutions.map((s) => path.join(repoPath, s));
      console.log(`[build] Using explicit solutions from .mcp-build.json: ${slnFiles.length}`);
    } else {
      const excludedSet = new Set(
        (cfg.excluded ?? []).map((e) => path.join(repoPath, e).toLowerCase())
      );
      const allSlns = findAllSlnFiles(repoPath).filter(
        (s) => !excludedSet.has(s.toLowerCase())
      );

      const changedFiles = await getChangedFiles(repoPath);
      console.log(`[build] Changed files (${changedFiles.length}): ${changedFiles.slice(0, 5).join(', ')}${changedFiles.length > 5 ? '...' : ''}`);

      slnFiles = findRelatedSolutions(repoPath, changedFiles, allSlns);
      console.log(`[build] Related solutions (${slnFiles.length}): ${slnFiles.map((s) => path.relative(repoPath, s)).join(', ')}`);
    }

    if (slnFiles.length === 0) {
      console.log(`[build] No .sln found, running dotnet build in root`);
      const bld = await runCommand('dotnet', ['build', '--nologo'], repoPath);
      allOutput += `\n=== dotnet build ===\n${bld.stdout}`;
      allError += bld.stderr;
      if (bld.code !== 0) success = false;
    } else {
      for (const sln of slnFiles) {
        const slnRel = path.relative(repoPath, sln);
        console.log(`[build] dotnet build ${slnRel}`);
        const bld = await runCommand('dotnet', ['build', sln, '--nologo'], repoPath);
        allOutput += `\n=== dotnet build ${slnRel} ===\n${bld.stdout}`;
        allError += bld.stderr;
        if (bld.code !== 0) success = false;
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
