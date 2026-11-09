import { WebSocket } from 'ws';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { verifySupabaseAccessToken } from '../services/supabase_auth.service';
import { RedisService } from '../redis/redis.service';

export interface DuelQuestion {
  id: string;
  section: string;
  text: string;
  hasMath: boolean;
  options: Array<{ id: string; text: string }>;
  correctOption: string;
  explanation: string;
}

export interface PlayerSession {
  socket: WebSocket;
  userId: string;
  publicId: string;
  name: string;
  college: string;
  score: number;
  hasAnswered: boolean;
  selectedOption?: string;
  roundPoints: number;
}

export interface PrivateRoomParticipant {
  session: PlayerSession;
  isHost: boolean;
  isReady: boolean;
}

export interface PrivateRoom {
  roomCode: string;
  university: string;
  program: string;
  maxPlayers: number; // 2 to 8
  players: PrivateRoomParticipant[];
  timeRemainingSeconds: number; // 90 seconds
  timer?: NodeJS.Timeout;
}

export interface DuelRoom {
  roomId: string;
  university: string;
  program: string;
  player1: PlayerSession;
  player2: PlayerSession;
  players: PlayerSession[];
  questions: DuelQuestion[];
  currentRoundIndex: number;
  roundTimer?: NodeJS.Timeout;
  timeRemainingSeconds: number;
  isActive?: boolean;
}

/** Per-socket message budget: enough for real play, far below a flood. */
export const BATTLE_MESSAGE_LIMIT = 30;
export const BATTLE_MESSAGE_WINDOW_MS = 10_000;

export class RealBattleGateway {
  private db: Pool;
  private redis?: RedisService;
  /** One live battle connection per learner; a new sign-in replaces the old one. */
  private userSockets: Map<string, WebSocket> = new Map();
  private waitingQueues: Map<string, PlayerSession[]> = new Map();
  private privateRooms: Map<string, PrivateRoom> = new Map();
  private activeRooms: Map<string, DuelRoom> = new Map();
  private socketRooms: Map<WebSocket, string> = new Map();

  constructor(db: Pool, redis?: RedisService) {
    this.db = db;
    this.redis = redis;
  }

