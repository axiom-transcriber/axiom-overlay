import { useCallback, useEffect, useRef, useState } from 'react';
import Groq from 'groq-sdk';
import { startSession, completeSession, openSuggestStream } from '../lib/api';

// ── Types ────────────────────────────────────────────────────────────────────

interface TranscriptEntry {
    id: number;
    text: string;
    ts: number;
}

interface SuggestionChunk {
    id: number;
    text: string;
    done: boolean;
}

interface Props {
    token: string;
    authToken: string;
    onEnd: () => void;
}

// ── Constants ────────────────────────────────────────────────────────────────

// Duration of each sequential audio recording chunk (ms)
const RECORD_CHUNK_MS = 3500;
// Max recent transcript text to send as context with each suggest call
const RECENT_CONTEXT_CHARS = 1200;
// Min transcript chars in a chunk before triggering a suggest call
const MIN_CHUNK_FOR_SUGGEST = 15;

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildRecentContext(entries: TranscriptEntry[]): string {
    const all = entries.map(e => e.text).join(' ');
    return all.length > RECENT_CONTEXT_CHARS ? all.slice(-RECENT_CONTEXT_CHARS) : all;
}

// Strip silence hallucinations and foreign script transliterations
function cleanWhisperArtifacts(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return '';
    const lower = trimmed.toLowerCase().replace(/[^\w\s]/g, '');
    const hallucinations = [
        'thank you', 'thanks for watching', 'thank you for watching',
        'obrigado', 'subtitles by', 'bye', 'you', 'thank you very much',
        'thank you bye'
    ];
    if (hallucinations.includes(lower)) return '';
    // Discard chunks with zero Latin characters (e.g. Hindi/Urdu/Arabic hallucinations from background hiss)
    const latinCount = (trimmed.match(/[a-zA-Z]/g) || []).length;
    if (latinCount === 0 && trimmed.length > 3) return '';
    // Eliminate repeated words like "word word word"
    return trimmed.replace(/\b(\w+)(?:\s+\1\b){2,}/gi, '$1');
}

// ── Component ────────────────────────────────────────────────────────────────

