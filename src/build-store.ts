import fs from 'fs';
import path from 'path';

export interface BuildRecord {
  id: string;
  repo: string;
  branch: string;
  triggeredAt: string;
  finishedAt: string | null;
  status: 'running' | 'success' | 'failure';
  output: string;
  errorOutput: string;
}

interface BuildData {
  builds: Record<string, BuildRecord[]>; // keyed by repo name
}

function dataFilePath(): string {
  return path.join(__dirname, '..', 'data', 'builds.json');
}

function ensureDataDir(): void {
  const dataDir = path.dirname(dataFilePath());
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function loadData(): BuildData {
  const fp = dataFilePath();
  if (!fs.existsSync(fp)) {
    return { builds: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8')) as BuildData;
  } catch {
    return { builds: {} };
  }
}

function saveData(data: BuildData): void {
  ensureDataDir();
  fs.writeFileSync(dataFilePath(), JSON.stringify(data, null, 2), 'utf-8');
}

const maxPerRepo = parseInt(process.env.MAX_BUILDS_PER_REPO ?? '20', 10);

export function upsertBuild(record: BuildRecord): void {
  const data = loadData();
  if (!data.builds[record.repo]) {
    data.builds[record.repo] = [];
  }
  const list = data.builds[record.repo];
  const idx = list.findIndex((b) => b.id === record.id);
  if (idx >= 0) {
    list[idx] = record;
  } else {
    list.unshift(record);
    if (list.length > maxPerRepo) {
      list.splice(maxPerRepo);
    }
  }
  saveData(data);
}

export function getLatestBuild(repo: string): BuildRecord | null {
  const data = loadData();
  return data.builds[repo]?.[0] ?? null;
}

export function getBuildsForRepo(repo: string, n = 10): BuildRecord[] {
  const data = loadData();
  return (data.builds[repo] ?? []).slice(0, n);
}

export function getAllLatestBuilds(): BuildRecord[] {
  const data = loadData();
  return Object.values(data.builds)
    .map((list) => list[0])
    .filter(Boolean) as BuildRecord[];
}