  public handleConnection(socket: WebSocket): void {
    let currentSession: PlayerSession | null = null;
    let currentRoomId: string | null = null;
    let authenticatedUserId: string | null = null;
    let publicPlayerId: string | null = null;

    const authTimeout = setTimeout(() => {
      if (!authenticatedUserId && socket.readyState === WebSocket.OPEN) {
        this.safeSend(socket, { type: 'AUTH_ERROR', message: 'Authentication timeout.' });
        socket.close(4001, 'Authentication timeout');
      }
    }, 10000);

    let windowStartedAt = Date.now();
    let messagesInWindow = 0;

    socket.on('message', async (raw: string | Buffer) => {
      const now = Date.now();
      if (now - windowStartedAt > BATTLE_MESSAGE_WINDOW_MS) {
        windowStartedAt = now;
        messagesInWindow = 0;
      }
      messagesInWindow++;
      if (messagesInWindow > BATTLE_MESSAGE_LIMIT) {
        this.safeSend(socket, { type: 'RATE_LIMITED', message: 'Too many battle messages. Reconnect to keep playing.' });
        socket.close(4008, 'Too many messages');
        return;
      }
      try {
        const payload = JSON.parse(raw.toString());
        const { type } = payload;

        if (type === 'AUTHENTICATE') {
          if (authenticatedUserId) return;
          if (typeof payload.accessToken !== 'string' || !payload.accessToken.trim()) {
            clearTimeout(authTimeout);
            this.safeSend(socket, { type: 'AUTH_ERROR', message: 'Sign in before joining a battle.' });
            socket.close(4001, 'Authentication required');
            return;
          }
          try {
            authenticatedUserId = (await verifySupabaseAccessToken(payload.accessToken)).id;
            clearTimeout(authTimeout);
            const previousSocket = this.userSockets.get(authenticatedUserId);
            if (previousSocket && previousSocket !== socket && previousSocket.readyState === WebSocket.OPEN) {
              this.safeSend(previousSocket, { type: 'SESSION_REPLACED', message: 'You joined battles from another connection.' });
              previousSocket.close(4009, 'Replaced by a newer connection');
            }
            this.userSockets.set(authenticatedUserId, socket);
            publicPlayerId = randomUUID();
            this.safeSend(socket, { type: 'AUTHENTICATED', publicId: publicPlayerId });
          } catch {
            clearTimeout(authTimeout);
            this.safeSend(socket, { type: 'AUTH_ERROR', message: 'Your sign-in could not be verified.' });
            socket.close(4001, 'Authentication failed');
          }
          return;
        }

        if (!authenticatedUserId) {
          this.safeSend(socket, { type: 'AUTH_ERROR', message: 'Sign in before joining a battle.' });
          socket.close(4001, 'Authentication required');
          return;
        }

        switch (type) {
          case 'JOIN_QUEUE': {
            const { university = 'BRACU', program = 'eng' } = payload;
            currentSession = await this.createPlayerSession(socket, authenticatedUserId, publicPlayerId!);

            const queueKey = `${university.toUpperCase()}:${program.toLowerCase()}`;
            if (!this.waitingQueues.has(queueKey)) {
              this.waitingQueues.set(queueKey, []);
            }

            const queue = this.waitingQueues.get(queueKey)!;
            const activeQueue = queue.filter(p => p.socket.readyState === WebSocket.OPEN && p.userId !== authenticatedUserId);
            this.waitingQueues.set(queueKey, activeQueue);

            if (activeQueue.length > 0) {
              const opponent = activeQueue.shift()!;
              const roomId = randomUUID();
              currentRoomId = roomId;

              await this.startDuelMatch(roomId, university, program, currentSession, opponent);
            } else {
              activeQueue.push(currentSession);
              this.safeSend(socket, {
                type: 'QUEUE_WAITING',
                university: university.toUpperCase(),
                program,
                message: `Searching for live candidate targeting ${university.toUpperCase()} (${program})...`,
              });
            }
            break;
          }

          case 'CREATE_ROOM': {
            const { university = 'BRACU', program = 'eng', maxPlayers = 2 } = payload;
            const uCode = university.toUpperCase();
            const roomCode = `${uCode}-${Math.floor(100 + Math.random() * 900)}`;
            const validCapacity = Math.max(2, Math.min(8, Number(maxPlayers) || 2));

            currentSession = await this.createPlayerSession(socket, authenticatedUserId, publicPlayerId!);

            const newRoom: PrivateRoom = {
              roomCode,
              university: uCode,
              program,
              maxPlayers: validCapacity,
              players: [
                { session: currentSession, isHost: true, isReady: true },
              ],
              timeRemainingSeconds: 90,
            };

            // 1 Minute 30 Seconds assembly countdown
            newRoom.timer = setInterval(() => {
              newRoom.timeRemainingSeconds--;
              if (newRoom.timeRemainingSeconds <= 0) {
                if (newRoom.timer) clearInterval(newRoom.timer);
                this.broadcastToPrivateRoom(newRoom, {
                  type: 'ROOM_TIMEOUT',
                  message: 'Room assembly timed out (1m 30s limit reached).',
                });
                for (const p of newRoom.players) {
                  this.socketRooms.delete(p.session.socket);
                }
                this.privateRooms.delete(roomCode);
              } else {
                this.broadcastToPrivateRoom(newRoom, {
                  type: 'ROOM_TICK',
                  timeRemaining: newRoom.timeRemainingSeconds,
                });
              }
            }, 1000);

            this.privateRooms.set(roomCode, newRoom);
            this.socketRooms.set(socket, roomCode);

            this.safeSend(socket, {
              type: 'ROOM_CREATED',
              roomCode,
              university: uCode,
              program,
              maxPlayers: validCapacity,
              timeRemainingSeconds: 90,
              isHost: true,
              players: this.formatPrivateRoomPlayers(newRoom),
              message: `Room created for ${validCapacity} players! Share code ${roomCode} with friends.`,
            });
            break;
          }

          case 'JOIN_ROOM': {
            const { roomCode } = payload;
            const code = (roomCode || '').toUpperCase().trim();
            const room = this.privateRooms.get(code);

            if (!room) {
              this.safeSend(socket, {
                type: 'ROOM_ERROR',
                message: `Duel room "${code}" not found or has expired.`,
              });
              return;
            }

            if (room.players.length >= room.maxPlayers) {
              this.safeSend(socket, {
                type: 'ROOM_ERROR',
                message: `Room "${code}" is full (${room.maxPlayers}/${room.maxPlayers} players).`,
              });
              return;
            }

            const alreadyJoined = room.players.some(p => p.session.userId === authenticatedUserId);
            if (alreadyJoined) {
              this.safeSend(socket, {
                type: 'ROOM_ERROR',
                message: 'You have already joined this room.',
              });
              return;
            }

            currentSession = await this.createPlayerSession(socket, authenticatedUserId, publicPlayerId!);
            room.players.push({
              session: currentSession,
              isHost: false,
              isReady: false,
            });
            this.socketRooms.set(socket, code);

            // Notify joiner
            this.safeSend(socket, {
              type: 'ROOM_JOINED',
              roomCode: code,
              university: room.university,
              program: room.program,
              maxPlayers: room.maxPlayers,
              timeRemainingSeconds: room.timeRemainingSeconds,
              isHost: false,
              players: this.formatPrivateRoomPlayers(room),
            });

            const canHostStart = room.players.length >= 2 && room.players.filter(p => !p.isHost).every(p => p.isReady);

            // Broadcast update to all players in the room
            this.broadcastToPrivateRoom(room, {
              type: 'ROOM_PLAYERS_UPDATE',
              roomCode: code,
              maxPlayers: room.maxPlayers,
              timeRemainingSeconds: room.timeRemainingSeconds,
              players: this.formatPrivateRoomPlayers(room),
              canHostStart,
            });

            // Auto-start if all slots filled AND all joined clients are ready!
            if (room.players.length === room.maxPlayers && room.players.filter(p => !p.isHost).every(p => p.isReady)) {
              void this.launchPrivateRoomBattle(code);
            }
            break;
          }

          case 'TOGGLE_READY': {
            const { roomCode, isReady } = payload;
            const code = (roomCode || '').toUpperCase().trim();
            const room = this.privateRooms.get(code);
            if (!room) return;

            const participant = room.players.find(p => p.session.userId === authenticatedUserId);
            if (participant && !participant.isHost) {
              participant.isReady = !!isReady;
              const canHostStart = room.players.length >= 2 && room.players.filter(p => !p.isHost).every(p => p.isReady);

              this.broadcastToPrivateRoom(room, {
                type: 'ROOM_PLAYERS_UPDATE',
                roomCode: code,
                maxPlayers: room.maxPlayers,
                timeRemainingSeconds: room.timeRemainingSeconds,
                players: this.formatPrivateRoomPlayers(room),
                canHostStart,
              });

              // Auto-start if all slots filled AND all clients are ready!
              if (room.players.length === room.maxPlayers && room.players.filter(p => !p.isHost).every(p => p.isReady)) {
                void this.launchPrivateRoomBattle(code);
              }
            }
            break;
          }

          case 'HOST_START_ROOM': {
            const { roomCode } = payload;
            const code = (roomCode || '').toUpperCase().trim();
            const room = this.privateRooms.get(code);
            if (!room) return;

            const host = room.players.find(p => p.isHost);
            if (!host || host.session.userId !== authenticatedUserId) {
              this.safeSend(socket, { type: 'ROOM_ERROR', message: 'Only the room host can start the battle.' });
              return;
            }

            if (room.players.length < 2) {
              this.safeSend(socket, { type: 'ROOM_ERROR', message: 'At least 2 players are required to start.' });
              return;
            }

            const clientsReady = room.players.filter(p => !p.isHost).every(p => p.isReady);
            if (!clientsReady) {
              this.safeSend(socket, { type: 'ROOM_ERROR', message: 'All joined candidates must mark themselves Ready before starting.' });
              return;
            }

            void this.launchPrivateRoomBattle(code);
            break;
          }

          case 'LEAVE_ROOM': {
            const { roomCode } = payload;
            const code = (roomCode || '').toUpperCase().trim();
            this.handleLeavePrivateRoom(code, authenticatedUserId);
            break;
          }

          case 'START_BOT_MATCH': {
            const { university = 'BRACU', program = 'eng' } = payload;
            currentSession = await this.createPlayerSession(socket, authenticatedUserId, publicPlayerId!);

            const botSession: PlayerSession = {
              socket: null as any,
              userId: 'bot_prep404_engine',
              publicId: 'bot_prep404_engine',
              name: 'Prep404 AI Engine',
              college: 'Automated Admission Bot',
              score: 0,
              hasAnswered: false,
              roundPoints: 0,
            };

            const roomId = `room_bot_${Date.now()}`;
            currentRoomId = roomId;
            await this.startDuelMatch(roomId, university, program, currentSession, botSession);
            break;
          }

          case 'LEAVE_QUEUE': {
            this.removeFromQueues(currentSession);
            break;
          }

          case 'SUBMIT_ANSWER': {
            const { roomId, optionId } = payload;
            const room = this.activeRooms.get(roomId);
            if (!room || !currentSession) return;

            const player = room.players.find(p => p.userId === currentSession!.userId);
            if (!player || player.hasAnswered) return;
            if (room.timeRemainingSeconds <= 0 || !room.roundTimer) return;

            const currentQ = room.questions[room.currentRoundIndex];
            const isCorrect = optionId === currentQ.correctOption;
            // Anti-Cheat: Strictly enforce server-authoritative round timer
            const serverRemaining = Math.max(0, Math.min(15, room.timeRemainingSeconds));
            const points = isCorrect ? (50 + serverRemaining * 5) : 0;

            player.hasAnswered = true;
            player.selectedOption = optionId;
            player.roundPoints = points;
            player.score += points;

            // Notify opponents that player answered
            for (const pl of room.players) {
              if (pl !== player) {
                this.safeSend(pl.socket, {
                  type: 'OPPONENT_ANSWERED',
                  playerId: player.publicId,
                  playerName: player.name,
                  timeRemaining: room.timeRemainingSeconds,
                });
              }
            }

            // If ALL players have answered, conclude round immediately
            if (room.players.every(p => p.hasAnswered)) {
              if (room.roundTimer) {
                clearInterval(room.roundTimer);
                room.roundTimer = undefined;
              }
              this.concludeRound(room);
            }
            break;
          }
        }
      } catch (err: any) {
        console.error('[RealBattleGateway] Error processing socket message:', err.message);
      }
    });

    socket.on('close', () => {
      clearTimeout(authTimeout);
      if (authenticatedUserId && this.userSockets.get(authenticatedUserId) === socket) {
        this.userSockets.delete(authenticatedUserId);
      }
      this.removeFromQueues(currentSession);

      // Handle private room departure
      for (const [code] of this.privateRooms.entries()) {
        this.handleLeavePrivateRoom(code, authenticatedUserId);
      }

      const roomId = this.socketRooms.get(socket) || currentRoomId;
      if (roomId && currentSession) {
        const room = this.activeRooms.get(roomId);
        if (room) {
          if (room.players.length <= 2) {
            const opponent = room.players.find(p => p.userId !== currentSession!.userId) || room.player1;
            if (room.players.every(p => !p.userId.startsWith('bot_'))) {
              void this.persistBattleResult(room, opponent.userId, 'forfeit');
            }
            this.safeSend(opponent.socket, {
              type: 'OPPONENT_FORFEIT',
              message: 'Opponent disconnected. Victory awarded!',
            });
            if (room.roundTimer) clearInterval(room.roundTimer);
            this.activeRooms.delete(roomId);
            this.socketRooms.delete(socket);
            if (opponent.socket) this.socketRooms.delete(opponent.socket);
          } else {
            // Multiplayer room: remove leaving player
            room.players = room.players.filter(p => p.userId !== currentSession!.userId);
            this.socketRooms.delete(socket);
            if (room.players.length < 2) {
              const survivor = room.players[0];
              if (survivor) {
                this.safeSend(survivor.socket, {
                  type: 'OPPONENT_FORFEIT',
                  message: 'Other contestants disconnected. Victory awarded!',
                });
                if (survivor.socket) this.socketRooms.delete(survivor.socket);
              }
              if (room.roundTimer) clearInterval(room.roundTimer);
              this.activeRooms.delete(roomId);
            }
          }
        }
      }
    });
  }

