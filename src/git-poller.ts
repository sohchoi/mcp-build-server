import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { triggerBuild, listRepos, resolveRepoPath } from './build-runner.js';

const execAsync = promisify(exec);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '120000', 10); // 2 min default
const STATE_FILE = path.join(__dirname, '..', 'data', 'poller-state.json');

interface PollerState {
  // repo -> branch -> last known remote commit SHA
  [repo: string]: { [branch: string]: string };
}

function loadState(): PollerState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as PollerState;
    }
  } catch { /* ignore */ }
  return {};
}

function saveState(state: PollerState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function getRemoteHeadSha(repoPath: string, branch: string): Promise<string | null> {
  try {
    await execAsync(`git fetch origin ${branch}`, { cwd: repoPath, timeout: 30000 });
    const { stdout } = await execAsync(`git rev-parse origin/${branch}`, { cwd: repoPath });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function getTrackedBranches(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync('git branch -r --format=%(refname:short)', { cwd: repoPath });
    return stdout
      .trim()
      .split('\n')
      .map((b) => b.trim().replace(/^origin\//, ''))
      .filter((b) => b && b !== 'HEAD');
  } catch {
    return [];
  }
}

async function pollRepo(repo: string, state: PollerState): Promise<void> {
  const repoPath = resolveRepoPath(repo);
  if (!repoPath) return;

  if (!state[repo]) state[repo] = {};

  const branches = await getTrackedBranches(repoPath);

  // Process branches one at a time to avoid hammering TFS
  for (const branch of branches) {
    const remoteSha = await getRemoteHeadSha(repoPath, branch);
    if (!remoteSha) continue;

    const lastSha = state[repo][branch];
    if (lastSha !== remoteSha) {
      if (lastSha) {
        console.log(`[poller] ${repo}@${branch} changed: ${lastSha.slice(0, 7)} → ${remoteSha.slice(0, 7)}`);
        triggerBuild(repo, branch).catch((e: unknown) => console.error('[poller] build error:', e));
      } else {
        console.log(`[poller] ${repo}@${branch} first seen at ${remoteSha.slice(0, 7)}`);
      }
      state[repo][branch] = remoteSha;
    }
  }
}

let isPolling = false;

export async function startPoller(): Promise<void> {
  console.log(`[poller] Starting — polling every ${POLL_INTERVAL_MS / 1000}s`);

  async function poll() {
    if (isPolling) {
      console.log('[poller] Previous poll still running, skipping this cycle');
      return;
    }
    isPolling = true;
    try {
      const repos = listRepos();
      const state = loadState();
      for (const repo of repos) {
        try {
          await pollRepo(repo, state);
        } catch (e: unknown) {
          console.error(`[poller] error polling ${repo}:`, e);
        }
      }
      saveState(state);
    } finally {
      isPolling = false;
    }
  }

  // Run seeding in background — don't await, so server stays responsive
  poll().catch((e: unknown) => console.error('[poller] initial seed error:', e));
  setInterval(poll, POLL_INTERVAL_MS);
}
