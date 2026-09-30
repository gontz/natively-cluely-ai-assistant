import React, { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { SettingsToggle } from './SettingsToggle';

/**
 * Settings > Screen & Vision. Live screen context: while a meeting runs,
 * Natively captures and describes the screen on a timer so automatic answers
 * can use what is on screen, and can optionally answer a question that only
 * appears on screen. Both are off by default; every tick can be a vision API
 * call, which is why the interval and the cost are shown here.
 *
 * Ported from the "Screen & Vision" tab in rishikeshl0510's fork (51caf46),
 * reduced to the live-screen-context controls. The vision routing card stays
 * in AI Providers > Privacy.
 */

interface ScreenContextView {
    enabled: boolean;
    screenOnlyAutoAnswer: boolean;
    intervalMs: number;
    minIntervalMs: number;
    maxIntervalMs: number;
    defaultIntervalMs: number;
}

const INTERVAL_CHOICES_S = [10, 15, 20, 30, 45, 60, 90, 120];

export const ScreenVisionSettings: React.FC = () => {
    const t = useT();
    const [view, setView] = useState<ScreenContextView | null>(null);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const v = await window.electronAPI?.screenContextGetSettings?.();
                if (!cancelled && v) setView(v);
            } catch (e: any) {
                if (!cancelled) setStatus(e?.message || 'Could not load screen context settings.');
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // Optimistic; reverts and surfaces the error if main refuses the write.
    const update = async (patch: { enabled?: boolean; screenOnlyAutoAnswer?: boolean; intervalMs?: number }) => {
        if (!view || busy) return;
        if (typeof window.electronAPI?.screenContextSetSettings !== 'function') {
            setStatus('Settings bridge unavailable. Restart Natively.');
            return;
        }
        const previous = view;
        setView({
            ...view,
            ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
            ...(patch.screenOnlyAutoAnswer !== undefined ? { screenOnlyAutoAnswer: patch.screenOnlyAutoAnswer } : {}),
            ...(patch.intervalMs !== undefined ? { intervalMs: patch.intervalMs } : {}),
        });
        setBusy(true);
        try {
            const res = await window.electronAPI.screenContextSetSettings(patch);
            if (!res?.success || !res.settings) {
                setView(previous);
                setStatus(res?.error === 'settings_store_degraded'
                    ? t('Settings could not be saved this session.')
                    : (res?.error || t('Could not update screen context settings.')));
                return;
            }
            setView({ ...previous, ...res.settings });
            setStatus(null);
        } catch (e: any) {
            setView(previous);
            setStatus(e?.message || t('Could not update screen context settings.'));
        } finally {
            setBusy(false);
        }
    };

    const intervalS = view ? Math.round(view.intervalMs / 1000) : 15;
    const callsPerMinute = Math.round((60 / intervalS) * 10) / 10;
    const choices = view
        ? INTERVAL_CHOICES_S.filter((s) => s * 1000 >= view.minIntervalMs && s * 1000 <= view.maxIntervalMs)
        : INTERVAL_CHOICES_S;

    return (
        <div className="space-y-5">
            <div>
                <h3 className="text-lg font-bold text-text-primary mb-1">{t('Screen & Vision')}</h3>
                <p className="text-xs text-text-secondary">
                    {t('Controls whether Natively looks at your screen on its own during a meeting. Manual screenshots are not affected.')}
                </p>
            </div>

            <div className="rounded-xl bg-bg-card p-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                    <h4 className="text-sm font-semibold text-text-primary mb-1">{t('Automatic screen context')}</h4>
                    <p className="text-xs text-text-secondary">
                        {t('During a meeting, captures and describes your screen on a timer so automatic answers can use what is on it. Uses your vision provider on every capture. Follows the screenshot privacy settings in AI Providers > Privacy.')}
                    </p>
                </div>
                <SettingsToggle
                    checked={Boolean(view?.enabled)}
                    onChange={() => { void update({ enabled: !view?.enabled }); }}
                    label={t('Automatic screen context')}
                    disabled={!view || busy}
                    className={view?.enabled ? 'bg-accent-primary border border-transparent' : 'bg-bg-toggle-switch border border-border-muted'}
                />
            </div>

            <div className={`rounded-xl bg-bg-card p-4 flex items-center justify-between gap-4 ${view?.enabled ? '' : 'opacity-60'}`}>
                <div className="min-w-0">
                    <h4 className="text-sm font-semibold text-text-primary mb-1">{t('Capture interval')}</h4>
                    <p className="text-xs text-text-secondary">
                        {t('Up to')} {callsPerMinute} {t('vision calls per minute while a meeting runs. An unchanged screen reuses the previous description.')}
                    </p>
                </div>
                <select
                    value={intervalS}
                    disabled={!view?.enabled || busy}
                    onChange={(e) => { void update({ intervalMs: Number(e.target.value) * 1000 }); }}
                    aria-label={t('Capture interval')}
                    className="rounded-md border border-border-subtle bg-bg-item-surface px-2 py-1 text-xs text-text-primary disabled:opacity-60"
                >
                    {choices.map((s) => (
                        <option key={s} value={s}>{s} s</option>
                    ))}
                </select>
            </div>

            <div className={`rounded-xl bg-bg-card p-4 flex items-center justify-between gap-4 ${view?.enabled ? '' : 'opacity-60'}`}>
                <div className="min-w-0">
                    <h4 className="text-sm font-semibold text-text-primary mb-1">{t('Answer questions shown on screen')}</h4>
                    <p className="text-xs text-text-secondary">
                        {t('When Auto Answer is on and the screen shows a new, unanswered question, answer it even if nobody asks it aloud. The vision model decides what counts as a question. Requires automatic screen context.')}
                    </p>
                </div>
                <SettingsToggle
                    checked={Boolean(view?.enabled && view?.screenOnlyAutoAnswer)}
                    onChange={() => { void update({ screenOnlyAutoAnswer: !view?.screenOnlyAutoAnswer }); }}
                    label={t('Answer questions shown on screen')}
                    disabled={!view?.enabled || busy}
                    className={view?.enabled && view?.screenOnlyAutoAnswer ? 'bg-accent-primary border border-transparent' : 'bg-bg-toggle-switch border border-border-muted'}
                />
            </div>

            {status && <p className="text-xs text-red-400">{status}</p>}
        </div>
    );
};
