import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Pool } from 'pg';
import { NotificationService } from '../services/notification.service';
import { z } from 'zod';

export const notificationRoutes: FastifyPluginAsync<{ db: Pool }> = async (
  app: FastifyInstance,
  opts: { db: Pool }
) => {
  const service = new NotificationService(opts.db);

  // 1. REGISTER OR UPDATE DEVICE TOKEN
  app.post('/api/v1/user/device-token', async (req, reply) => {
    const schema = z.object({
      userId: z.string().uuid(),
      deviceId: z.string().min(1),
      fcmToken: z.string().min(1),
      platform: z.enum(['android', 'ios', 'web']),
      appVersion: z.string().optional()
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid device registration data', details: parsed.error.issues });
    }

    await service.registerDeviceToken(parsed.data);
    return { success: true, message: 'Device token registered successfully' };
  });

  // 2. TRACK NOTIFICATION TAP, DISPLAY OR DISMISSAL TELEMETRY
  app.post('/api/v1/telemetry/notifications/event', async (req, reply) => {
    const schema = z.object({
      notificationId: z.string().min(1),
      campaignId: z.string().optional(),
      userId: z.string().uuid().optional(),
      event: z.enum(['delivered', 'displayed', 'opened', 'action_clicked', 'dismissed']),
      actionId: z.string().optional(),
      appState: z.enum(['foreground', 'background', 'terminated']).optional(),
      deviceInfo: z.record(z.any()).optional()
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid telemetry event', details: parsed.error.issues });
    }

    await service.recordNotificationEvent(parsed.data);
    return { success: true, logged: true };
  });

  // 3. GET IN-APP INBOX NOTIFICATIONS
  app.get('/api/v1/user/notifications', async (req, reply) => {
    const query = req.query as { userId?: string; limit?: string };
    const userId = query.userId;
    if (!userId) {
      return reply.status(400).send({ error: 'userId is required' });
    }

    const limit = query.limit ? parseInt(query.limit, 10) : 30;
    const result = await service.getInboxNotifications(userId, limit);
    return { success: true, ...result };
  });

  // 4. MARK NOTIFICATION AS READ
  app.patch('/api/v1/user/notifications/:id/read', async (req, reply) => {
    const params = req.params as { id: string };
    const query = req.query as { userId?: string };
    const body = (req.body || {}) as { userId?: string };
    const userId = query.userId || body.userId;

    if (!userId) {
      return reply.status(400).send({ error: 'userId is required' });
    }

    await service.markAsRead(params.id, userId);
    return { success: true, message: 'Notification marked as read' };
  });

  // 5. DISPATCH BROADCAST / EVENT NOTIFICATION
  app.post('/api/v1/notifications/dispatch', async (req, reply) => {
    const schema = z.object({
      userId: z.string().uuid(),
      title: z.string().min(1),
      body: z.string().min(1),
      imageUrl: z.string().url().optional(),
      eventType: z.string().optional(),
      actionType: z.enum(['app_open', 'deep_link', 'web_link']).optional(),
      targetRoute: z.string().optional(),
      externalUrl: z.string().optional()
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid notification dispatch payload', details: parsed.error.issues });
    }

    const res = await service.dispatch(parsed.data);
    return { success: true, notificationId: res.id };
  });

  // 6. MANAGEMENT: BROADCAST PUSH NOTIFICATION
  app.post('/api/v1/management/notifications/broadcast', async (req, reply) => {
    const schema = z.object({
      audience: z.enum(['all', 'university', 'user']),
      universityCode: z.string().optional(),
      userId: z.string().uuid().optional(),
      title: z.string().min(1),
      body: z.string().min(1),
      imageUrl: z.string().url().optional(),
      eventType: z.string().optional(),
      actionType: z.enum(['app_open', 'deep_link', 'web_link']).optional(),
      targetRoute: z.string().optional(),
      externalUrl: z.string().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Invalid broadcast payload',
        details: parsed.error.issues,
      });
    }

    const result = await service.broadcast(parsed.data);
    return { ...result };
  });

  // 7. MANAGEMENT: NOTIFICATIONS HISTORY & TELEMETRY
  app.get('/api/v1/management/notifications/history', async (req, reply) => {
    const query = req.query as { limit?: string };
    const limit = query.limit ? parseInt(query.limit, 10) : 30;
    const history = await service.getNotificationHistory(limit);
    return { success: true, ...history };
  });
};
