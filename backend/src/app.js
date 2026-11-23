// Express application (no listening here - server.js starts it; tests import it directly).
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env, PROJECT_ROOT } from './config/env.js';
import { pgHealth } from './db/pg.js';
import { mongoHealth } from './db/mongo.js';
import { aiHealth } from './services/aiClient.js';
import { chainStatus } from './services/chainClient.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { ok } from './utils/http.js';
import authRoutes from './modules/auth.routes.js';
import publicRoutes from './modules/public.routes.js';
import beekeeperRoutes from './modules/beekeeper.routes.js';
import batchRoutes from './modules/batches.routes.js';
import labRoutes from './modules/lab.routes.js';
import aiRoutes from './modules/ai.routes.js';
import supplyRoutes from './modules/supplychain.routes.js';
import adminRoutes from './modules/admin.routes.js';
import transferRoutes from './modules/transfers.routes.js';
import { BATCH_STATUSES } from './modules/batches.routes.js';
import { ALL_ROLES } from './config/roles.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cors({ origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()), credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  const api = express.Router();

  api.get('/health', async (_req, res) => {
    const [postgres, mongodb, aiService, blockchain] = await Promise.all([pgHealth(), mongoHealth(), aiHealth(), chainStatus()]);
    const all = [postgres, mongodb, aiService, blockchain].every((s) => s.status === 'up');
    res.status(postgres.status === 'up' ? 200 : 503).json({
      data: { status: all ? 'ok' : 'degraded', postgres, mongodb, aiService, blockchain: { status: blockchain.status, detail: blockchain.detail, network: blockchain.network } },
    });
  });

  api.get('/meta/enums', requireAuth, (_req, res) =>
    ok(res, {
      hiveTypes: ['LANGSTROTH', 'NEWTON', 'TOP_BAR', 'TRADITIONAL', 'OTHER'],
      processingMethods: ['FILTRATION', 'STRAINING', 'SETTLING', 'GENTLE_WARMING', 'CREAMING', 'OTHER'],
      packagingTypes: ['GLASS_JAR', 'PET_JAR', 'SACHET', 'TIN', 'BULK_DRUM', 'OTHER'],
      destinationTypes: ['WAREHOUSE', 'DISTRIBUTOR', 'RETAILER', 'INSTITUTION', 'OTHER'],
      adulterationResults: ['NOT_DETECTED', 'DETECTED', 'INCONCLUSIVE', 'NOT_TESTED'],
      batchStatuses: BATCH_STATUSES,
      labDecisions: ['PASS', 'FAIL', 'INCONCLUSIVE'],
      roles: ALL_ROLES,
    }));

  api.use('/auth', authRoutes);
  api.use(publicRoutes);
  api.use(beekeeperRoutes);
  api.use(batchRoutes);
  api.use(transferRoutes);
  api.use(labRoutes);
  api.use(aiRoutes);
  api.use(supplyRoutes);
  api.use(adminRoutes);
  api.use(notFoundHandler);

  app.use('/api/v1', api);

  // Optional: serve the built React app (npm run build in frontend) from the same origin,
  // useful for scanning QR codes from a phone on the same Wi-Fi.
  const dist = path.join(PROJECT_ROOT, 'frontend', 'dist');
  if (env.SERVE_FRONTEND && fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
