import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { Session } from '../session';

export function Login({ session }: { session: Session }) {
  const { checking, busy, error } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!checking) usernameRef.current?.focus(); }, [checking]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (checking || busy || !username.trim() || !password) return;
    const value = password;
    setPassword('');
    await session.login(username, value);
    if (!session.getSnapshot().user) passwordRef.current?.focus();
  };
  return <div id="loginOverlay" className="login-overlay" role="dialog" aria-modal="true" aria-labelledby="loginTitle">
    <form id="loginForm" className="login-card" aria-busy={checking || busy} onSubmit={submit}>
      <div className="orb-mark"><i /><i /><i /></div><p>ORBiS WORKSPACE</p>
      <h1 id="loginTitle">登录你的工作区</h1><span>使用账号和密码登录，继续你的 Agent 对话。</span>
      <label htmlFor="loginUsername">账号<input ref={usernameRef} id="loginUsername" name="username" required maxLength={100} placeholder="请输入账号" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={e => setUsername(e.target.value)} disabled={checking || busy} /></label>
      <label htmlFor="loginPassword">密码<input ref={passwordRef} id="loginPassword" name="password" type="password" required maxLength={1024} placeholder="请输入密码" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} disabled={checking || busy} /></label>
      {error && <div className="login-error" role="alert">{error}</div>}
      <div className="login-status" role="status">{checking ? '正在检查登录状态…' : busy ? '正在验证账号…' : ''}</div>
      <button id="loginSubmit" type="submit" disabled={checking || busy}><span>{checking ? '正在检查…' : busy ? '正在登录…' : '登录工作区'}</span><b aria-hidden="true">→</b></button>
    </form>
  </div>;
}
