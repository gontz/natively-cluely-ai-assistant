import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, ImageOff, X } from 'lucide-react';
import { useT } from '../i18n';

export interface MeetingScreenshotEntry {
    path: string;
    timestamp: number;
    captureKind?: 'full' | 'selective';
}

const formatClock = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }).toLowerCase();

type ImageState = { status: 'loading' } | { status: 'ready'; src: string } | { status: 'missing' };

function useScreenshotImage(path: string | null, variant: 'thumbnail' | 'full'): ImageState {
    const [state, setState] = useState<ImageState>({ status: 'loading' });
    useEffect(() => {
        if (!path) return;
        let cancelled = false;
        setState({ status: 'loading' });
        const api = window.electronAPI;
        if (!api?.getMeetingScreenshotImage) {
            setState({ status: 'missing' });
            return;
        }
        api.getMeetingScreenshotImage(path, variant)
            .then(res => {
                if (cancelled) return;
                setState(res?.success && res.dataUrl ? { status: 'ready', src: res.dataUrl } : { status: 'missing' });
            })
            .catch(() => { if (!cancelled) setState({ status: 'missing' }); });
        return () => { cancelled = true; };
    }, [path, variant]);
    return state;
}

const Thumbnail: React.FC<{ shot: MeetingScreenshotEntry; onOpen: () => void; label: string }> = ({ shot, onOpen, label }) => {
    const t = useT();
    const image = useScreenshotImage(shot.path, 'thumbnail');
    return (
        <button
            type="button"
            onClick={onOpen}
            disabled={image.status === 'missing'}
            className="group text-left rounded-lg overflow-hidden border border-border-subtle bg-white/[0.03] hover:border-white/20 transition-colors disabled:cursor-default"
            title={image.status === 'missing' ? t('Screenshot file is no longer available') : label}
        >
            <div className="aspect-video w-full flex items-center justify-center bg-black/20">
                {image.status === 'ready' ? (
                    <img src={image.src} alt={label} className="w-full h-full object-cover" draggable={false} />
                ) : image.status === 'missing' ? (
                    <ImageOff className="w-5 h-5 text-text-tertiary" />
                ) : null}
            </div>
            <div className="px-2 py-1.5 flex items-center justify-between gap-2">
                <span className="text-[11px] font-mono text-text-tertiary">{formatClock(shot.timestamp)}</span>
                {shot.captureKind === 'selective' && (
                    <span className="text-[10px] text-text-tertiary">{t('Selection')}</span>
                )}
            </div>
        </button>
    );
};

const PreviewModal: React.FC<{ shot: MeetingScreenshotEntry; onClose: () => void }> = ({ shot, onClose }) => {
    const t = useT();
    const image = useScreenshotImage(shot.path, 'full');
    const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const handleSave = useCallback(async () => {
        const api = window.electronAPI;
        if (!api?.saveMeetingScreenshotAs) return;
        setSaveState('saving');
        try {
            const res = await api.saveMeetingScreenshotAs(shot.path, shot.timestamp);
            setSaveState(res?.success ? 'saved' : res?.error === 'cancelled' ? 'idle' : 'failed');
        } catch {
            setSaveState('failed');
        }
    }, [shot.path, shot.timestamp]);

    return createPortal(
        <div
            className="fixed inset-0 z-[1000] bg-black/80 flex flex-col items-center justify-center p-6"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-label={t('Screenshot preview')}
        >
            <div className="w-full max-w-5xl flex items-center justify-between mb-3" onClick={e => e.stopPropagation()}>
                <span className="text-xs font-mono text-white/70">{formatClock(shot.timestamp)}</span>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={handleSave}
                        disabled={image.status !== 'ready' || saveState === 'saving'}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-white/10 hover:bg-white/20 text-white text-xs font-medium transition-colors disabled:opacity-40"
                    >
                        <Download className="w-3.5 h-3.5" />
                        {saveState === 'saved' ? t('Saved') : saveState === 'failed' ? t('Save failed') : t('Save as…')}
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
                        title={t('Close')}
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
            </div>
            <div className="max-w-5xl w-full flex-1 min-h-0 flex items-center justify-center" onClick={e => e.stopPropagation()}>
                {image.status === 'ready' ? (
                    <img src={image.src} alt={t('Screenshot preview')} className="max-w-full max-h-full object-contain rounded-md" draggable={false} />
                ) : image.status === 'missing' ? (
                    <p className="text-sm text-white/70">{t('Screenshot file is no longer available')}</p>
                ) : null}
            </div>
        </div>,
        document.body,
    );
};

const MeetingScreenshots: React.FC<{ screenshots: MeetingScreenshotEntry[] }> = ({ screenshots }) => {
    const t = useT();
    const [openIndex, setOpenIndex] = useState<number | null>(null);
    const close = useCallback(() => setOpenIndex(null), []);

    if (screenshots.length === 0) {
        return <p className="text-text-tertiary">{t('No screenshots were taken in this meeting.')}</p>;
    }

    return (
        <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {screenshots.map((shot, i) => (
                    <Thumbnail
                        key={`${shot.path}-${i}`}
                        shot={shot}
                        label={t('Open screenshot')}
                        onOpen={() => setOpenIndex(i)}
                    />
                ))}
            </div>
            {openIndex !== null && screenshots[openIndex] && (
                <PreviewModal shot={screenshots[openIndex]} onClose={close} />
            )}
        </>
    );
};

export default MeetingScreenshots;
