import { FastifyReply } from 'fastify';

export const INTERNAL_ERROR_MESSAGE = 'Something went wrong on our side. Please try again.';

/**
 * Log an unexpected failure in full and answer with a generic message plus the
 * request ID. Raw database errors (table, column and constraint names) never
 * reach the client.
 */
export function sendInternalError(reply: FastifyReply, err: unknown) {
  reply.log.error({ err }, 'Unhandled route error');
  return reply.status(500).send({ error: INTERNAL_ERROR_MESSAGE, requestId: reply.request.id });
}
