import { Router, type Request, type Response } from 'express';
import { triggerBuild } from './build-runner.js';

export function createWebhookRouter(secret: string): Router {
  const router = Router();

  router.post('/', (req: Request, res: Response) => {
    // Authenticate
    const provided = req.headers['x-webhook-secret'];
    if (!secret || provided !== secret) {
      res.status(401).json({ error: 'Unauthorized: invalid or missing X-Webhook-Secret' });
      return;
    }

    const { repo, branch } = req.body as { repo?: string; branch?: string };
    if (!repo || typeof repo !== 'string') {
      res.status(400).json({ error: 'Missing required field: repo' });
      return;
    }

    const safeBranch = (branch && typeof branch === 'string') ? branch : 'main';

    // Respond immediately — build runs asynchronously
    res.json({ accepted: true, repo, branch: safeBranch, message: 'Build triggered' });

    triggerBuild(repo, safeBranch).catch((err: unknown) => {
      console.error('[webhook] build error:', err);
    });
  });

  return router;
}
