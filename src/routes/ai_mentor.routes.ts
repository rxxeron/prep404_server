import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { resolveCandidateIdentity } from '../services/learner_identity.service';
import { AiFleetBalancerService } from '../services/ai_fleet_balancer.service';
import { sendInternalError } from '../services/http_errors';

const BANGLISH_MARKERS = new Set([
  'vai', 'vaiya', 'bhaiya', 'bhai', 'ami', 'tumi', 'amar', 'tomar', 'kemon', 'ki',
  'korte', 'korbo', 'korchi', 'bujhi', 'bujhtesi', 'bujhina', 'parchi', 'parbo',
  'porbo', 'porchi', 'ekhon', 'kintu', 'ar', 'na', 'toh', 'asha', 'hoy', 'hobe',
  'lagche', 'dorkar', 'shomoy', 'porikkha', 'chinta', 'kono', 'ektu', 'valo', 'bhalo',
  'kharap', 'thik', 'ache', 'ase', 'keno', 'kivabe', 'kibhabe', 'bolen', 'bolo',
  'dekho', 'shuru', 'shesh', 'onek', 'khub', 'ashole', 'mane', 'hocche', 'chilo',
]);

function detectLanguage(text: string): 'bn' | 'banglish' | 'en' {
  if (/[\u0980-\u09FF]/.test(text)) return 'bn';
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  let hits = 0;
  for (const t of tokens) {
    if (BANGLISH_MARKERS.has(t)) hits += 1;
  }
  if (hits >= 2 || (tokens.length <= 4 && hits >= 1)) return 'banglish';
  return 'en';
}

async function ensureUserRowExists(db: Pool, userId: string): Promise<void> {
  const existing = await db.query('SELECT id FROM public.users WHERE id = $1::uuid LIMIT 1', [userId]);
  if (existing.rows.length > 0) return;

  await db.query(
    `INSERT INTO public.users (id, full_name, email, is_onboarded, created_at, updated_at)
     SELECT au.id,
            COALESCE(NULLIF(au.raw_user_meta_data->>'full_name', ''), NULLIF(au.raw_user_meta_data->>'name', ''), split_part(COALESCE(au.email, 'Student'), '@', 1)),
            au.email,
            true,
            COALESCE(au.created_at, now()),
            now()
     FROM auth.users au
     WHERE au.id = $1::uuid
     ON CONFLICT (id) DO NOTHING`,
    [userId],
  );
}

function buildSeniorBrotherSystemPrompt(opts: {
  studentName: string;
  targetUniversities: string;
  hscBatch: string;
  medium: string;
  detectedLang: 'bn' | 'banglish' | 'en';
  contextType: string;
  contextPayload: any;
}): string {
  const langInstruction =
    opts.detectedLang === 'bn'
      ? 'The student just wrote in Bangla (বাংলা). Reply naturally in warm, conversational Bangla using friendly "তুমি" tone (like a caring university senior brother, NOT stiff robotic translation).'
      : opts.detectedLang === 'banglish'
        ? 'The student just wrote in Banglish (Bengali written in English letters). Reply in natural, authentic Bangladeshi Banglish (e.g., "Areh tension nish na bhai...", "Dekho ekta simple trick boli...") — warm, clear, and easy to read.'
        : 'The student just wrote in English. Reply in warm, natural, conversational English with a friendly Bangladeshi senior-brother ("Bhaiya") vibe.';

  let contextBlock = '';
  if (opts.contextPayload && typeof opts.contextPayload === 'object') {
    const qText = opts.contextPayload.questionText;
    const solution = opts.contextPayload.solution;
    const examTitle = opts.contextPayload.examTitle;
    if (qText) {
      contextBlock = `\nATTACHED QUESTION CONTEXT:\n- Exam: ${examTitle || 'Practice Question'}\n- Question: ${qText}\n${solution ? `- Official Solution: ${solution}\n` : ''}Explain this step-by-step clearly without contradicting the official solution.`;
    }
  }

  return `You are "Prep404 Bhaiya", a warm, supportive, street-smart university senior brother mentoring Bangladeshi admission test students (NSU, BRACU, UIU, AIUB, EWU, IUB, AUST, UAP, BUET, DU, Medical).

STUDENT PROFILE:
- Name: ${opts.studentName}
- Target Universities: ${opts.targetUniversities || 'Bangladeshi University Admission'}
- Batch: ${opts.hscBatch || 'Admission Candidate'}
- Medium: ${opts.medium || 'HSC'}

LANGUAGE RULE (CRITICAL):
- Always match the exact language/style the student is using right now.
- ${langInstruction}
- Keep formulas/technical terms clear and readable on a phone screen.

TONE & PERSONALITY:
- Talk like an experienced elder brother who actually cracked these admission tests: empathetic when they feel stressed, practical with exam shortcuts and time management, honest and encouraging.
- Never sound like a generic corporate chatbot. Avoid long walls of text; use short paragraphs or crisp bullet points.
- Never fabricate unannounced university admission dates or fake cut-off marks — if an exam date isn't confirmed, tell them honestly to check the official university portal or Prep404's live schedule.
- Note: Private universities in Bangladesh (NSU, BRACU, UIU, AIUB, EWU, IUB, AUST, UAP) have NO negative marking (0.00), so encourage smart educated guessing rather than leaving blanks.${contextBlock}`;
}

const createSessionSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  contextType: z.enum(['general', 'question_help', 'exam_review', 'study_plan']).optional(),
  contextRefId: z.string().trim().max(128).optional(),
  contextPayload: z.record(z.any()).optional(),
});

const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(3000),
});

const feedbackSchema = z.object({
  feedback: z.enum(['up', 'down']),
});

export const aiMentorRoutes: FastifyPluginAsync<{ db: Pool }> = async (
  app: FastifyInstance,
  opts: { db: Pool },
) => {
  const { db } = opts;
  const balancer = AiFleetBalancerService.getInstance(db);

  // Kick off background fleet discovery on server boot
  balancer.initialize().catch(() => undefined);

  // =========================================================================
  // 1. LIVE LAB PC FLEET STATUS
  // =========================================================================
  app.get('/api/v1/ai/fleet/status', async (_req: FastifyRequest, reply: FastifyReply) => {
    await balancer.initialize();
    return reply.send({
      success: true,
      fleet: balancer.getStatusSnapshot(),
    });
  });

  // =========================================================================
  // 2. LIST STUDENT'S CHAT SESSIONS
  // =========================================================================
  app.get('/api/v1/ai/chat/sessions', async (req: FastifyRequest, reply: FastifyReply) => {
    const identity = await resolveCandidateIdentity(req);
    if (identity.statusCode) return reply.status(identity.statusCode).send({ error: identity.error });
    if (!identity.userId) return reply.status(401).send({ error: 'Sign in to chat with Prep404 Bhaiya.' });

    try {
      const res = await db.query(
        `SELECT id, title, context_type AS "contextType", context_ref_id AS "contextRefId",
                detected_language AS "detectedLanguage", message_count AS "messageCount",
                last_message_at AS "lastMessageAt", created_at AS "createdAt"
         FROM public.ai_chat_sessions
         WHERE user_id = $1::uuid AND archived_at IS NULL
         ORDER BY last_message_at DESC
         LIMIT 40`,
        [identity.userId],
      );
      return reply.send({ success: true, sessions: res.rows });
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });

  // =========================================================================
  // 3. CREATE A NEW CHAT SESSION
  // =========================================================================
  app.post('/api/v1/ai/chat/sessions', async (req: FastifyRequest, reply: FastifyReply) => {
    const identity = await resolveCandidateIdentity(req);
    if (identity.statusCode) return reply.status(identity.statusCode).send({ error: identity.error });
    if (!identity.userId) return reply.status(401).send({ error: 'Sign in to start a conversation.' });

    const parsed = createSessionSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid session payload', details: parsed.error.flatten() });
    }

    try {
      await ensureUserRowExists(db, identity.userId);
      const { title = 'Chat with Bhaiya', contextType = 'general', contextRefId, contextPayload } = parsed.data;
      const ins = await db.query(
        `INSERT INTO public.ai_chat_sessions (user_id, title, context_type, context_ref_id, context_payload)
         VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
         RETURNING id, title, context_type AS "contextType", context_ref_id AS "contextRefId",
                   detected_language AS "detectedLanguage", message_count AS "messageCount",
                   last_message_at AS "lastMessageAt", created_at AS "createdAt"`,
        [
          identity.userId,
          title,
          contextType,
          contextRefId || null,
          contextPayload ? JSON.stringify(contextPayload) : null,
        ],
      );
      return reply.status(201).send({ success: true, session: ins.rows[0] });
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });

  // =========================================================================
  // 4. GET MESSAGES FOR A SESSION
  // =========================================================================
  app.get('/api/v1/ai/chat/sessions/:id/messages', async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const identity = await resolveCandidateIdentity(req);
    if (identity.statusCode) return reply.status(identity.statusCode).send({ error: identity.error });
    if (!identity.userId) return reply.status(401).send({ error: 'Sign in to view conversation.' });

    try {
      const own = await db.query(
        `SELECT id, title, context_type AS "contextType", detected_language AS "detectedLanguage"
         FROM public.ai_chat_sessions
         WHERE id = $1::uuid AND user_id = $2::uuid AND archived_at IS NULL
         LIMIT 1`,
        [req.params.id, identity.userId],
      );
      if (own.rows.length === 0) {
        return reply.status(404).send({ error: 'Conversation not found.' });
      }

      const msgs = await db.query(
        `SELECT id, role, content, model_used AS "modelUsed", node_name AS "nodeName",
                latency_ms AS "latencyMs", feedback, created_at AS "createdAt"
         FROM public.ai_chat_messages
         WHERE session_id = $1::uuid AND user_id = $2::uuid
         ORDER BY created_at ASC
         LIMIT 100`,
        [req.params.id, identity.userId],
      );

      return reply.send({
        success: true,
        session: own.rows[0],
        messages: msgs.rows,
      });
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });

  // =========================================================================
  // 5. SEND MESSAGE + STREAM REPLY FROM LEAST-BUSY LAB PC (SSE)
  // =========================================================================
  app.post('/api/v1/ai/chat/sessions/:id/messages', async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const identity = await resolveCandidateIdentity(req);
    if (identity.statusCode) return reply.status(identity.statusCode).send({ error: identity.error });
    if (!identity.userId) return reply.status(401).send({ error: 'Sign in to send a message.' });

    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Message cannot be empty.' });
    }

    const userText = parsed.data.content;
    const detectedLang = detectLanguage(userText);
    const sessionId = req.params.id;

    try {
      const sessionRes = await db.query(
        `SELECT id, title, context_type, context_payload, message_count
         FROM public.ai_chat_sessions
         WHERE id = $1::uuid AND user_id = $2::uuid AND archived_at IS NULL
         LIMIT 1`,
        [sessionId, identity.userId],
      );
      if (sessionRes.rows.length === 0) {
        return reply.status(404).send({ error: 'Conversation not found.' });
      }
      const session = sessionRes.rows[0];

      // Fetch student profile + recent 12 messages for sliding context window
      const [userRes, historyRes] = await Promise.all([
        db.query(
          `SELECT full_name, target_universities, target_unit, hsc_batch, medium
           FROM public.users WHERE id = $1::uuid LIMIT 1`,
          [identity.userId],
        ),
        db.query(
          `SELECT role, content
           FROM public.ai_chat_messages
           WHERE session_id = $1::uuid
           ORDER BY created_at DESC
           LIMIT 12`,
          [sessionId],
        ),
      ]);

      const userRow = userRes.rows[0] || {};
      const studentName = String(userRow.full_name || 'Student').split(' ')[0];
      const rawTargets = userRow.target_universities;
      const targetUnisText = Array.isArray(rawTargets)
        ? rawTargets.join(', ')
        : (rawTargets && typeof rawTargets === 'object'
            ? Object.keys(rawTargets).join(', ')
            : String(rawTargets || userRow.target_unit || ''));
      const historyMessages = historyRes.rows.reverse().map((m: any) => ({
        role: m.role as 'user' | 'assistant',
        content: String(m.content || ''),
      }));

      // Save user message immediately in DB
      const userMsgIns = await db.query(
        `INSERT INTO public.ai_chat_messages (session_id, user_id, role, content)
         VALUES ($1::uuid, $2::uuid, 'user', $3)
         RETURNING id, created_at`,
        [sessionId, identity.userId, userText],
      );

      // Auto-title session on first user message
      const autoTitle =
        Number(session.message_count) === 0 && session.title === 'Chat with Bhaiya'
          ? userText.slice(0, 56) + (userText.length > 56 ? '…' : '')
          : session.title;

      await db.query(
        `UPDATE public.ai_chat_sessions
         SET title = $2, detected_language = $3, message_count = message_count + 1, last_message_at = now()
         WHERE id = $1::uuid`,
        [sessionId, autoTitle, detectedLang],
      );

      const systemPrompt = buildSeniorBrotherSystemPrompt({
        studentName,
        targetUniversities: targetUnisText,
        hscBatch: String(userRow.hsc_batch || ''),
        medium: String(userRow.medium || ''),
        detectedLang,
        contextType: String(session.context_type || 'general'),
        contextPayload: session.context_payload,
      });

      const ollamaMessages = [
        { role: 'system', content: systemPrompt },
        ...historyMessages,
        { role: 'user', content: userText },
      ];

      // Acquire a healthy Lab PC with up to 2 automatic failover attempts
      const triedNodes = new Set<string>();
      let upstreamResponse: Response | null = null;
      let activeNodeName = '';
      let activeModel = '';
      const startedAt = Date.now();

      for (let attempt = 0; attempt < 3; attempt++) {
        const node = await balancer.acquireNode(triedNodes);
        if (!node) break;
        triedNodes.add(node.name);
        activeNodeName = node.name;
        activeModel = node.resolvedModel;

        const controller = new AbortController();
        const connectTimeout = setTimeout(() => controller.abort(), 65_000);
        try {
          const res = await fetch(`${node.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: node.resolvedModel,
              messages: ollamaMessages,
              stream: true,
              think: false,
              keep_alive: '30m',
              options: {
                temperature: 0.65,
                num_predict: 900,
              },
            }),
            signal: controller.signal,
          });
          clearTimeout(connectTimeout);

          if (res.ok && res.body) {
            upstreamResponse = res;
            break;
          }
          balancer.releaseNode(node.name, { ok: false });
        } catch (_) {
          clearTimeout(connectTimeout);
          balancer.releaseNode(node.name, { ok: false });
        }
      }

      if (!upstreamResponse || !upstreamResponse.body) {
        return reply.status(503).send({
          error: 'All Lab AI servers are currently offline or busy. Please try again in a moment.',
        });
      }

      // Stream tokens to Flutter via SSE
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const sendEvent = (payload: Record<string, unknown>) => {
        if (!reply.raw.destroyed) {
          reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      };

      sendEvent({
        type: 'meta',
        userMessageId: userMsgIns.rows[0].id,
        sessionTitle: autoTitle,
        node: activeNodeName,
        model: activeModel,
        detectedLanguage: detectedLang,
      });

      const reader = upstreamResponse.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let fullReply = '';
      let streamSucceeded = true;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const chunk = JSON.parse(trimmed);
              const token = chunk?.message?.content;
              if (typeof token === 'string' && token.length > 0) {
                fullReply += token;
                sendEvent({ type: 'token', token });
              }
            } catch (_) {
              // Ignore partial JSON lines
            }
          }
        }
      } catch (err) {
        streamSucceeded = false;
        req.log.warn({ err, node: activeNodeName }, 'Ollama stream interrupted');
      } finally {
        const latencyMs = Date.now() - startedAt;
        balancer.releaseNode(activeNodeName, { ok: streamSucceeded && fullReply.length > 0, latencyMs });

        // Persist completed assistant message in DB
        let assistantMessageId: string | null = null;
        if (fullReply.trim().length > 0) {
          try {
            const asstIns = await db.query(
              `INSERT INTO public.ai_chat_messages (
                 session_id, user_id, role, content, model_used, node_name, latency_ms
               )
               VALUES ($1::uuid, $2::uuid, 'assistant', $3, $4, $5, $6)
               RETURNING id`,
              [sessionId, identity.userId, fullReply.trim(), activeModel, activeNodeName, latencyMs],
            );
            assistantMessageId = asstIns.rows[0]?.id || null;
            await db.query(
              `UPDATE public.ai_chat_sessions
               SET message_count = message_count + 1, last_message_at = now()
               WHERE id = $1::uuid`,
              [sessionId],
            );
          } catch (dbErr) {
            req.log.error({ dbErr }, 'Failed to save assistant message');
          }
        }

        sendEvent({
          type: 'done',
          assistantMessageId,
          latencyMs,
          node: activeNodeName,
          model: activeModel,
        });
        if (!reply.raw.destroyed) {
          reply.raw.end();
        }
      }
      return;
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });

  // =========================================================================
  // 6. MESSAGE FEEDBACK (THUMBS UP / DOWN)
  // =========================================================================
  app.post('/api/v1/ai/chat/messages/:id/feedback', async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const identity = await resolveCandidateIdentity(req);
    if (identity.statusCode) return reply.status(identity.statusCode).send({ error: identity.error });
    if (!identity.userId) return reply.status(401).send({ error: 'Sign in required.' });

    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Feedback must be "up" or "down".' });

    try {
      const upd = await db.query(
        `UPDATE public.ai_chat_messages
         SET feedback = $1
         WHERE id = $2::uuid AND user_id = $3::uuid
         RETURNING id, feedback`,
        [parsed.data.feedback, req.params.id, identity.userId],
      );
      if (upd.rows.length === 0) return reply.status(404).send({ error: 'Message not found.' });
      return reply.send({ success: true, message: upd.rows[0] });
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });

  // =========================================================================
  // 7. ARCHIVE A CHAT SESSION
  // =========================================================================
  app.delete('/api/v1/ai/chat/sessions/:id', async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const identity = await resolveCandidateIdentity(req);
    if (identity.statusCode) return reply.status(identity.statusCode).send({ error: identity.error });
    if (!identity.userId) return reply.status(401).send({ error: 'Sign in required.' });

    try {
      await db.query(
        `UPDATE public.ai_chat_sessions
         SET archived_at = now()
         WHERE id = $1::uuid AND user_id = $2::uuid`,
        [req.params.id, identity.userId],
      );
      return reply.send({ success: true });
    } catch (err: any) {
      return sendInternalError(reply, err);
    }
  });
};