  private handleLeavePrivateRoom(roomCode: string, userId: string | null): void {
    const room = this.privateRooms.get(roomCode);
    if (!room || !userId) return;

    const leavingParticipant = room.players.find(p => p.session.userId === userId);
    if (!leavingParticipant) return;

    if (leavingParticipant.isHost) {
      if (room.timer) clearInterval(room.timer);
      this.broadcastToPrivateRoom(room, {
        type: 'ROOM_CLOSED',
        message: 'Room host has left. Room has been closed.',
      });
      for (const p of room.players) {
        this.socketRooms.delete(p.session.socket);
      }
      this.privateRooms.delete(roomCode);
    } else {
      this.socketRooms.delete(leavingParticipant.session.socket);
      room.players = room.players.filter(p => p.session.userId !== userId);
      const canHostStart = room.players.length >= 2 && room.players.filter(p => !p.isHost).every(p => p.isReady);
      this.broadcastToPrivateRoom(room, {
        type: 'ROOM_PLAYERS_UPDATE',
        roomCode,
        maxPlayers: room.maxPlayers,
        timeRemainingSeconds: room.timeRemainingSeconds,
        players: this.formatPrivateRoomPlayers(room),
        canHostStart,
      });
    }
  }

  private formatPrivateRoomPlayers(room: PrivateRoom) {
    return room.players.map(p => ({
      id: p.session.publicId,
      name: p.session.name,
      college: p.session.college,
      isHost: p.isHost,
      isReady: p.isReady,
    }));
  }

