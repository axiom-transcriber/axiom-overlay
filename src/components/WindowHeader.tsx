import { useState } from 'react';

export default function WindowHeader({ title = 'Axiom Overlay' }: { title?: string }) {
    const [showShortcuts, setShowShortcuts] = useState(false);
    const isMac = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';
    const modKey = isMac ? '⌘' : 'Ctrl';

    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            background: 'rgba(15, 23, 42, 0.95)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            WebkitAppRegion: 'drag',
            userSelect: 'none',
            borderTopLeftRadius: '12px',
            borderTopRightRadius: '12px',
            color: '#f8fafc',
            fontSize: '0.8rem',
            position: 'relative'
        } as any}>
            {/* Logo & Title */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <img src="./axiom-logo.png" alt="Axiom Logo" style={{ width: '18px', height: '18px', borderRadius: '4px' }} />
                <span style={{ fontWeight: 600, fontSize: '0.8rem', color: '#f8fafc', letterSpacing: '-0.01em' }}>{title}</span>
            </div>

            {/* Controls & Shortcuts Badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', WebkitAppRegion: 'no-drag' } as any}>
                <button
                    onClick={() => setShowShortcuts(!showShortcuts)}
                    title="View Keyboard Shortcuts"
                    style={{
                        background: showShortcuts ? 'rgba(99, 102, 241, 0.2)' : 'rgba(255, 255, 255, 0.06)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        color: showShortcuts ? '#818cf8' : '#94a3b8',
                        borderRadius: '6px',
                        padding: '2px 6px',
                        fontSize: '0.7rem',
                        cursor: 'pointer',
                        fontWeight: 600
                    }}
                >
                    ⌨️ Shortcuts
                </button>

                <button
                    onClick={() => window.electronAPI?.minimizeWindow()}
                    title="Minimize"
                    style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#94a3b8',
                        width: '24px',
                        height: '24px',
                        borderRadius: '6px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        fontSize: '1rem',
                        lineHeight: 1
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                    −
                </button>

                <button
                    onClick={() => window.electronAPI?.closeWindow()}
                    title="Hide / Close"
                    style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#94a3b8',
                        width: '24px',
                        height: '24px',
                        borderRadius: '6px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        fontSize: '0.85rem',
                        lineHeight: 1
                    }}
                    onMouseEnter={e => {
                        e.currentTarget.style.background = '#ef4444';
                        e.currentTarget.style.color = '#ffffff';
                    }}
                    onMouseLeave={e => {
                        e.currentTarget.style.background = 'transparent';
                        e.currentTarget.style.color = '#94a3b8';
                    }}
                >
                    ✕
                </button>
            </div>

            {/* Keyboard Shortcuts Popover */}
            {showShortcuts && (
                <div style={{
                    position: 'absolute',
                    top: '38px',
                    right: '12px',
                    width: '260px',
                    background: '#1e293b',
                    border: '1px solid #334155',
                    borderRadius: '10px',
                    padding: '12px',
                    boxShadow: '0 10px 25px rgba(0, 0, 0, 0.5)',
                    zIndex: 9999,
                    color: '#f8fafc',
                    fontSize: '0.75rem',
                    WebkitAppRegion: 'no-drag'
                } as any}>
                    <div style={{ fontWeight: 700, marginBottom: '8px', color: '#6366f1', display: 'flex', justifyContent: 'space-between' }}>
                        <span>Keyboard Shortcuts</span>
                        <span style={{ cursor: 'pointer', color: '#94a3b8' }} onClick={() => setShowShortcuts(false)}>✕</span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ color: '#94a3b8' }}>Hide / Show Overlay:</span>
                            <kbd style={{ background: '#0f172a', padding: '2px 6px', borderRadius: '4px', border: '1px solid #334155', fontFamily: 'monospace', fontSize: '0.7rem' }}>
                                {modKey} + Shift + Space
                            </kbd>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ color: '#94a3b8' }}>Move Window:</span>
                            <kbd style={{ background: '#0f172a', padding: '2px 6px', borderRadius: '4px', border: '1px solid #334155', fontFamily: 'monospace', fontSize: '0.7rem' }}>
                                {modKey} + Arrow Keys
                            </kbd>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
