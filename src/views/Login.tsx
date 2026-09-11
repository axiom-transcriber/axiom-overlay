import { useState } from 'react';
import { supabase } from '../lib/supabase';

export default function Login() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [googleLoading, setGoogleLoading] = useState(false);
    const [error, setError] = useState('');

    const isProcessing = loading || googleLoading;

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (isProcessing) return;
        setLoading(true);
        setError('');
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) setError(err.message);
        setLoading(false);
    }

    async function handleGoogleLogin() {
        if (isProcessing) return;
        setError('');
        setGoogleLoading(true);
        try {
            const apiBase = import.meta.env.VITE_API_BASE_URL || 'https://axiomtranscriber.vercel.app';
            const redirectUrl = `${apiBase}/auth/desktop-callback`;
            const { data, error: err } = await supabase.auth.signInWithOAuth({
                provider: 'google',
                options: {
                    redirectTo: redirectUrl,
                    skipBrowserRedirect: true,
                    queryParams: {
                        prompt: 'select_account',
                    },
                }
            });

            if (err) {
                setError(err.message);
                setGoogleLoading(false);
                return;
            }

            if (data?.url) {
                if (window.electronAPI) {
                    await window.electronAPI.openExternal(data.url);
                } else {
                    window.open(data.url, '_blank');
                }
            }
        } catch (e: any) {
            setError(e?.message || 'Google sign-in failed');
        } finally {
            setTimeout(() => {
                setGoogleLoading(false);
            }, 3000);
        }
    }

    return (
        <div className="login">
            <div className="login-header">
                <img src="./axiom-logo.png" alt="Axiom Logo" style={{ width: '48px', height: '48px', borderRadius: '10px', marginBottom: '10px' }} />
                <h1>Axiom Overlay</h1>
                <p>Sign in to your account</p>
            </div>
            <form onSubmit={handleSubmit}>
                <input
                    type="email"
                    placeholder="Email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    disabled={isProcessing}
                    required
                    autoFocus
                />
                <input
                    type="password"
                    placeholder="Password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    disabled={isProcessing}
                    required
                />
                {error && <div className="error-msg">{error}</div>}
                <button type="submit" disabled={isProcessing} style={{ opacity: isProcessing ? 0.65 : 1, cursor: isProcessing ? 'not-allowed' : 'pointer' }}>
                    {loading ? 'Signing in…' : 'Sign In'}
                </button>

                <div style={{ margin: '14px 0', textAlign: 'center', fontSize: '0.75rem', color: '#94a3b8' }}>
                    OR
                </div>

                <button
                    type="button"
                    onClick={handleGoogleLogin}
                    disabled={isProcessing}
                    style={{
                        background: '#ffffff',
                        color: '#0f172a',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px',
                        fontWeight: 600,
                        border: '1px solid #cbd5e1',
                        cursor: isProcessing ? 'not-allowed' : 'pointer',
                        opacity: isProcessing ? 0.65 : 1,
                        padding: '10px',
                        borderRadius: '8px',
                        width: '100%',
                        transition: 'opacity 0.15s',
                    }}
                >
                    <svg width="18" height="18" viewBox="0 0 24 24">
                        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                        <path fill="#FBBC05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.62z"/>
                        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
                    </svg>
                    <span>{googleLoading ? 'Connecting to Google…' : 'Sign in with Google'}</span>
                </button>
            </form>
        </div>
    );
}