  private broadcastToPrivateRoom(room: PrivateRoom, data: any): void {
    for (const p of room.players) {
      this.safeSend(p.session.socket, data);
    }
  }

  private async launchPrivateRoomBattle(code: string): Promise<void> {
    const room = this.privateRooms.get(code);
    if (!room) return;

    if (room.timer) clearInterval(room.timer);
    this.privateRooms.delete(code);

    const roomId = randomUUID();
    const playerSessions = room.players.map(p => p.session);
    await this.startMultiplayerMatch(roomId, room.university, room.program, playerSessions);
  }

  private removeFromQueues(session: PlayerSession | null): void {
    if (!session) return;
    for (const [key, queue] of this.waitingQueues.entries()) {
      this.waitingQueues.set(key, queue.filter(p => p.socket !== session.socket));
    }
  }

  private async createPlayerSession(socket: WebSocket, userId: string, publicId: string): Promise<PlayerSession> {
    let name = 'Learner';
    let college = 'Learner';
    try {
      const profile = await this.db.query(`SELECT
          COALESCE(NULLIF(trim(full_name), ''), 'Learner') AS name,
          COALESCE(NULLIF(trim(institution_name), ''), 'Learner') AS college
        FROM public.users WHERE id=$1::uuid LIMIT 1`, [userId]);
      if (profile.rowCount) {
        name = profile.rows[0].name;
        college = profile.rows[0].college;
      }
    } catch (err) {
      console.error('[RealBattleGateway] Learner profile lookup failed:', (err as Error).message);
    }
    return { socket, userId, publicId, name, college, score: 0, hasAnswered: false, roundPoints: 0 };
  }

