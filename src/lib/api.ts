// All calls to the Axiom web API — auth token is always attached.
import { supabase } from './supabase';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://axiomtranscriber.vercel.app';

export async function apiFetch(path: string, options: RequestInit = {}, token?: string) {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string> || {}),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
    if (!res.ok) {
        if (res.status === 401) {
            console.warn('[Overlay API] 401 Unauthorized — user deleted or session invalid. Signing out...');
            await supabase.auth.signOut();
        }
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
}

// Fetch meeting context + past rounds for a given token
export async function fetchMeetingContext(token: string, authToken: string) {
    return apiFetch(`/api/context/${token}`, {}, authToken);
}

// Fetch user's active meetings list
export async function fetchMeetings(authToken: string) {
    return apiFetch('/api/meetings', {}, authToken);
}

// Start a session (tells server a live session is beginning)
export async function startSession(token: string, authToken: string): Promise<{ session_id: string; round_number: number }> {
    return apiFetch('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ action: 'start', token, source: 'overlay' }),
    }, authToken);
}

// Submit completed session transcript
export async function completeSession(
    sessionId: string,
    transcriptText: string,
    diarizedSegments: any[] | null,
    authToken: string,
) {
    return apiFetch('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
            action: 'complete',
            session_id: sessionId,
            transcript_text: transcriptText,
            diarized_segments: diarizedSegments,
        }),
    }, authToken);
}

// Stream real-time suggestion via SSE
// Returns an EventSource — caller handles tokens and [DONE]
export function openSuggestStream(
    sessionId: string,
    transcriptChunk: string,
    recentContext: string,
    authToken: string,
): Promise<ReadableStreamDefaultReader<string>> {
    return fetch(`${BASE_URL}/api/suggest`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({ session_id: sessionId, transcript_chunk: transcriptChunk, recent_context: recentContext }),
    }).then(res => {
        if (!res.ok || !res.body) throw new Error('Suggest stream failed');
        return res.body.pipeThrough(new TextDecoderStream()).getReader();
    });
}
