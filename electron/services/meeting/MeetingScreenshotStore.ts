// electron/services/meeting/MeetingScreenshotStore.ts
//
// File side of "screenshots in saved meeting history".
//
// Captures land in <userData>/screenshots (or extra_screenshots) and that
// folder is a short rolling queue: ScreenshotHelper deletes the oldest file
// once more than MAX_SCREENSHOTS are queued, `reset-queues` deletes them all,
// and clearQueues() runs on quit. A saved meeting that pointed at those paths
// would lose its images within minutes. So a screenshot taken during an
// active meeting is COPIED into
//
//     <userData>/meeting-screenshots/<sessionKey>/<file>
//
// where <sessionKey> is the SessionTracker's per-session key (one session =
// one saved meeting). The DB stores the absolute copied path; deleting a
// meeting deletes exactly those files and then the folder if it is empty.
//
// Every function takes the `path` flavour as a parameter (default: the host's)
// so the containment checks run under both path.win32 and path.posix in tests
// on any OS. Nothing here reads process.platform.

import nodePath from 'path';
import nodeFs from 'fs';

export type MeetingScreenshotCaptureKind = 'full' | 'selective';

export interface MeetingScreenshot {
    /** Absolute path of the copy under the meeting-screenshots root. */
    path: string;
    /** Capture time, epoch ms. */
    timestamp: number;
    captureKind: MeetingScreenshotCaptureKind;
}

export const MEETING_SCREENSHOTS_DIRNAME = 'meeting-screenshots';

type PathLike = Pick<typeof nodePath, 'join' | 'resolve' | 'relative' | 'isAbsolute' | 'basename' | 'dirname' | 'extname'>;

export interface StoreFs {
    promises: Pick<typeof nodeFs.promises, 'mkdir' | 'copyFile' | 'unlink'>;
    unlinkSync: typeof nodeFs.unlinkSync;
    rmdirSync: typeof nodeFs.rmdirSync;
    readdirSync: typeof nodeFs.readdirSync;
    rmSync: typeof nodeFs.rmSync;
    existsSync: typeof nodeFs.existsSync;
}

const SESSION_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IMAGE_EXT_RE = /^\.(png|jpe?g)$/i;

export function meetingScreenshotsRoot(userDataDir: string, p: PathLike = nodePath): string {
    return p.join(userDataDir, MEETING_SCREENSHOTS_DIRNAME);
}

/**
 * True when `target` is strictly inside `dir` (never `dir` itself). Uses
 * path.relative so win32 drive letters and case are compared the way the
 * platform compares them, and `..` segments cannot escape.
 */
export function isPathInside(dir: string, target: string, p: PathLike = nodePath): boolean {
    if (!dir || !target) return false;
    const rel = p.relative(p.resolve(dir), p.resolve(target));
    if (!rel) return false;
    if (p.isAbsolute(rel)) return false; // different drive on win32
    return rel !== '..' && !rel.startsWith('..' + '/') && !rel.startsWith('..' + '\\');
}

/** A stored screenshot the renderer may read / export: inside the root and an image file. */
export function isStoredScreenshotPath(root: string, target: string, p: PathLike = nodePath): boolean {
    return isPathInside(root, target, p) && IMAGE_EXT_RE.test(p.extname(target));
}

export function sessionScreenshotDir(root: string, sessionKey: string, p: PathLike = nodePath): string {
    if (!SESSION_KEY_RE.test(sessionKey)) {
        throw new Error(`Invalid screenshot session key: ${sessionKey}`);
    }
    return p.join(root, sessionKey);
}

/** Copy one capture into the session's folder; returns the copy's absolute path. */
export async function copyScreenshotIntoSession(
    root: string,
    sessionKey: string,
    sourcePath: string,
    deps: { fs?: StoreFs; path?: PathLike } = {},
): Promise<string> {
    const fs = deps.fs ?? nodeFs;
    const p = deps.path ?? nodePath;
    const ext = p.extname(sourcePath);
    if (!IMAGE_EXT_RE.test(ext)) {
        throw new Error(`Not a screenshot image: ${sourcePath}`);
    }
    const dir = sessionScreenshotDir(root, sessionKey, p);
    await fs.promises.mkdir(dir, { recursive: true });
    const dest = p.join(dir, p.basename(sourcePath));
    await fs.promises.copyFile(sourcePath, dest);
    return dest;
}

/**
 * Delete stored screenshot files, then any session folder left empty.
 * Paths outside the root are ignored, so a corrupt or hostile DB row can
 * never delete an arbitrary file. Best-effort: returns how many files were
 * removed and never throws.
 */
export function removeStoredScreenshots(
    root: string,
    paths: readonly string[],
    deps: { fs?: StoreFs; path?: PathLike } = {},
): number {
    const fs = deps.fs ?? nodeFs;
    const p = deps.path ?? nodePath;
    let removed = 0;
    const dirs = new Set<string>();
    for (const file of paths) {
        if (!isStoredScreenshotPath(root, file, p)) continue;
        try {
            fs.unlinkSync(file);
            removed++;
        } catch (e: any) {
            if (e?.code !== 'ENOENT') {
                console.warn('[MeetingScreenshotStore] Failed to delete screenshot:', file, e?.message || e);
            }
        }
        const parent = p.dirname(file);
        if (isPathInside(root, parent, p)) dirs.add(parent);
    }
    for (const dir of dirs) {
        try {
            if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
        } catch { /* folder still in use or already gone */ }
    }
    return removed;
}

/** Drop a whole session folder (a session that ended without being saved). */
export function removeSessionScreenshots(
    root: string,
    sessionKey: string,
    deps: { fs?: StoreFs; path?: PathLike } = {},
): void {
    const fs = deps.fs ?? nodeFs;
    const p = deps.path ?? nodePath;
    try {
        const dir = sessionScreenshotDir(root, sessionKey, p);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (e: any) {
        console.warn('[MeetingScreenshotStore] Failed to remove session screenshots:', sessionKey, e?.message || e);
    }
}

/** Remove every stored meeting screenshot (used by "clear all data"). */
export function removeAllStoredScreenshots(root: string, deps: { fs?: StoreFs } = {}): void {
    const fs = deps.fs ?? nodeFs;
    try {
        if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    } catch (e: any) {
        console.warn('[MeetingScreenshotStore] Failed to clear meeting screenshots:', e?.message || e);
    }
}

/**
 * The userData directory, resolved the same way DatabaseManager resolves it:
 * NATIVELY_TEST_USERDATA first (test runner), then Electron's app path.
 * Returns null when neither is available (plain node without Electron).
 */
export function resolveUserDataDir(): string | null {
    const fromEnv = process.env.NATIVELY_TEST_USERDATA;
    if (fromEnv) return fromEnv;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { app } = require('electron');
        if (app && typeof app.getPath === 'function') return app.getPath('userData');
    } catch { /* not in Electron */ }
    return null;
}

/**
 * Default file name offered by "Save as" for a stored screenshot. Local time,
 * no ':' or other characters Windows rejects in file names.
 */
export function defaultScreenshotExportName(timestamp: number, sourcePath: string, p: PathLike = nodePath): string {
    const ext = (p.extname(sourcePath) || '.png').toLowerCase();
    const d = new Date(Number.isFinite(timestamp) ? timestamp : Date.now());
    const two = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}`;
    return `Natively screenshot ${stamp}${ext}`;
}

export function screenshotMimeType(filePath: string, p: PathLike = nodePath): string {
    return /^\.jpe?g$/i.test(p.extname(filePath)) ? 'image/jpeg' : 'image/png';
}