  private async startDuelMatch(
    roomId: string,
    university: string,
    program: string,
    player1: PlayerSession,
    player2: PlayerSession
  ): Promise<void> {
    await this.startMultiplayerMatch(roomId, university, program, [player1, player2]);
  }

  private async startMultiplayerMatch(
    roomId: string,
    university: string,
    program: string,
    players: PlayerSession[]
  ): Promise<void> {
    // 100% Database-Driven: Fetch 2-3 questions per section from PostgreSQL
    const questions = await this.fetchMultiSectionQuestionsFromDb(university, program, 3);

    const room: DuelRoom = {
      roomId,
      university,
      program,
      player1: players[0],
      player2: players[1] || players[0],
      players,
      questions,
      currentRoundIndex: -1,
      timeRemainingSeconds: 15,
      isActive: true,
    };

    if (players.every(p => !p.userId.startsWith('bot_'))) {
      try {
        const roomCode = `B-${roomId.slice(0, 8).toUpperCase()}`;
        await this.db.query(`INSERT INTO public.battle_rooms
            (id, room_code, battle_mode, track, status, player_ids, round_scores)
          VALUES ($1::uuid,$2,$3,$4,'in_progress',$5::uuid[],$6::jsonb)
          ON CONFLICT (id) DO NOTHING`, [
          roomId,
          roomCode,
          players.length === 2 ? '1v1' : `room_${players.length}p`,
          `${university}/${program}`,
          players.map(p => p.userId),
          JSON.stringify({}),
        ]);
      } catch (err) {
        console.error('[RealBattleGateway] Battle record could not be persisted:', (err as Error).message);
      }
    }

    this.activeRooms.set(roomId, room);
    for (const p of players) {
      if (p.socket) this.socketRooms.set(p.socket, roomId);
    }

    const sections = [...new Set(questions.map(q => q.section))];

    for (const p of players) {
      const others = players.filter(o => o !== p).map(o => ({
        id: o.publicId,
        name: o.name,
        college: o.college,
        score: o.score,
      }));

      this.safeSend(p.socket, {
        type: 'MATCH_FOUND',
        roomId,
        university,
        program,
        opponent: others[0] || { id: 'bot', name: 'Opponent', college: 'Track' },
        opponents: others,
        totalPlayers: players.length,
        totalRounds: questions.length,
        sections,
      });
    }

    if (this.redis) {
      void this.redis.publishBattleEvent(roomId, 'MATCH_FOUND', {
        roomId,
        university,
        program,
        totalPlayers: players.length,
      });
    }

    // 2.8s countdown before round 1 starts
    setTimeout(() => {
      this.startNextRound(room);
    }, 2800);
  }

