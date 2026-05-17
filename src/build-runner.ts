import { spawn, exec, execSync } from 'child_process';
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

function findMSBuildPath(): string | null {
  const envPath = process.env.MSBUILD_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  const vswhere = path.join(
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Microsoft Visual Studio', 'Installer', 'vswhere.exe'
  );
  if (!fs.existsSync(vswhere)) return null;

  try {
    const installPath = execSync(
      `"${vswhere}" -latest -property installationPath`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();
    const msbuild = path.join(installPath, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe');
    if (fs.existsSync(msbuild)) return msbuild;
  } catch { /* fall through */ }

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBranchWithRetry(
  repoPath: string,
  branch: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  const maxAttempts = Math.max(1, parseInt(process.env.FETCH_BRANCH_MAX_ATTEMPTS ?? '20', 10));
  const retryDelayMs = Math.max(1000, parseInt(process.env.FETCH_BRANCH_RETRY_DELAY_MS ?? '3000', 10));
  let allStdout = '';
  let allStderr = '';
  let lastCode = 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await runCommand('git', ['fetch', 'origin', branch], repoPath);
    allStdout += `\n[attempt ${attempt}/${maxAttempts}] git fetch origin ${branch}\n${res.stdout}`;
    allStderr += res.stderr;
    lastCode = res.code;

    if (res.code === 0) {
      return { stdout: allStdout, stderr: allStderr, code: 0 };
    }

    const text = `${res.stdout}\n${res.stderr}`.toLowerCase();
    const isMissingRef = text.includes("couldn't find remote ref");
    if (!isMissingRef || attempt === maxAttempts) {
      return { stdout: allStdout, stderr: allStderr, code: lastCode };
    }

    await sleep(retryDelayMs);
  }

  return { stdout: allStdout, stderr: allStderr, code: lastCode };
}

async function waitForRemoteBranch(
  repoPath: string,
  branch: string
): Promise<{ stdout: string; stderr: string; code: number; ready: boolean }> {
  const maxAttempts = Math.max(1, parseInt(process.env.REMOTE_BRANCH_WAIT_ATTEMPTS ?? '60', 10));
  const retryDelayMs = Math.max(1000, parseInt(process.env.REMOTE_BRANCH_WAIT_DELAY_MS ?? '2000', 10));
  let allStdout = '';
  let allStderr = '';
  let lastCode = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await runCommand('git', ['ls-remote', '--heads', 'origin', branch], repoPath);
    allStdout += `\n[attempt ${attempt}/${maxAttempts}] git ls-remote --heads origin ${branch}\n${res.stdout}`;
    allStderr += res.stderr;
    lastCode = res.code;

    if (res.code !== 0) {
      return { stdout: allStdout, stderr: allStderr, code: res.code, ready: false };
    }

    if (res.stdout.trim()) {
      return { stdout: allStdout, stderr: allStderr, code: 0, ready: true };
    }

    if (attempt < maxAttempts) {
      await sleep(retryDelayMs);
    }
  }

  return { stdout: allStdout, stderr: allStderr, code: lastCode, ready: false };
}

async function prepareRepoForBranchSwitch(
  repoPath: string,
  targetBranch: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  let stdout = '';
  let stderr = '';

  const currentBranch = await runCommand('git', ['branch', '--show-current'], repoPath);
  stdout += `=== git branch --show-current ===\n${currentBranch.stdout}`;
  stderr += currentBranch.stderr;
  if (currentBranch.code !== 0) {
    stderr += `\ngit branch --show-current failed with exit code ${currentBranch.code}`;
    return { stdout, stderr, code: currentBranch.code };
  }
  const currentBranchName = currentBranch.stdout.trim();

  const status = await runCommand('git', ['status', '--porcelain'], repoPath);
  stdout += `\n=== git status --porcelain ===\n${status.stdout}`;
  stderr += status.stderr;
  if (status.code !== 0) {
    stderr += `\ngit status --porcelain failed with exit code ${status.code}`;
    return { stdout, stderr, code: status.code };
  }

  if (status.stdout.trim()) {
    const add = await runCommand('git', ['add', '-A'], repoPath);
    stdout += `\n=== git add -A ===\n${add.stdout}`;
    stderr += add.stderr;
    if (add.code !== 0) {
      stderr += `\ngit add -A failed with exit code ${add.code}`;
      return { stdout, stderr, code: add.code };
    }

    const commitMessage = `[mcp-build-server] auto-commit before switch to ${targetBranch}`;
    const commit = await runCommand('git', ['commit', '-m', commitMessage], repoPath);
    stdout += `\n=== git commit (auto) ===\n${commit.stdout}`;
    stderr += commit.stderr;
    if (commit.code !== 0) {
      stderr += `\ngit commit failed with exit code ${commit.code}`;
      return { stdout, stderr, code: commit.code };
    }
  }

  if (currentBranchName && currentBranchName !== targetBranch) {
    const checkoutExisting = await runCommand('git', ['checkout', targetBranch], repoPath);
    stdout += `\n=== git checkout ${targetBranch} ===\n${checkoutExisting.stdout}`;
    stderr += checkoutExisting.stderr;
    if (checkoutExisting.code !== 0) {
      const checkoutFromOrigin = await runCommand('git', ['checkout', '-B', targetBranch, `origin/${targetBranch}`], repoPath);
      stdout += `\n=== git checkout -B ${targetBranch} origin/${targetBranch} ===\n${checkoutFromOrigin.stdout}`;
      stderr += checkoutFromOrigin.stderr;
      if (checkoutFromOrigin.code !== 0) {
        stderr += `\ngit checkout failed with exit code ${checkoutFromOrigin.code}`;
        return { stdout, stderr, code: checkoutFromOrigin.code };
      }
    }
  }

  return { stdout, stderr, code: 0 };
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

  const msbuildPath = findMSBuildPath();
  if (!msbuildPath) {
    const failed: BuildRecord = {
      ...runningRecord,
      finishedAt: new Date().toISOString(),
      status: 'failure',
      errorOutput: 'MSBuild not found. Set MSBUILD_PATH in .env or install Visual Studio.',
    };
    upsertBuild(failed);
    return failed;
  }

  let allOutput = '';
  let allError = '';
  let success = true;

  // Step 1: wait for remote branch, fetch, auto-commit, checkout
  const longpathsConfig = await runCommand('git', ['config', 'core.longpaths', 'true'], repoPath);
  allOutput += `=== git config core.longpaths true ===\n${longpathsConfig.stdout}`;
  allError += longpathsConfig.stderr;

  const waitRemote = await waitForRemoteBranch(repoPath, branch);
  allOutput += `\n=== wait for remote branch ${branch} ===\n${waitRemote.stdout}`;
  allError += waitRemote.stderr;
  if (waitRemote.code !== 0) {
    success = false;
    allError += `\ngit ls-remote failed with exit code ${waitRemote.code}`;
  } else if (!waitRemote.ready) {
    success = false;
    allError += '\nremote branch did not appear within wait window.';
  }

  if (success) {
    console.log(`[build] git fetch origin ${branch} in ${repoPath}`);
    const fetch = await fetchBranchWithRetry(repoPath, branch);
    allOutput += `=== git fetch ===\n${fetch.stdout}`;
    allError += fetch.stderr;
    if (fetch.code !== 0) {
      success = false;
      allError += `\ngit fetch failed with exit code ${fetch.code}. Remote branch may not exist yet (pre-push timing).`;
    }
  }

  if (success) {
    const prepare = await prepareRepoForBranchSwitch(repoPath, branch);
    allOutput += `\n=== prepare repo for ${branch} ===\n${prepare.stdout}`;
    allError += prepare.stderr;
    if (prepare.code !== 0) {
      success = false;
      allError += `\nrepo preparation failed with exit code ${prepare.code}`;
    }
  }

  if (success) {
    const pull = await runCommand('git', ['pull', 'origin', branch], repoPath);
    allOutput += `\n=== git pull origin ${branch} ===\n${pull.stdout}`;
    allError += pull.stderr;
    if (pull.code !== 0) {
      success = false;
      allError += `\ngit pull failed with exit code ${pull.code}`;
    }
  }

  // Step 2: msbuild each solution in-place
  if (success) {
    const allSlns = findAllSlnFiles(repoPath);
    const scope = buildScope();
    let slnFiles = allSlns;
    if (scope === 'related') {
      const changedFiles = await getChangedFiles(repoPath);
      console.log(`[build] Changed files (${changedFiles.length}): ${changedFiles.slice(0, 5).join(', ')}${changedFiles.length > 5 ? '...' : ''}`);
      slnFiles = findRelatedSolutions(repoPath, changedFiles, allSlns);
      console.log(`[build] Related solutions (${slnFiles.length}): ${slnFiles.map((s) => path.relative(repoPath, s)).join(', ')}`);
    } else {
      console.log(`[build] Build scope=all; solutions (${slnFiles.length}): ${slnFiles.map((s) => path.relative(repoPath, s)).join(', ')}`);
    }

    if (slnFiles.length === 0) {
      console.log('[build] No .sln found, running msbuild in root');
      const bld = await runCommand(msbuildPath, ['/nologo', '/m', '/restore'], repoPath);
      allOutput += `\n=== msbuild (root) ===\n${bld.stdout}`;
      allError += bld.stderr;
      if (bld.code !== 0) success = false;
    } else {
      for (const sln of slnFiles) {
        const slnRel = path.relative(repoPath, sln);
        console.log(`[build] msbuild ${slnRel}`);
        const bld = await runCommand(msbuildPath, [sln, '/nologo', '/m', '/restore'], repoPath);
        allOutput += `\n=== msbuild ${slnRel} ===\n${bld.stdout}`;
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
