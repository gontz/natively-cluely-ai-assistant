// src/components/knowledge/KnowledgeCitations.tsx
//
// Interview Knowledge "Sources" on an answer card, plus the viewer that opens
// the full source document of a citation (knowledge-doc:get).
//
// The list and the viewer talk through a window event rather than a prop, so
// NativelyInterface's memoised MessageRow needs no new callback prop (and no
// change to its equality check): a Sources entry dispatches
// OPEN_KNOWLEDGE_DOC_EVENT, and the single <KnowledgeDocViewer/> mounted at
// the interface root loads and shows the document.

import React, { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useT } from '../../i18n';

export interface KnowledgeCitation {
    sourceId: string;
    fileName: string;
    text: string;
}

export const OPEN_KNOWLEDGE_DOC_EVENT = 'natively:open-knowledge-doc';

/** Main already caps citation text; this is the renderer's own guard for a payload from an older main process. */
const CITATION_TEXT_MAX_CHARS = 600;

export function openKnowledgeDoc(sourceId: string): void {
    window.dispatchEvent(new CustomEvent(OPEN_KNOWLEDGE_DOC_EVENT, { detail: { sourceId } }));
}

export const KnowledgeCitationList: React.FC<{ citations: KnowledgeCitation[] }> = ({ citations }) => {
    const t = useT();
    if (!citations.length) return null;
    return (
        <details className="mt-1.5 text-[10px] opacity-70">
            <summary className="cursor-pointer select-none">
                {t('Sources')} ({citations.length})
            </summary>
            <div className="mt-1 space-y-1.5 max-w-[320px]">
                {citations.map((c, i) => {
                    const displayText = c.text.length > CITATION_TEXT_MAX_CHARS
                        ? `${c.text.slice(0, CITATION_TEXT_MAX_CHARS)}…`
                        : c.text;
                    return (
                        <div
                            key={`${c.sourceId}-${i}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => openKnowledgeDoc(c.sourceId)}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openKnowledgeDoc(c.sourceId); } }}
                            className="rounded border border-current/10 px-1.5 py-1 cursor-pointer hover:bg-current/5 hover:border-current/20 transition-colors"
                            title={t('Open source document')}
                        >
                            <div className="font-medium truncate underline decoration-dotted underline-offset-2">{c.fileName}</div>
                            <div className="opacity-80 line-clamp-3 whitespace-pre-wrap">{displayText}</div>
                        </div>
                    );
                })}
            </div>
        </details>
    );
};

interface OpenDoc { id: string; title: string; content: string; docType: string }

export const KnowledgeDocViewer: React.FC = () => {
    const t = useT();
    const [doc, setDoc] = useState<OpenDoc | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const close = useCallback(() => { setDoc(null); setError(null); setLoading(false); }, []);

    useEffect(() => {
        let requestSeq = 0;
        const onOpen = async (event: Event) => {
            const sourceId = (event as CustomEvent<{ sourceId?: string }>).detail?.sourceId;
            if (!sourceId) return;
            const seq = ++requestSeq;
            setDoc(null);
            setError(null);
            setLoading(true);
            try {
                const res = await window.electronAPI.knowledgeDocGet(sourceId);
                if (seq !== requestSeq) return; // a newer click won
                if (res?.success && res.doc) setDoc(res.doc);
                else setError(t('This document could not be found. It may have been deleted.'));
            } catch {
                if (seq === requestSeq) setError(t('This document could not be found. It may have been deleted.'));
            } finally {
                if (seq === requestSeq) setLoading(false);
            }
        };
        window.addEventListener(OPEN_KNOWLEDGE_DOC_EVENT, onOpen);
        return () => { requestSeq++; window.removeEventListener(OPEN_KNOWLEDGE_DOC_EVENT, onOpen); };
    }, [t]);

    useEffect(() => {
        if (!doc && !loading && !error) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [doc, loading, error, close]);

    if (!doc && !loading && !error) return null;
    return (
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 no-drag"
            onClick={close}
        >
            <div
                role="dialog"
                aria-modal="true"
                className="max-w-[560px] max-h-[80vh] w-[90vw] flex flex-col rounded-2xl border border-black/10 dark:border-white/10 bg-white dark:bg-neutral-900 shadow-xl overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-4 py-3 border-b border-black/10 dark:border-white/10">
                    <div className="min-w-0">
                        <div className="text-[13px] font-semibold truncate text-black/85 dark:text-white/85">
                            {doc?.title ?? t('Source document')}
                        </div>
                        {doc?.docType && doc.docType !== 'other' && (
                            <div className="text-[10px] uppercase tracking-wide opacity-50">{doc.docType}</div>
                        )}
                    </div>
                    <button
                        onClick={close}
                        className="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 text-black/50 dark:text-white/50 shrink-0"
                        title={t('Close')}
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto px-4 py-3">
                    {loading && <div className="text-[12px] opacity-60">{t('Loading…')}</div>}
                    {error && <div className="text-[12px] text-orange-600 dark:text-orange-400">{error}</div>}
                    {doc && !loading && (
                        <div className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-black/80 dark:text-white/75">
                            {doc.content}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