  private startNextRound(room: DuelRoom): void {
    room.currentRoundIndex++;
    if (room.currentRoundIndex >= room.questions.length) {
      this.finishDuel(room);
      return;
    }

    const currentQ = room.questions[room.currentRoundIndex];
    for (const p of room.players) {
      p.hasAnswered = false;
      p.selectedOption = undefined;
      p.roundPoints = 0;
    }

    room.timeRemainingSeconds = 15;

    const scores: Record<string, number> = {};
    for (const p of room.players) {
      scores[p.publicId] = p.score;
    }

    const playersHUD = room.players.map(pl => ({
      id: pl.publicId,
      name: pl.name,
      college: pl.college,
      score: pl.score,
    }));

    for (const p of room.players) {
      this.safeSend(p.socket, {
        type: 'ROUND_START',
        roundIndex: room.currentRoundIndex + 1,
        totalRounds: room.questions.length,
        section: currentQ.section,
        question: {
          id: currentQ.id,
          text: currentQ.text,
          hasMath: currentQ.hasMath,
          options: currentQ.options,
        },
        durationSeconds: 15,
        scores,
        players: playersHUD,
      });
    }

    // If any player is bot, simulate bot answer realistically
    const botPlayer = room.players.find(p => p.userId.startsWith('bot_'));
    if (botPlayer) {
      const botDelayMs = 3000 + Math.floor(Math.random() * 5000);
      setTimeout(() => {
        if (room.isActive && !botPlayer.hasAnswered) {
          const isCorrect = Math.random() < 0.65;
          const chosenOpt = isCorrect
            ? currentQ.correctOption
            : (currentQ.options.find(o => o.id !== currentQ.correctOption)?.id || 'B');
          const timeBonus = Math.max(0, room.timeRemainingSeconds);
          const points = isCorrect ? (50 + timeBonus * 5) : 0;
          botPlayer.hasAnswered = true;
          botPlayer.selectedOption = chosenOpt;
          botPlayer.roundPoints = points;
          botPlayer.score += points;

          for (const pl of room.players) {
            if (pl !== botPlayer) {
              this.safeSend(pl.socket, {
                type: 'OPPONENT_ANSWERED',
                playerId: botPlayer.publicId,
                playerName: botPlayer.name,
                timeRemaining: room.timeRemainingSeconds,
              });
            }
          }

          if (room.players.every(p => p.hasAnswered)) {
            if (room.roundTimer) {
              clearInterval(room.roundTimer);
              room.roundTimer = undefined;
            }
            this.concludeRound(room);
          }
        }
      }, botDelayMs);
    }

    if (room.roundTimer) clearInterval(room.roundTimer);
    room.roundTimer = setInterval(() => {
      room.timeRemainingSeconds--;
      const tick = { type: 'ROUND_TICK', timeRemaining: room.timeRemainingSeconds };
      for (const pl of room.players) {
        this.safeSend(pl.socket, tick);
      }

      if (room.timeRemainingSeconds <= 0) {
        if (room.roundTimer) {
          clearInterval(room.roundTimer);
          room.roundTimer = undefined;
        }
        this.concludeRound(room);
      }
    }, 1000);
  }

