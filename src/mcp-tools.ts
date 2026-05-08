import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v3';
import fs from 'fs';
import path from 'path';
import { triggerBuild, listRepos, resolveRepoPath } from './build-runner.js';
import {
  getLatestBuild,
  getBuildsForRepo,
  getAllLatestBuilds,
} from './build-store.js';

export function registerTools(server: McpServer): void {
  // ── list_repos ──────────────────────────────────────────────────────────────
  server.registerTool(
    'list_repos',
    { description: 'List all git repositories found in the configured REPOS_BASE_DIR on the VDI' },
    async () => {
      const repos = listRepos();
      if (repos.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No git repositories found.' }] };
      }
      return {
        content: [{
          type: 'text' as const,
          text: `Found ${repos.length} repo(s):\n${repos.map((r) => `• ${r}`).join('\n')}`,
        }],
      };
    }
  );

  // ── build_status ────────────────────────────────────────────────────────────
  server.registerTool(
    'build_status',
    {
      description: 'Get the latest build result for a specific repository',
      inputSchema: z.object({
        repo: z.string().describe('Repository directory name under REPOS_BASE_DIR'),
      }),
    },
    async ({ repo }) => {
      const build = getLatestBuild(repo);
      if (!build) {
        return { content: [{ type: 'text' as const, text: `No builds recorded for repo "${repo}".` }] };
      }
      const lines = [
        `**Repo:** ${build.repo}`,
        `**Branch:** ${build.branch}`,
        `**Status:** ${build.status.toUpperCase()}`,
        `**Triggered:** ${build.triggeredAt}`,
        `**Finished:** ${build.finishedAt ?? '(still running)'}`,
        '',
        '### Build Output',
        build.output || '(none)',
      ];
      if (build.errorOutput) {
        lines.push('', '### Error Output', build.errorOutput);
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }
  );

  // ── trigger_build ───────────────────────────────────────────────────────────
  server.registerTool(
    'trigger_build',
    {
      description: 'Manually trigger a git pull + dotnet build for a repository',
      inputSchema: z.object({
        repo: z.string().describe('Repository directory name under REPOS_BASE_DIR'),
        branch: z.string().optional().describe('Branch to pull (defaults to "main")'),
      }),
    },
    async ({ repo, branch }) => {
      const safeBranch = branch ?? 'main';
      if (!resolveRepoPath(repo)) {
        return {
          content: [{
            type: 'text' as const,
            text: `❌ Repo "${repo}" not found. Run list_repos to see available repos.`,
          }],
        };
      }
      triggerBuild(repo, safeBranch).catch((e: unknown) => console.error(e));
      return {
        content: [{
          type: 'text' as const,
          text: `✅ Build triggered for **${repo}** (branch: ${safeBranch}).\nRun \`build_status\` in a few seconds to see the result.`,
        }],
      };
    }
  );

  // ── list_build_history ──────────────────────────────────────────────────────
  server.registerTool(
    'list_build_history',
    {
      description: 'List recent builds — either for a specific repo or all repos',
      inputSchema: z.object({
        repo: z.string().optional().describe('Repo name to filter by; omit for all repos'),
        limit: z.number().optional().describe('Max number of builds to return (default: 10)'),
      }),
    },
    async ({ repo, limit = 10 }) => {
      const builds = repo ? getBuildsForRepo(repo, limit) : getAllLatestBuilds();
      if (builds.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No build history found.' }] };
      }
      const lines = builds.slice(0, limit).map((b) =>
        `• [${b.status.toUpperCase()}] ${b.repo}@${b.branch} — ${b.triggeredAt.substring(0, 19).replace('T', ' ')} — id:${b.id.substring(0, 8)}`
      );
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }
  );
}
