#!/usr/bin/env node
/**
 * HTTP entry point for the Confluence Cloud MCP server.
 * Run via PM2 for shared access across Claude Code projects.
 *
 * Uses a server-per-session factory pattern because the MCP SDK's
 * Server.connect() only allows one transport per Server instance.
 * Each HTTP session gets its own MCP Server with all handlers.
 */
import { randomUUID } from 'crypto';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express, { Request, Response } from 'express';

import { loadConfiguration } from './config-loader.js';
import { createConfluenceServer } from './server.js';

const DEFAULT_PORT = 8106;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface ManagedSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

// Parse --port from CLI args or env
function getPort(): number {
  const portArg = process.argv.find((arg) => arg.startsWith('--port'));
  if (portArg) {
    const value = portArg.includes('=')
      ? portArg.split('=')[1]
      : process.argv[process.argv.indexOf(portArg) + 1];
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
  }
  return parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
}

// Stateful session management — one Server + Transport per session
const sessions: Map<string, ManagedSession> = new Map();

/** Check if body contains an initialize request (handles arrays per batch spec) */
function checkInitializeRequest(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some((item) => isInitializeRequest(item));
  }
  return isInitializeRequest(body);
}

async function main() {
  await loadConfiguration();
  const port = getPort();

  const app = express();
  app.use(express.json());

  // Health check endpoint
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      server: 'confluence-cloud-mcp',
      transport: 'streamable-http',
      activeSessions: sessions.size,
      uptime: process.uptime(),
    });
  });

  // MCP POST — handle initialize + subsequent requests
  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      // Existing session — route to its transport
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        session.lastActivity = Date.now();
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      // Unknown session ID — reject
      if (sessionId && !sessions.has(sessionId)) {
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Session not found. It may have expired.' },
          id: null,
        });
        return;
      }

      // No session ID — must be an initialize request
      if (!checkInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: first request must be an initialization request' },
          id: null,
        });
        return;
      }

      // Create a new session: fresh Server + Transport
      const mcpServer = createConfluenceServer();

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          sessions.set(sid, {
            server: mcpServer,
            transport,
            lastActivity: Date.now(),
          });
          console.error(`New session ${sid} (${sessions.size} active)`);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          sessions.delete(sid);
          console.error(`Session ${sid} closed (${sessions.size} active)`);
        }
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // MCP GET — SSE stream for notifications
  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: invalid session ID' },
        id: null,
      });
      return;
    }

    const session = sessions.get(sessionId)!;
    session.lastActivity = Date.now();
    await session.transport.handleRequest(req, res);
  });

  // MCP DELETE — session termination
  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: invalid session ID' },
        id: null,
      });
      return;
    }

    const session = sessions.get(sessionId)!;
    await session.transport.close();
    await session.server.close();
    sessions.delete(sessionId);
    res.status(200).json({ status: 'session closed' });
  });

  // Periodic cleanup of stale sessions
  const cleanupTimer = setInterval(async () => {
    const now = Date.now();
    for (const [sid, session] of sessions) {
      if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
        console.error(`Cleaning up stale session ${sid} (idle ${Math.round((now - session.lastActivity) / 1000)}s)`);
        try {
          await session.transport.close();
          await session.server.close();
        } catch {
          // Best-effort cleanup
        }
        sessions.delete(sid);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  app.listen(port, '127.0.0.1', () => {
    console.error(`Confluence Cloud MCP HTTP server listening on http://127.0.0.1:${port}/mcp`);
    console.error(`Health check: http://127.0.0.1:${port}/health`);
  });

  // Graceful shutdown with idempotency guard
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.error(`Received ${signal}, shutting down gracefully...`);
    clearInterval(cleanupTimer);

    for (const [sid, session] of sessions) {
      try {
        await session.transport.close();
        await session.server.close();
      } catch {
        // Best-effort cleanup
      }
      sessions.delete(sid);
    }

    console.error('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