  private concludeRound(room: DuelRoom): void {
    if (room.roundTimer) {
      clearInterval(room.roundTimer);
      room.roundTimer = undefined;
    }

    room.player1.hasAnswered = true;
    room.player2.hasAnswered = true;
    for (const p of room.players) {
      p.hasAnswered = true;
    }

    const currentQ = room.questions[room.currentRoundIndex];
    const leaderboard = [...room.players]
      .sort((a, b) => b.score - a.score)
      .map((pl, rank) => ({
        rank: rank + 1,
        id: pl.publicId,
        name: pl.name,
        score: pl.score,
        roundPoints: pl.roundPoints,
        selectedOption: pl.selectedOption || null,
      }));

    for (const p of room.players) {
      const opp = room.players.find(o => o !== p) || p;
      this.safeSend(p.socket, {
        type: 'ROUND_RESULT',
        roundIndex: room.currentRoundIndex + 1,
        section: currentQ.section,
        correctOption: currentQ.correctOption,
        yourAnswer: p.selectedOption || null,
        opponentAnswer: opp.selectedOption || null,
        yourPoints: p.roundPoints,
        opponentPoints: opp.roundPoints,
        yourScore: p.score,
        opponentScore: opp.score,
        leaderboard,
      });
    }

    setTimeout(() => {
      this.startNextRound(room);
    }, 1800);
  }

  private finishDuel(room: DuelRoom): void {
    room.isActive = false;
    if (room.roundTimer) clearInterval(room.roundTimer);

    const sortedPlayers = [...room.players].sort((a, b) => b.score - a.score);
    const highestScore = sortedPlayers[0]?.score ?? 0;
    const topScorers = sortedPlayers.filter(p => p.score === highestScore);
    const isTie = topScorers.length > 1;
    const winner = isTie ? null : sortedPlayers[0];

    if (room.players.every(p => !p.userId.startsWith('bot_'))) {
      void this.persistBattleResult(room, winner ? winner.userId : null, 'finished');
    }

    const leaderboard = sortedPlayers.map((p, idx) => ({
      rank: idx + 1,
      id: p.publicId,
      name: p.name,
      college: p.college,
      score: p.score,
      xp: idx === 0 ? 150 : (idx === 1 ? 75 : 35),
    }));

    for (let i = 0; i < sortedPlayers.length; i++) {
      const p = sortedPlayers[i];
      const isVictory = !isTie && i === 0;
      const isDraw = isTie && topScorers.some(tp => tp.userId === p.userId);
      const opp = room.players.find(o => o !== p) || p;

      this.safeSend(p.socket, {
        type: 'DUEL_FINISHED',
        winnerId: winner ? winner.publicId : null,
        isVictory,
        isDraw,
        yourScore: p.score,
        opponentScore: opp.score,
        rank: i + 1,
        totalPlayers: sortedPlayers.length,
        xpEarned: isVictory ? 150 : (isDraw ? 60 : 30),
        university: room.university,
        program: room.program,
        leaderboard,
      });
    }

    this.activeRooms.delete(room.roomId);
    for (const p of room.players) {
      if (p.socket) this.socketRooms.delete(p.socket);
    }

    if (this.redis) {
      void this.redis.publishBattleEvent(room.roomId, 'DUEL_FINISHED', {
        roomId: room.roomId,
        winnerId: winner ? winner.publicId : null,
        status: 'finished',
      });
    }
  }

  private async persistBattleResult(room: DuelRoom, winnerId: string | null, status: 'finished' | 'forfeit'): Promise<void> {
    try {
      await this.db.query(`UPDATE public.battle_rooms
        SET status='finished', winner_id=$2::uuid, round_scores=$3::jsonb
        WHERE id=$1::uuid`, [room.roomId, winnerId, JSON.stringify({
        player1Score: room.player1.score,
        player2Score: room.player2.score,
        completion: status,
      })]);
    } catch (err) {
      console.error('[RealBattleGateway] Battle result could not be persisted:', (err as Error).message);
    }
  }

