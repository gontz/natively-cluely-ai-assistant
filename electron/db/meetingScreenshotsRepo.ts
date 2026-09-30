// electron/db/meetingScreenshotsRepo.ts
//
// SQL for screenshots recorded with a saved meeting. Kept out of
// DatabaseManager so the exact production statements can be exercised against
// an in-memory better-sqlite3 in tests (no mirrored SQL to drift).

import type Database from 'better-sqlite3';
import type { MeetingScreenshot, MeetingScreenshotCaptureKind } from '../services/meeting/MeetingScreenshotStore';

/**
 * Additive and idempotent: CREATE ... IF NOT EXISTS on a new table, so it
 * cannot touch existing rows and is safe to run on every boot. It is applied
 * unconditionally rather than behind a `user_version` bump for the same
 * reason as meetings.user_titled: parallel branches have raced for the same
 * version numbers before, and a gate that loses that race never runs again.
 */
export function ensureMeetingScreenshotsTable(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS meeting_screenshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            captured_at INTEGER NOT NULL,
            capture_kind TEXT NOT NULL DEFAULT 'full',
            FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_meeting_screenshots_meeting
            ON meeting_screenshots(meeting_id);
    `);
}

const normalizeKind = (kind: unknown): MeetingScreenshotCaptureKind =>
    kind === 'selective' ? 'selective' : 'full';

/**
 * Replace a meeting's screenshot rows. Must run inside the caller's
 * transaction (saveMeeting) so rows and meeting stay consistent. Entries
 * without a path or a finite timestamp are skipped.
 */
export function replaceMeetingScreenshots(
    db: Database.Database,
    meetingId: string,
    screenshots: readonly MeetingScreenshot[],
): void {
    db.prepare('DELETE FROM meeting_screenshots WHERE meeting_id = ?').run(meetingId);
    const insert = db.prepare(`
        INSERT INTO meeting_screenshots (meeting_id, file_path, captured_at, capture_kind)
        VALUES (?, ?, ?, ?)
    `);
    for (const shot of screenshots) {
        if (!shot || typeof shot.path !== 'string' || !shot.path) continue;
        if (typeof shot.timestamp !== 'number' || !Number.isFinite(shot.timestamp)) continue;
        insert.run(meetingId, shot.path, Math.round(shot.timestamp), normalizeKind(shot.captureKind));
    }
}

export function getMeetingScreenshots(db: Database.Database, meetingId: string): MeetingScreenshot[] {
    const rows = db.prepare(`
        SELECT file_path, captured_at, capture_kind FROM meeting_screenshots
         WHERE meeting_id = ? ORDER BY captured_at ASC, id ASC
    `).all(meetingId) as Array<{ file_path: string; captured_at: number; capture_kind: string }>;
    return rows.map(row => ({
        path: row.file_path,
        timestamp: row.captured_at,
        captureKind: normalizeKind(row.capture_kind),
    }));
}

/** Every stored path for one meeting, or for all meetings when id is omitted. */
export function getMeetingScreenshotPaths(db: Database.Database, meetingId?: string): string[] {
    const rows = (meetingId === undefined
        ? db.prepare('SELECT file_path FROM meeting_screenshots').all()
        : db.prepare('SELECT file_path FROM meeting_screenshots WHERE meeting_id = ?').all(meetingId)) as Array<{ file_path: string }>;
    return rows.map(row => row.file_path);
}

/** True when some saved meeting references this exact file. */
export function isRecordedMeetingScreenshot(db: Database.Database, filePath: string): boolean {
    return !!db.prepare('SELECT 1 FROM meeting_screenshots WHERE file_path = ? LIMIT 1').get(filePath);
}
