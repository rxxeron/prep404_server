import { Pool } from 'pg';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getMessaging, MulticastMessage } from 'firebase-admin/messaging';
import * as fs from 'fs';
import * as path from 'path';

export interface NotificationPayload {
  userId: string;
  title: string;
  body: string;
  imageUrl?: string;
  eventType?: string;
  actionType?: 'app_open' | 'deep_link' | 'web_link';
  targetRoute?: string;
  externalUrl?: string;
}

function initFirebase(): boolean {
  if (getApps().length > 0) return true;
  try {
    const credPath =
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
      path.resolve(__dirname, '../../service-account.json');
    if (fs.existsSync(credPath)) {
      const serviceAccount = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      initializeApp({
        credential: cert(serviceAccount),
      });
      return true;
    }
  } catch (err) {
    console.warn('[FCM] Failed to initialize Firebase Admin SDK:', err);
  }
  return false;
}

export class NotificationService {
  constructor(private readonly db: Pool) {}

  /**
   * Upsert client device token for push notifications
   */
  async registerDeviceToken(params: {
    userId: string;
    deviceId: string;
    fcmToken: string;
    platform: 'android' | 'ios' | 'web';
    appVersion?: string;
  }): Promise<boolean> {
    const { userId, deviceId, fcmToken, platform, appVersion } = params;
    await this.db.query(
      `INSERT INTO public.user_device_tokens (
        user_id, device_id, fcm_token, platform, app_version, is_active, last_seen_at
      ) VALUES ($1::uuid, $2, $3, $4, $5, true, NOW())
      ON CONFLICT (user_id, device_id) DO UPDATE SET
        fcm_token = EXCLUDED.fcm_token,
        platform = EXCLUDED.platform,
        app_version = EXCLUDED.app_version,
        is_active = true,
        last_seen_at = NOW();`,
      [userId, deviceId, fcmToken, platform, appVersion || '1.0.0']
    );
    return true;
  }

  /**
   * Log tap, open, or delivery telemetry with campaign attribution
   */
  async recordNotificationEvent(params: {
    notificationId: string;
    campaignId?: string;
    userId?: string;
    event: 'delivered' | 'displayed' | 'opened' | 'action_clicked' | 'dismissed';
    actionId?: string;
    appState?: 'foreground' | 'background' | 'terminated';
    deviceInfo?: Record<string, any>;
  }): Promise<boolean> {
    const { notificationId, campaignId, userId, event, actionId, appState, deviceInfo } = params;
    await this.db.query(
      `INSERT INTO public.notification_events (
        notification_id, campaign_id, user_id, event, action_id, app_state, device_info
      ) VALUES ($1, $2, $3::uuid, $4, $5, $6, $7::jsonb);`,
      [
        notificationId,
        campaignId || null,
        userId || null,
        event,
        actionId || null,
        appState || 'foreground',
        JSON.stringify(deviceInfo || {})
      ]
    );
    return true;
  }

  /**
   * Fetch in-app notifications for learner with unread counter
   */
  async getInboxNotifications(userId: string, limit = 30) {
    const rows = await this.db.query(
      `SELECT id, title, body, image_url AS "imageUrl", event_type AS "eventType",
              action_type AS "actionType", target_route AS "targetRoute",
              external_url AS "externalUrl", is_read AS "isRead",
              read_at AS "readAt", created_at AS "createdAt"
       FROM public.user_inbox_notifications
       WHERE user_id = $1::uuid
       ORDER BY created_at DESC
       LIMIT $2;`,
      [userId, limit]
    );

    const unreadRes = await this.db.query(
      `SELECT COUNT(*)::int AS count
       FROM public.user_inbox_notifications
       WHERE user_id = $1::uuid AND is_read = false;`,
      [userId]
    );

    return {
      notifications: rows.rows,
      unreadCount: unreadRes.rows[0]?.count || 0
    };
  }

  /**
   * Mark single or all notifications as read
   */
  async markAsRead(notificationId: string, userId: string): Promise<boolean> {
    if (notificationId === 'all') {
      await this.db.query(
        `UPDATE public.user_inbox_notifications
         SET is_read = true, read_at = NOW()
         WHERE user_id = $1::uuid AND is_read = false;`,
        [userId]
      );
    } else {
      await this.db.query(
        `UPDATE public.user_inbox_notifications
         SET is_read = true, read_at = NOW()
         WHERE id = $1::uuid AND user_id = $2::uuid;`,
        [notificationId, userId]
      );
    }
    return true;
  }

  /**
   * Dispatch notification: saves to in-app inbox & dispatches FCM push payload
   */
  async dispatch(payload: NotificationPayload): Promise<{ id: string; success: boolean }> {
    const saved = await this.db.query(
      `INSERT INTO public.user_inbox_notifications (
        user_id, title, body, image_url, event_type, action_type, target_route, external_url
      ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id;`,
      [
        payload.userId,
        payload.title,
        payload.body,
        payload.imageUrl || null,
        payload.eventType || 'announcement',
        payload.actionType || 'deep_link',
        payload.targetRoute || null,
        payload.externalUrl || null
      ]
    );

    const notifId = saved.rows[0]?.id;

    // Send Real-Time FCM Push if active tokens exist
    try {
      if (initFirebase()) {
        const tokenRows = await this.db.query(
          `SELECT fcm_token FROM public.user_device_tokens WHERE user_id = $1::uuid AND is_active = true;`,
          [payload.userId]
        );
        const tokens = tokenRows.rows.map((r: { fcm_token: string }) => r.fcm_token).filter(Boolean);
        if (tokens.length > 0) {
          const message: MulticastMessage = {
            tokens,
            notification: {
              title: payload.title,
              body: payload.body,
              imageUrl: payload.imageUrl || undefined,
            },
            data: {
              notificationId: notifId || '',
              eventType: payload.eventType || 'announcement',
              actionType: payload.actionType || 'deep_link',
              targetRoute: payload.targetRoute || '',
              externalUrl: payload.externalUrl || '',
            },
            android: {
              priority: 'high',
              notification: {
                sound: 'default',
                imageUrl: payload.imageUrl || undefined,
                channelId: 'prep404_high_importance_channel',
              },
            },
          };
          await getMessaging().sendEachForMulticast(message);
        }
      }
    } catch (pushErr) {
      console.warn('[FCM] Multicast push delivery error:', pushErr);
    }

    return { id: notifId, success: true };
  }

