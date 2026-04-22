import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class UsageService {
  constructor(private readonly dbService: DatabaseService) {}

  getSummary() {
    const db = this.dbService.getDb();

    const allTime = db.prepare(`
      SELECT source, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
             SUM(cache_creation_tokens) as cache_creation_tokens, SUM(cache_read_tokens) as cache_read_tokens,
             SUM(reasoning_tokens) as reasoning_tokens,
             (SELECT SUM(cost) FROM messages m WHERE m.source = s.source) as cost
      FROM sessions s
      GROUP BY source
    `).all();

    const today = db.prepare(`
      SELECT source, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
             SUM(cache_creation_tokens) as cache_creation_tokens, SUM(cache_read_tokens) as cache_read_tokens,
             SUM(reasoning_tokens) as reasoning_tokens,
             (SELECT SUM(cost) FROM messages m WHERE m.source = s.source AND date(m.timestamp) = date('now')) as cost
      FROM sessions s
      WHERE date(first_timestamp) = date('now')
      GROUP BY source
    `).all();

    const week = db.prepare(`
      SELECT source, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
             SUM(cache_creation_tokens) as cache_creation_tokens, SUM(cache_read_tokens) as cache_read_tokens,
             SUM(reasoning_tokens) as reasoning_tokens,
             (SELECT SUM(cost) FROM messages m WHERE m.source = s.source AND date(m.timestamp) >= date('now', '-7 days')) as cost
      FROM sessions s
      WHERE date(first_timestamp) >= date('now', '-7 days')
      GROUP BY source
    `).all();

    return { allTime, today, week };
  }

  getDaily(days: number | null) {
    const db = this.dbService.getDb();
    if (days === null) {
      return db.prepare(`
        SELECT date(timestamp) as date, source,
               SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
               SUM(cost) as cost
        FROM messages
        GROUP BY date, source
        ORDER BY date ASC
      `).all();
    }
    return db.prepare(`
      SELECT date(timestamp) as date, source,
             SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
             SUM(cost) as cost
      FROM messages
      WHERE date(timestamp) >= date('now', '-' || ? || ' days')
      GROUP BY date, source
      ORDER BY date ASC
    `).all(days);
  }

  getSessions(limit = 50, offset = 0) {
    const db = this.dbService.getDb();
    return db.prepare(`
      SELECT s.session_id, s.source, s.project_path, s.model, s.first_timestamp, s.last_timestamp,
             s.input_tokens, s.output_tokens, s.cache_creation_tokens, s.cache_read_tokens, s.reasoning_tokens,
             COALESCE((SELECT SUM(m.cost) FROM messages m WHERE m.session_id = s.session_id), 0) as cost
      FROM sessions s
      ORDER BY s.last_timestamp DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  getProjects() {
    const db = this.dbService.getDb();
    return db.prepare(`
      SELECT s.project_path, s.source,
             SUM(s.input_tokens) as input_tokens, SUM(s.output_tokens) as output_tokens,
             SUM(s.cache_creation_tokens) as cache_creation_tokens, SUM(s.cache_read_tokens) as cache_read_tokens,
             SUM(s.reasoning_tokens) as reasoning_tokens,
             COUNT(*) as session_count,
             COALESCE((SELECT SUM(m.cost) FROM messages m WHERE m.session_id IN (SELECT s2.session_id FROM sessions s2 WHERE s2.project_path = s.project_path AND s2.source = s.source)), 0) as cost
      FROM sessions s
      WHERE s.project_path IS NOT NULL
      GROUP BY s.project_path, s.source
      ORDER BY (SUM(s.input_tokens) + SUM(s.output_tokens)) DESC
    `).all();
  }
}
