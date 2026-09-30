// mcp-server/userDataPath.mjs
//
// Where Natively keeps natively.db, resolved WITHOUT an Electron runtime.
// Pure (platform, env and home are parameters) so both platform branches are
// testable from any OS: electron/services/__tests__/InterviewKnowledgeMcpServerPaths.test.mjs.
//
// Electron's app.getPath('userData') is <appData>/<app name>, and the app
// name comes from the packaged package.json's productName ("Natively", set by
// electron-builder). A dev run (`electron .`) uses the top-level package name
// ("natively") instead; that folder differs only by case, which Windows and
// default macOS volumes ignore, and NATIVELY_USER_DATA_DIR covers anything
// else (a dev profile on Linux, a custom location).

import path from 'node:path';

export const PRODUCT_NAME = 'Natively';
export const DB_FILE_NAME = 'natively.db';

/**
 * @param {{ platform: NodeJS.Platform, env: Record<string, string | undefined>, homedir: string }} opts
 * @returns {string}
 */
export function resolveUserDataPath({ platform, env, homedir }) {
    // Explicit overrides first: the same test variable DatabaseManager honours,
    // then a user-facing one for non-default profiles.
    if (env.NATIVELY_TEST_USERDATA) return env.NATIVELY_TEST_USERDATA;
    if (env.NATIVELY_USER_DATA_DIR) return env.NATIVELY_USER_DATA_DIR;
    // path.win32 / path.posix explicitly, so a win32 result built on macOS
    // (in a test) still uses backslashes, and vice versa.
    if (platform === 'win32') {
        const appData = env.APPDATA || path.win32.join(homedir, 'AppData', 'Roaming');
        return path.win32.join(appData, PRODUCT_NAME);
    }
    if (platform === 'darwin') {
        return path.posix.join(homedir, 'Library', 'Application Support', PRODUCT_NAME);
    }
    return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(homedir, '.config'), PRODUCT_NAME);
}

/** @param {{ platform: NodeJS.Platform, env: Record<string, string | undefined>, homedir: string }} opts */
export function resolveDbPath(opts) {
    const dir = resolveUserDataPath(opts);
    return (opts.platform === 'win32' ? path.win32 : path.posix).join(dir, DB_FILE_NAME);
}