  /**
   * Broadcast notification to all learners, a university cohort, or a specific user
   */
  async broadcast(params: {
    audience: 'all' | 'university' | 'user';
    universityCode?: string;
    userId?: string;
    title: string;
    body: string;
    imageUrl?: string;
    eventType?: string;
    actionType?: 'app_open' | 'deep_link' | 'web_link';
    targetRoute?: string;
    externalUrl?: string;
  }): Promise<{ dispatchedCount: number; success: boolean }> {
    let targetUserIds: string[] = [];

    if (params.audience === 'user' && params.userId) {
      targetUserIds = [params.userId];
    } else if (params.audience === 'university' && params.universityCode) {
      const code = params.universityCode.toLowerCase();
      const usersRes = await this.db.query(
        `SELECT id FROM public.users WHERE LOWER(target_selections::text) LIKE $1 LIMIT 500;`,
        [`%${code}%`]
      );
      targetUserIds = usersRes.rows.map((r: { id: string }) => r.id);
      if (targetUserIds.length === 0) {
        const allRes = await this.db.query(
          `SELECT id FROM public.users LIMIT 200;`
        );
        targetUserIds = allRes.rows.map((r: { id: string }) => r.id);
      }
    } else {
      const allRes = await this.db.query(
        `SELECT id FROM public.users LIMIT 500;`
      );
      targetUserIds = allRes.rows.map((r: { id: string }) => r.id);
    }

    if (targetUserIds.length === 0) {
      return { dispatchedCount: 0, success: true };
    }

    // 1. Batch insert into user_inbox_notifications
    for (const uid of targetUserIds) {
      await this.db.query(
        `INSERT INTO public.user_inbox_notifications (
          user_id, title, body, image_url, event_type, action_type, target_route, external_url
        ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8);`,
        [
          uid,
          params.title,
          params.body,
          params.imageUrl || null,
          params.eventType || 'announcement',
          params.actionType || 'deep_link',
          params.targetRoute || null,
          params.externalUrl || null,
        ]
      );
    }

    // 2. Fetch all active device tokens for the target users
    try {
      if (initFirebase()) {
        const tokensRes = await this.db.query(
          `SELECT DISTINCT fcm_token FROM public.user_device_tokens
           WHERE user_id = ANY($1::uuid[]) AND is_active = true;`,
          [targetUserIds]
        );
        const tokens = tokensRes.rows
          .map((r: { fcm_token: string }) => r.fcm_token)
          .filter(Boolean);

        if (tokens.length > 0) {
          const message: MulticastMessage = {
            tokens,
            notification: {
              title: params.title,
              body: params.body,
              imageUrl: params.imageUrl || undefined,
            },
            data: {
              eventType: params.eventType || 'announcement',
              actionType: params.actionType || 'deep_link',
              targetRoute: params.targetRoute || '',
              externalUrl: params.externalUrl || '',
            },
            android: {
              priority: 'high',
              notification: {
                sound: 'default',
                imageUrl: params.imageUrl || undefined,
                channelId: 'prep404_high_importance_channel',
              },
            },
          };
          await getMessaging().sendEachForMulticast(message);
        }
      }
    } catch (pushErr) {
      console.warn('[FCM Broadcast] Push delivery error:', pushErr);
    }

    return { dispatchedCount: targetUserIds.length, success: true };
  }

  /**
   * Get recent notifications history and aggregated telemetry stats
   */
  async getNotificationHistory(limit = 30) {
    const res = await this.db.query(
      `SELECT 
        title, 
        body, 
        image_url AS "imageUrl", 
        event_type AS "eventType", 
        action_type AS "actionType", 
        target_route AS "targetRoute", 
        COUNT(*)::int AS "recipientCount", 
        COUNT(*) FILTER (WHERE is_read = true)::int AS "readCount",
        MIN(created_at) AS "createdAt"
       FROM public.user_inbox_notifications
       GROUP BY title, body, image_url, event_type, action_type, target_route
       ORDER BY MIN(created_at) DESC
       LIMIT $1;`,
      [limit]
    );

    const telemetryCounts = await this.db.query(
      `SELECT event, COUNT(*)::int as count FROM public.notification_events GROUP BY event;`
    );

    const activeDevicesRes = await this.db.query(
      `SELECT platform, COUNT(*)::int as count FROM public.user_device_tokens WHERE is_active = true GROUP BY platform;`
    );

    return {
      history: res.rows,
      telemetry: telemetryCounts.rows,
      activeDevices: activeDevicesRes.rows,
    };
  }
}