  /**
   * Queries admission_test_patterns and academic_subjects in PostgreSQL
   * to dynamically generate 2-3 questions per pattern section with zero hardcoding.
   */
  public async fetchMultiSectionQuestionsFromDb(
    universityCode: string,
    programSlug: string,
    questionsPerSection = 3
  ): Promise<DuelQuestion[]> {
    const duelQuestions: DuelQuestion[] = [];

    try {
      // 1. Resolve university from database
      const uRes = await this.db.query(
        `SELECT id, code, full_name FROM universities WHERE code ILIKE $1 OR slug ILIKE $1 LIMIT 1`,
        [universityCode.trim()]
      );

      if (uRes.rows.length === 0) {
        throw new Error(`University not found in database: ${universityCode}`);
      }

      const universityId = uRes.rows[0].id;

      // 2. Resolve admission pattern from database for this program
      const patRes = await this.db.query(
        `SELECT id, pattern_name, slug, sections
         FROM admission_test_patterns
         WHERE university_id = $1 AND (slug ILIKE $2 OR pattern_name ILIKE $2)
         LIMIT 1`,
        [universityId, `%${programSlug}%`]
      );

      let sections: any[] = [];
      if (patRes.rows.length > 0 && Array.isArray(patRes.rows[0].sections)) {
        sections = patRes.rows[0].sections;
      } else {
        // Fallback to any pattern registered for this university
        const fallbackPat = await this.db.query(
          `SELECT sections FROM admission_test_patterns WHERE university_id = $1 LIMIT 1`,
          [universityId]
        );
        if (fallbackPat.rows.length > 0 && Array.isArray(fallbackPat.rows[0].sections)) {
          sections = fallbackPat.rows[0].sections;
        }
      }

      // Filter sections with questions (exclude pure viva voce oral interview entries and freehand drawing)
      let testableSections = sections.filter((s: any) => {
        const name = (s.name || '').toLowerCase();
        return !name.includes('viva') && !name.includes('interview') && !name.includes('drawing') && !name.includes('design') && !name.includes('essay');
      });

      if (testableSections.length === 0) {
        testableSections = [
          { name: 'English Language' },
          { name: 'General Mathematics' },
        ];
      }

      // 3. For each section, map dynamically to academic_subjects in database
      for (const sec of testableSections) {
        const secName = sec.name || 'Section';
        const lowerName = secName.toLowerCase();

        let subjectSlug = 'english';
        if (lowerName.includes('higher math') || lowerName.includes('calculus')) {
          subjectSlug = 'higher_mathematics';
        } else if (lowerName.includes('general math') || lowerName.includes('quantitative') || lowerName.includes('algebra') || lowerName.includes('math') || lowerName.includes('quant')) {
          subjectSlug = 'general_mathematics';
        } else if (lowerName.includes('physics')) {
          subjectSlug = 'physics';
        } else if (lowerName.includes('chem')) {
          subjectSlug = 'chemistry';
        } else if (lowerName.includes('bio')) {
          subjectSlug = 'biology';
        }

        // Fetch 2-3 authentic, pure English MCQ questions from database for this subject
        const qRes = await this.db.query(
          `SELECT q.id, q.stem_primary AS text, q.options, q.solution_markdown AS explanation, s.name AS "subjectName"
           FROM questions q
           JOIN academic_subjects s ON s.id = q.subject_id
           WHERE s.slug = $1
             AND q.is_active = true
             AND q.review_status = 'approved'
             AND jsonb_array_length(q.options) >= 2
             AND q.stem_primary !~ '[\\u0980-\\u09FF]'
             AND q.options::text !~ '[\\u0980-\\u09FF]'
           ORDER BY RANDOM()
           LIMIT $2`,
          [subjectSlug, questionsPerSection]
        );

        for (const r of qRes.rows) {
          let correctOpt = 'A';
          const opts = (Array.isArray(r.options) ? r.options : []).map((o: any, idx: number) => {
            const id = o.key_original || o.id || String.fromCharCode(65 + idx);
            if (o.is_correct || o.isCorrect) correctOpt = id;
            return { id, text: o.text || '' };
          });

          duelQuestions.push({
            id: r.id,
            section: secName,
            text: r.text || 'Question',
            hasMath: (r.text || '').includes('$'),
            options: opts,
            correctOption: correctOpt,
            explanation: r.explanation || '',
          });
        }
      }
    } catch (err: any) {
      console.error('[RealBattleGateway] Database question retrieval error:', err.message);
    }

    return duelQuestions;
  }

  private safeSend(socket: WebSocket, data: any): void {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(data));
    }
  }
}
