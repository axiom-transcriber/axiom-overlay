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

// Duration of each audio chunk (how long each recorder runs)
const RECORD_DURATION_MS = 6000;
// Interval between starting new chunks (creates a 50% overlap)
const RECORD_INTERVAL_MS = 3000;
// Max recent transcript text to send as context with each suggest call
const RECENT_CONTEXT_CHARS = 1200;
// Min transcript chars in a chunk before triggering a suggest call
const MIN_CHUNK_FOR_SUGGEST = 30;

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildRecentContext(entries: TranscriptEntry[]): string {
    const all = entries.map(e => e.text).join(' ');
    return all.length > RECENT_CONTEXT_CHARS ? all.slice(-RECENT_CONTEXT_CHARS) : all;
}

// Deduplicate overlapping words from adjacent Whisper chunks
function mergeTranscripts(existingText: string, incomingText: string): string {
    if (!existingText) return incomingText;
    
    const existingWords = existingText.trim().split(/\s+/);
    const incomingWords = incomingText.trim().split(/\s+/);
    
    const maxOverlap = Math.min(20, existingWords.length, incomingWords.length);
    let bestOverlap = 0;
    
    for (let overlap = 1; overlap <= maxOverlap; overlap++) {
        const tail = existingWords.slice(-overlap).join(' ').replace(/[^\w\s]/g, '').toLowerCase();
        const head = incomingWords.slice(0, overlap).join(' ').replace(/[^\w\s]/g, '').toLowerCase();
        
        if (tail === head) {
            bestOverlap = overlap;
        }
    }
    
    if (bestOverlap > 0) {
        return existingWords.join(' ') + ' ' + incomingWords.slice(bestOverlap).join(' ');
    }
    return existingText + ' ' + incomingText;
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
        if (blob.size < 1000) return; // skip near-empty chunks
        try {
            const file = new File([blob], 'chunk.webm', { type: blob.type });
            const result = await groqRef.current.audio.transcriptions.create({
                file,
                model: 'whisper-large-v3-turbo',
                response_format: 'text',
            });
            const text = (result as unknown as string).trim();
            if (!text) return;

            const entry: TranscriptEntry = { id: entryIdRef.current++, text, ts: Date.now() };
            setTranscript(prev => {
                if (prev.length === 0) return [entry];
                // Instead of appending a new entry every time, we merge into the last entry to keep the transcript clean
                const last = prev[prev.length - 1];
                const mergedText = mergeTranscripts(last.text, text);
                const updatedLast = { ...last, text: mergedText };
                return [...prev.slice(0, -1), updatedLast];
            });
            return text;
        } catch (err) {
            console.error('Transcription error', err);
        }
    }, []);

    // ── Stream suggestions for a transcript chunk ─────────────────────────────
    const fetchSuggestion = useCallback(async (chunkText: string) => {
        const sid = sessionIdRef.current;
        if (!sid || suggestActiveRef.current) return;
        suggestActiveRef.current = true;

        const recentContext = buildRecentContext(transcriptRef.current.slice(-20));
        const id = suggestionIdRef.current++;
        setSuggestions(prev => [...prev.slice(-4), { id, text: '', done: false }]);

        try {
            const reader = await openSuggestStream(sid, chunkText, recentContext, authTokenRef.current);
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
        } catch (err) {
            console.error('Suggest stream error', err);
            setSuggestions(prev => prev.filter(s => s.id !== id));
        } finally {
            suggestActiveRef.current = false;
        }
    }, []);

    const isRecordingRef = useRef(false);
    const recordersRef = useRef<Set<MediaRecorder>>(new Set());
    const intervalRef = useRef<any>(null);

    const streamRef = useRef<MediaStream | null>(null);

    const cleanupAudio = useCallback(() => {
        if (intervalRef.current) clearInterval(intervalRef.current);
        recordersRef.current.forEach(r => {
            if (r.state !== 'inactive') r.stop();
        });
        recordersRef.current.clear();
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop());
            streamRef.current = null;
        }
    }, []);

    const isRecordingRef = useRef(false);
    const recordersRef = useRef<Set<MediaRecorder>>(new Set());
    const intervalRef = useRef<any>(null);

    const cleanupAudio = useCallback(() => {
        if (intervalRef.current) clearInterval(intervalRef.current);
        recordersRef.current.forEach(r => {
            if (r.state !== 'inactive') r.stop();
        });
        recordersRef.current.clear();
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

            // 2. Capture microphone if mode is 'both' or system capture failed
            if (mode === 'both' || !systemStream) {
                try {
                    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
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

        const startChunk = () => {
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
                if (average > 1.5) {
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
                if (!hasSpeech) {
                    return;
                }
                if (cycleChunks.length > 0) {
                    const blob = new Blob(cycleChunks, { type: 'audio/webm;codecs=opus' });
                    const text = await transcribeChunk(blob);
                    if (text && text.length >= MIN_CHUNK_FOR_SUGGEST) {
                        fetchSuggestion(text);
                    }
                }
            };

            recorder.start();

            // Stop this recorder after exactly RECORD_DURATION_MS
            setTimeout(() => {
                if (recorder.state !== 'inactive') recorder.stop();
            }, RECORD_DURATION_MS);
        };

        // Start the first chunk immediately
        startChunk();

        // Start a new chunk every RECORD_INTERVAL_MS, creating overlap
        intervalRef.current = setInterval(startChunk, RECORD_INTERVAL_MS);

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