export default function LiveSession({ token, authToken, onEnd }: Props) {
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [roundNumber, setRoundNumber] = useState<number | null>(null);
    const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
    const [suggestions, setSuggestions] = useState<SuggestionChunk[]>([]);
    const [status, setStatus] = useState<'starting' | 'live' | 'stopping' | 'done'>('starting');
    const [error, setError] = useState('');
    const [captureMode, setCaptureMode] = useState<'both' | 'system'>('both');
    const captureModeRef = useRef<'both' | 'system'>('both');

    // Keep captureModeRef in sync
    useEffect(() => {
        captureModeRef.current = captureMode;
    }, [captureMode]);

    const authTokenRef = useRef(authToken);
    useEffect(() => {
        authTokenRef.current = authToken;
    }, [authToken]);

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const entryIdRef = useRef(0);
    const suggestionIdRef = useRef(0);
    const sessionIdRef = useRef<string | null>(null);
    const transcriptRef = useRef<TranscriptEntry[]>([]);
    const suggestActiveRef = useRef(false);
    const transcriptBottomRef = useRef<HTMLDivElement>(null);

    const currentReaderRef = useRef<ReadableStreamDefaultReader<string> | null>(null);
    const suggestTimeoutRef = useRef<any>(null);

    const groqRef = useRef<Groq>(new Groq({
        apiKey: import.meta.env.VITE_GROQ_API_KEY as string,
        dangerouslyAllowBrowser: true,
    }));

    // Keep transcriptRef in sync
    useEffect(() => { transcriptRef.current = transcript; }, [transcript]);
    useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

    // Auto-scroll transcript
    useEffect(() => {
        transcriptBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [transcript]);

    // ── Transcribe a blob chunk via Groq Whisper ──────────────────────────────
    const transcribeChunk = useCallback(async (blob: Blob) => {
        if (blob.size < 1200) return; // skip near-empty buffers
        try {
            const file = new File([blob], 'chunk.webm', { type: blob.type });
            const result = await groqRef.current.audio.transcriptions.create({
                file,
                model: 'whisper-large-v3-turbo',
                response_format: 'text',
                language: 'en',
                temperature: 0,
                prompt: 'Software engineering interview and meeting discussion in English.',
            });
            const raw = (result as unknown as string).trim();
            const text = cleanWhisperArtifacts(raw);
            if (!text) return;

            const entry: TranscriptEntry = { id: entryIdRef.current++, text, ts: Date.now() };
            setTranscript(prev => [...prev, entry]);
            return text;
        } catch (err) {
            console.error('Transcription error', err);
        }
    }, []);

    // ── Stream suggestions for a transcript chunk ─────────────────────────────
    const fetchSuggestion = useCallback(async (chunkText: string) => {
        const sid = sessionIdRef.current;
        if (!sid) return;

        // Abort previous in-flight suggestion if fresh speech arrived
        if (currentReaderRef.current) {
            try { await currentReaderRef.current.cancel(); } catch {}
            currentReaderRef.current = null;
        }

        const recentContext = buildRecentContext(transcriptRef.current.slice(-20));
        const id = suggestionIdRef.current++;
        setSuggestions(prev => [...prev.slice(-3), { id, text: '', done: false }]);

        try {
            const reader = await openSuggestStream(sid, chunkText, recentContext, authTokenRef.current);
            currentReaderRef.current = reader;
            let accumulated = '';
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                // Parse SSE lines
                const lines = value.split('\n');
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();
                        if (data === '[DONE]') break;
                        try {
                            const parsed = JSON.parse(data);
                            const delta = parsed.token ?? parsed.choices?.[0]?.delta?.content ?? '';
                            if (delta) {
                                accumulated += delta;
                                setSuggestions(prev =>
                                    prev.map(s => s.id === id ? { ...s, text: accumulated } : s)
                                );
                            }
                        } catch { /* skip non-JSON lines */ }
                    }
                }
            }
            setSuggestions(prev =>
                prev.map(s => s.id === id ? { ...s, done: true } : s)
            );
        } catch (err: any) {
            if (err?.name !== 'AbortError') {
                console.error('Suggest stream error', err);
            }
        } finally {
            if (currentReaderRef.current) {
                currentReaderRef.current = null;
            }
        }
    }, []);

    const isRecordingRef = useRef(false);
    const recordersRef = useRef<Set<MediaRecorder>>(new Set());

    const streamRef = useRef<MediaStream | null>(null);

    const cleanupAudio = useCallback(() => {
        if (suggestTimeoutRef.current) clearTimeout(suggestTimeoutRef.current);
        if (currentReaderRef.current) {
            try { currentReaderRef.current.cancel(); } catch {}
            currentReaderRef.current = null;
        }
        recordersRef.current.forEach(r => {
            if (r.state !== 'inactive') r.stop();
        });
        recordersRef.current.clear();
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop());
            streamRef.current = null;
        }
    }, []);

    // ── Start recording ───────────────────────────────────────────────────────
    const startRecording = useCallback(async (sid: string) => {
        let stream: MediaStream;
        try {
            const mode = captureModeRef.current;
            let systemStream: MediaStream | null = null;
            let micStream: MediaStream | null = null;

            // 1. Capture system audio if in Electron
            if (window.electronAPI?.getDesktopSources) {
                try {
                    const sources = await window.electronAPI.getDesktopSources();
                    const screenSource = sources.find(s => s.id.startsWith('screen:')) || sources[0];
                    if (screenSource) {
                        systemStream = await navigator.mediaDevices.getUserMedia({
                            audio: {
                                mandatory: {
                                    chromeMediaSource: 'desktop',
                                    chromeMediaSourceId: screenSource.id,
                                },
                            },
                            video: {
                                mandatory: {
                                    chromeMediaSource: 'desktop',
                                    chromeMediaSourceId: screenSource.id,
                                },
                            },
                        } as any);
                        systemStream.getVideoTracks().forEach(t => t.stop());
                    }
                } catch (err) {
                    console.error('System audio capture failed', err);
                }
            }

            // 2. Capture microphone with noise suppression and echo cancellation
            if (mode === 'both' || !systemStream) {
                try {
                    micStream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            echoCancellation: true,
                            noiseSuppression: true,
                            autoGainControl: true,
                        },
                        video: false,
                    });
                } catch (err) {
                    console.error('Microphone capture failed', err);
                }
            }

            // 3. Mix or use single stream
            if (systemStream && micStream) {
                const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
                const systemSource = audioContext.createMediaStreamSource(systemStream);
                const micSource = audioContext.createMediaStreamSource(micStream);
                const destination = audioContext.createMediaStreamDestination();
                
                systemSource.connect(destination);
                micSource.connect(destination);

                stream = destination.stream;

                // Stop underlying tracks when stream.getTracks() is called during cleanup
                const originalGetTracks = stream.getTracks.bind(stream);
                stream.getTracks = () => [
                    ...originalGetTracks(),
                    ...systemStream!.getTracks(),
                    ...micStream!.getTracks()
                ];
            } else {
                const selectedStream = systemStream || micStream;
                if (!selectedStream) {
                    throw new Error('No audio sources found');
                }
                stream = selectedStream;
            }

            streamRef.current = stream;
        } catch (err) {
            console.error('Audio capture permission/source error', err);
            setError('Audio capture failed. Please grant permission or check your audio sources.');
            return;
        }

        isRecordingRef.current = true;

        const recordCycle = () => {
            if (!isRecordingRef.current) return;
            
            const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
            recordersRef.current.add(recorder);
            const cycleChunks: Blob[] = [];

            // Setup audio activity check
            let audioContext: AudioContext | null = null;
            let source: MediaStreamAudioSourceNode | null = null;
            let analyser: AnalyserNode | null = null;
            let dataArray: Uint8Array | null = null;
            let hasSpeech = false;

            try {
                audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
                source = audioContext.createMediaStreamSource(stream);
                analyser = audioContext.createAnalyser();
                analyser.fftSize = 256;
                source.connect(analyser);
                dataArray = new Uint8Array(analyser.frequencyBinCount);
            } catch (err) {
                console.error('AudioContext setup error', err);
            }

            const checkVolume = () => {
                if ((recorder.state as string) === 'inactive' || !analyser || !dataArray) return;
                analyser.getByteFrequencyData(dataArray as any);
                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    sum += dataArray[i];
                }
                const average = sum / dataArray.length;
                // Voice activity: background mic hiss is < 5; true speech is >= 12
                if (average >= 12) {
                    hasSpeech = true;
                }
                if ((recorder.state as string) !== 'inactive') {
                    requestAnimationFrame(checkVolume);
                }
            };
            if (audioContext) {
                requestAnimationFrame(checkVolume);
            }

            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) cycleChunks.push(e.data);
            };

            recorder.onstop = async () => {
                recordersRef.current.delete(recorder);
                if (source) {
                    try { source.disconnect(); } catch {}
                }
                if (audioContext) {
                    try { audioContext.close(); } catch {}
                }

                // Immediately start the next non-overlapping chunk
                if (isRecordingRef.current) {
                    recordCycle();
                }

                // Skip silence and ambient hum
                if (!hasSpeech) {
                    return;
                }

                if (cycleChunks.length > 0) {
                    const blob = new Blob(cycleChunks, { type: 'audio/webm;codecs=opus' });
                    const text = await transcribeChunk(blob);
                    if (text && text.length >= MIN_CHUNK_FOR_SUGGEST) {
                        if (suggestTimeoutRef.current) clearTimeout(suggestTimeoutRef.current);
                        suggestTimeoutRef.current = setTimeout(() => {
                            fetchSuggestion(text);
                        }, 800);
                    }
                }
            };

            recorder.start();

            // Stop this recorder after exactly RECORD_CHUNK_MS to cycle cleanly
            setTimeout(() => {
                if (recorder.state !== 'inactive') recorder.stop();
            }, RECORD_CHUNK_MS);
        };

        // Start the first non-overlapping cycle
        recordCycle();

        setStatus('live');
    }, [transcribeChunk, fetchSuggestion]);

    // ── Init: start session on server, then start recording ──────────────────
    useEffect(() => {
        let cancelled = false;
        startSession(token, authTokenRef.current).then(({ session_id, round_number }) => {
            if (cancelled) return;
            setSessionId(session_id);
            setRoundNumber(round_number);
            startRecording(session_id);
        }).catch(err => {
            if (!cancelled) setError(`Failed to start session: ${err.message}`);
        });
        return () => {
            cancelled = true;
            cleanupAudio();
        };
    }, [token, startRecording, cleanupAudio]);

    // Restart recording if captureMode changes during live session
    useEffect(() => {
        if (status === 'live' && sessionId) {
            cleanupAudio();
            startRecording(sessionId);
        }
    }, [captureMode, status, sessionId, cleanupAudio, startRecording]);

    // ── Stop session ──────────────────────────────────────────────────────────
    const handleStop = useCallback(async () => {
        setStatus('stopping');
        isRecordingRef.current = false;
        cleanupAudio();

        const sid = sessionIdRef.current;
        const fullText = transcriptRef.current.map(e => e.text).join(' ');
        if (sid && fullText) {
            await completeSession(sid, fullText, null, authTokenRef.current).catch(console.error);
        }

        setStatus('done');
        onEnd();
    }, [onEnd, cleanupAudio]);

    // ── Render ────────────────────────────────────────────────────────────────

    if (error) return (
        <div className="center-msg">
            <div className="error-msg">{error}</div>
            <button onClick={onEnd}>Back</button>
        </div>
    );

    if (status === 'starting') return <div className="center-msg">Starting session…</div>;

    return (
        <div className="live-session">
            {/* Header */}
            <div className="session-header">
                <div className="session-info">
                    <span className="live-dot" />
                    <span className="live-label">LIVE</span>
                    {roundNumber !== null && <span className="round-badge">R{roundNumber}</span>}
                </div>

                <div style={{ display: 'flex', gap: '4px', background: 'rgba(255,255,255,0.06)', padding: '2px', borderRadius: '6px', fontSize: '11px', border: '1px solid var(--border)', WebkitAppRegion: 'no-drag' } as any}>
                    <button
                        style={{
                            background: captureMode === 'both' ? 'var(--accent)' : 'transparent',
                            color: captureMode === 'both' ? '#fff' : 'var(--muted)',
                            padding: '3px 8px',
                            fontSize: '10px',
                            borderRadius: '4px',
                            fontWeight: 600,
                            border: 'none',
                        }}
                        onClick={() => setCaptureMode('both')}
                    >
                        Dual
                    </button>
                    <button
                        style={{
                            background: captureMode === 'system' ? 'var(--accent)' : 'transparent',
                            color: captureMode === 'system' ? '#fff' : 'var(--muted)',
                            padding: '3px 8px',
                            fontSize: '10px',
                            borderRadius: '4px',
                            fontWeight: 600,
                            border: 'none',
                        }}
                        onClick={() => setCaptureMode('system')}
                    >
                        System
                    </button>
                </div>
                <button
                    className="stop-btn"
                    onClick={handleStop}
                    disabled={status === 'stopping'}
                >
                    {status === 'stopping' ? 'Saving…' : 'End'}
                </button>
            </div>

            {/* Two-pane layout */}
            <div className="session-body">
                {/* Left: Transcript */}
                <div className="transcript-pane">
                    <div className="pane-label">Transcript</div>
                    <div className="transcript-scroll">
                        {transcript.length === 0 && (
                            <div className="muted empty-state">Listening…</div>
                        )}
                        {transcript.map(entry => (
                            <div key={entry.id} className="transcript-entry">
                                {entry.text}
                            </div>
                        ))}
                        <div ref={transcriptBottomRef} />
                    </div>
                </div>

                {/* Right: AI Suggestions */}
                <div className="suggestions-pane">
                    <div className="pane-label">AI Assist</div>
                    <div className="suggestions-scroll">
                        {suggestions.length === 0 && (
                            <div className="muted empty-state">Suggestions appear as you speak…</div>
                        )}
                        {suggestions.map(s => (
                            <div key={s.id} className={`suggestion-card ${s.done ? 'done' : 'streaming'}`}>
                                {s.text || <span className="muted">…</span>}
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
