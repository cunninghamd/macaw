import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../database/database.service';
import { appConfig } from '../config/app.config';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { glob, globSync } from 'glob';
import * as os from 'os';

interface TokenData {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  reasoning_tokens: number;
  model?: string;
  timestamp?: string;
  cost?: number;
}

@Injectable()
export class IngestService implements OnModuleInit {
  private readonly logger = new Logger(IngestService.name);
  private isIngesting = false;

  constructor(private readonly dbService: DatabaseService) {}

  onModuleInit() {
    this.migrateProjectPaths();
    this.decodeHyphenPaths();
    this.ingest();
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleCron() {
    this.logger.log('Running scheduled ingestion...');
    await this.ingest();
  }

  async ingest(): Promise<void> {
    if (this.isIngesting) {
      this.logger.warn('Ingest already in progress, skipping');
      return;
    }
    this.isIngesting = true;

    try {
      const home = os.homedir();
      const sources = [
        { name: 'claude', pattern: path.join(home, '.claude', 'projects', '**', '*.jsonl') },
        { name: 'codex', pattern: path.join(home, '.codex', 'sessions', '**', '*.jsonl') },
        { name: 'pi', pattern: path.join(home, '.pi', 'agent', 'sessions', '**', '*.jsonl') },
      ];

      for (const source of sources) {
        let files: string[];
        try {
          files = await glob(source.pattern, { absolute: true });
        } catch (err: any) {
          this.logger.error(`Glob failed for ${source.name}: ${err.message}`);
          continue;
        }

        this.logger.log(`Found ${files.length} ${source.name} files`);

        for (const file of files) {
          try {
            await this.ingestFile(file, source.name);
          } catch (err: any) {
            this.logger.error(`Failed to ingest ${file}: ${err.message}`);
          }
        }
      }

      this.logger.log('Ingestion complete');
      this.decodeHyphenPaths();
    } catch (err: any) {
      this.logger.error(`Ingest failed: ${err.message}`);
      throw err;
    } finally {
      this.isIngesting = false;
    }
  }

  private async ingestFile(filePath: string, source: string) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return;

    const sessionId = path.basename(filePath, '.jsonl');
    const projectPath = this.deriveProjectPath(filePath, source);
    const db = this.dbService.getDb();

    const existing = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as any;
    const lastLine = existing ? existing.last_line : 0;

    let currentLine = 0;
    let tokensAdded = false;
    let firstTimestamp: string | null = null;
    let lastTimestamp: string | null = null;
    let sessionModel: string | null = null;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheCreation = 0;
    let totalCacheRead = 0;
    let totalReasoning = 0;
    let totalCost = 0;

    const insertMessage = db.prepare(`
      INSERT INTO messages (session_id, source, timestamp, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, reasoning_tokens, cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const stream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      currentLine++;
      if (currentLine <= lastLine) continue;
      if (!line.trim()) continue;

      let data: any;
      try {
        data = JSON.parse(line);
      } catch {
        continue;
      }

      const tokenData = this.extractTokens(data, source);
      if (!tokenData) continue;

      tokensAdded = true;

      if (tokenData.timestamp) {
        if (!firstTimestamp) firstTimestamp = tokenData.timestamp;
        lastTimestamp = tokenData.timestamp;
      }

      totalInput += tokenData.input_tokens;
      totalOutput += tokenData.output_tokens;
      totalCacheCreation += tokenData.cache_creation_tokens;
      totalCacheRead += tokenData.cache_read_tokens;
      totalReasoning += tokenData.reasoning_tokens;
      totalCost += tokenData.cost || 0;
      if (tokenData.model) sessionModel = tokenData.model;

      insertMessage.run(
        sessionId,
        source,
        tokenData.timestamp || null,
        tokenData.model || null,
        tokenData.input_tokens,
        tokenData.output_tokens,
        tokenData.cache_creation_tokens,
        tokenData.cache_read_tokens,
        tokenData.reasoning_tokens,
        tokenData.cost || 0,
      );
    }

    if (!tokensAdded && existing) return;

    if (existing) {
      db.prepare(`
        UPDATE sessions SET
          project_path = ?,
          model = COALESCE(?, model),
          last_timestamp = ?,
          input_tokens = input_tokens + ?,
          output_tokens = output_tokens + ?,
          cache_creation_tokens = cache_creation_tokens + ?,
          cache_read_tokens = cache_read_tokens + ?,
          reasoning_tokens = reasoning_tokens + ?,
          last_line = ?
        WHERE session_id = ?
      `).run(
        projectPath || existing.project_path,
        sessionModel,
        lastTimestamp || existing.last_timestamp,
        totalInput,
        totalOutput,
        totalCacheCreation,
        totalCacheRead,
        totalReasoning,
        currentLine,
        sessionId,
      );
    } else {
      db.prepare(`
        INSERT INTO sessions (session_id, source, project_path, model, first_timestamp, last_timestamp, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, reasoning_tokens, last_line)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        source,
        projectPath,
        sessionModel,
        firstTimestamp,
        lastTimestamp,
        totalInput,
        totalOutput,
        totalCacheCreation,
        totalCacheRead,
        totalReasoning,
        currentLine,
      );
    }
  }

  private deriveProjectPath(filePath: string, source: string): string | null {
    try {
      const head = this.readFileHead(filePath, 4096);
      const lines = head.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.cwd && typeof data.cwd === 'string') {
            return this.cleanProjectPath(data.cwd);
          }
        } catch {
          continue;
        }
      }
    } catch {
      // fall through to path-based fallback
    }

    const parts = filePath.split(path.sep);
    if (source === 'claude') {
      const idx = parts.indexOf('projects');
      if (idx >= 0 && parts[idx + 1]) {
        return this.cleanProjectPath(parts[idx + 1].replace(/-/g, '/'));
      }
    } else if (source === 'pi') {
      const idx = parts.indexOf('sessions');
      if (idx >= 0 && parts[idx + 1]) {
        let raw = parts[idx + 1];
        if (raw.startsWith('--') && raw.endsWith('--')) {
          raw = raw.slice(2, -2);
        }
        return this.cleanProjectPath(raw.replace(/-/g, '/'));
      }
    }
    return null;
  }

  private readFileHead(filePath: string, bytes: number): string {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const n = fs.readSync(fd, buf, 0, bytes, 0);
      return buf.toString('utf-8', 0, n);
    } finally {
      fs.closeSync(fd);
    }
  }

  private cleanProjectPath(cwd: string): string | null {
    if (!cwd || typeof cwd !== 'string') return null;
    let clean = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd;

    for (const base of appConfig.basePaths) {
      let normalized = base;
      if (!normalized.endsWith('/')) normalized += '/';
      if (clean.startsWith(normalized)) {
        clean = clean.slice(normalized.length);
        break;
      }
    }
    return clean;
  }

  private decodeHyphenPaths() {
    const db = this.dbService.getDb();
    const allPaths = new Set(
      (db.prepare('SELECT DISTINCT project_path FROM sessions').all() as any[])
        .map(r => r.project_path)
        .filter(Boolean),
    );

    const decoded = new Map<string, string>();
    for (const raw of allPaths) {
      if (!raw.includes('-')) continue;
      const d = this.tryDecodeHyphenPath(raw, allPaths);
      if (d && d !== raw) {
        decoded.set(raw, d);
      }
    }

    let updated = 0;
    for (const [raw, dec] of decoded) {
      db.prepare('UPDATE sessions SET project_path = ? WHERE project_path = ?').run(dec, raw);
      updated++;
    }

    if (updated > 0) {
      this.logger.log(`Decoded ${updated} hyphenated project paths`);
    }
  }

  private tryDecodeHyphenPath(raw: string, knownPaths: Set<string>): string {
    const parts = raw.split('-');
    for (let i = parts.length - 1; i >= 1; i--) {
      const prefix = parts.slice(0, i).join('-');
      if (knownPaths.has(prefix)) {
        const remainder = parts.slice(i).join('-');
        const decoded = `${prefix}/${this.tryDecodeHyphenPath(remainder, knownPaths)}`;
        return decoded;
      }
    }
    return raw;
  }

  private migrateProjectPaths() {
    const db = this.dbService.getDb();
    const sessions = db.prepare('SELECT session_id, source, project_path FROM sessions').all() as any[];
    const home = os.homedir();
    let updated = 0;

    for (const session of sessions) {
      let newPath: string | null = null;

      const patterns: Record<string, string> = {
        claude: path.join(home, '.claude', 'projects', '**', `${session.session_id}.jsonl`),
        pi: path.join(home, '.pi', 'agent', 'sessions', '**', `${session.session_id}.jsonl`),
        codex: path.join(home, '.codex', 'sessions', '**', `${session.session_id}.jsonl`),
      };
      const pattern = patterns[session.source];
      if (pattern) {
        try {
          const files = globSync(pattern, { absolute: true });
          if (files.length > 0) {
            newPath = this.deriveProjectPath(files[0], session.source);
          }
        } catch {
          // ignore glob errors during migration
        }
      }

      if (newPath && newPath !== session.project_path) {
        db.prepare('UPDATE sessions SET project_path = ? WHERE session_id = ?').run(newPath, session.session_id);
        updated++;
      }
    }

    if (updated > 0) {
      this.logger.log(`Migrated ${updated} session project paths`);
    }
  }

  private extractTokens(data: any, source: string): TokenData | null {
    if (source === 'claude') {
      if (data && typeof data === 'object' && data.type === 'assistant') {
        const u = data.message?.usage;
        if (!u) return null;
        return {
          input_tokens: u.input_tokens || 0,
          output_tokens: u.output_tokens || 0,
          cache_creation_tokens: u.cache_creation_input_tokens || 0,
          cache_read_tokens: u.cache_read_input_tokens || 0,
          reasoning_tokens: 0,
          model: data.message?.model || null,
          timestamp: data.timestamp || data.message?.timestamp || null,
        };
      }
    } else if (source === 'codex') {
      if (data && typeof data === 'object' && (data.type === 'token_count' || data.event_type === 'token_count') && data.total_token_usage) {
        const u = data.total_token_usage;
        return {
          input_tokens: u.input_tokens || 0,
          output_tokens: u.output_tokens || 0,
          cache_creation_tokens: 0,
          cache_read_tokens: u.cached_input_tokens || 0,
          reasoning_tokens: u.reasoning_output_tokens || 0,
          model: data.model || null,
          timestamp: data.timestamp || null,
        };
      }
    } else if (source === 'pi') {
      if (data && typeof data === 'object' && data.type === 'message' && data.message?.role === 'assistant') {
        const u = data.message?.usage;
        if (!u) return null;
        return {
          input_tokens: u.input || 0,
          output_tokens: u.output || 0,
          cache_creation_tokens: u.cacheWrite || 0,
          cache_read_tokens: u.cacheRead || 0,
          reasoning_tokens: 0,
          model: data.message?.model || data.model || null,
          timestamp: data.timestamp || data.message?.timestamp || null,
          cost: u.cost?.total || 0,
        };
      }
    }
    return null;
  }
}
