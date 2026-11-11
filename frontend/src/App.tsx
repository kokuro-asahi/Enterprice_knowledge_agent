import { useEffect, useState, useSyncExternalStore } from 'react';
import { Conversation } from './conversation';
import { Session } from './session';
import { LEVELS, ROLES, STATUS, type User } from './types';
import { Accounts } from './components/Accounts';
import { Composer } from './components/Composer';
import { Login } from './components/Login';
import { Messages } from './components/Messages';
import { Settings } from './components/Settings';
import { TaskPlan } from './components/TaskPlan';

export function App({ session }: { session: Session }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => { void session.restore(); }, [session]);
  return state.user ? <Workspace key={state.revision} session={session} user={state.user} /> : <main className="shell"><Login session={session} /></main>;
}
function Workspace({ session, user }: { session: Session; user: User }) {
  const auth = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [conversation] = useState(() => new Conversation(session.api));
  const state = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [draftRevision, setDraftRevision] = useState(0);
  useEffect(() => { void conversation.initialize(); return () => conversation.dispose(); }, [conversation]);
  const newThread = () => { if (!auth.loggingOut) { conversation.newThread(); setDraftRevision(value => value + 1); } };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !adminOpen && !auth.loggingOut) { event.preventDefault(); newThread(); }
      if (event.key === 'Escape' && settingsOpen) { setSettingsOpen(false); document.getElementById('settingsTop')?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [adminOpen, settingsOpen, auth.loggingOut]);
  const disabled = auth.loggingOut || state.busy || state.loadingHistory;
  return <main className="shell">
    <aside className="app-sidebar" aria-label="工作区导航" inert={adminOpen || auth.loggingOut}>
      <header className="sidebar-brand"><div className="rancy-mark"><span>✦</span><i /><i /></div><div className="brand-copy"><strong>rancy_agent</strong></div></header>
      <button id="topNewThread" className="new-chat" type="button" onClick={newThread} disabled={auth.loggingOut}><span>＋</span> 新建对话 <kbd>⌘ K</kbd></button>
      <nav className="conversation-nav" aria-label="对话列表"><div className="nav-heading"><span>最近对话</span><button type="button" aria-label="刷新对话" onClick={() => void conversation.loadThreads()}>↻</button></div>
        {state.threadsError ? <div className="conversation" role="status">{state.threadsError}</div> : !state.threads.length ? <div className="conversation">暂无对话历史</div> : state.threads.map(thread =>
          <button key={thread.thread_id} type="button" className={`conversation ${state.threadId === thread.thread_id ? 'active' : ''}`} aria-current={state.threadId === thread.thread_id ? 'true' : undefined} onClick={() => { void conversation.openThread(thread); setDraftRevision(value => value + 1); }}>
            <span className="conversation-dot teal" /><span>{thread.title || '新的 Agent 对话'}</span>
          </button>)}
      </nav>
      <footer className="sidebar-footer"><div className="account-button account-summary"><span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span><span><strong>{user.username}</strong><small>{LEVELS[user.access_level]}{user.is_admin ? ' · 管理员' : ''}</small></span></div></footer>
    </aside>
    <section className="workspace" inert={adminOpen || auth.loggingOut}>
      <header className="topbar"><div className="agent-identity"><div className="agent-orb"><span>✦</span></div><div>
        <label className="topbar-agent-selector"><select id="topbarAgentRole" aria-label="选择 Agent 角色" value={state.role} disabled={disabled || Boolean(state.threadId.trim())} onChange={event => conversation.configure({ role: event.target.value })}>{ROLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <span><i id="statusDot" style={{ background: ['failed', 'offline'].includes(state.status) ? '#e16d68' : state.busy ? '#dfaa44' : '#55bd88' }} /><em id="status" role="status">{STATUS[state.status] || state.status}</em></span>
      </div></div>
      <div className="topbar-actions">{user.is_admin && <button id="adminButton" className="auth-logout admin-entry" type="button" onClick={() => { setSettingsOpen(false); setAdminOpen(true); }}>账户管理</button>}
        <button id="logoutButton" className="auth-logout" type="button" disabled={auth.loggingOut} onClick={() => { conversation.reset(); void session.logout(); }}>退出登录</button>
        <button id="clearChat" className="round-button" type="button" aria-label="新建对话" onClick={newThread}>＋</button>
        <button id="settingsTop" className="top-settings" type="button" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(true)}>配置 Agent <span>⚙</span></button>
      </div></header>
      <div className="task-plan-slot"><TaskPlan todos={state.todos} status={state.planStatus} /></div>
      <Messages messages={state.messages} loading={state.loadingHistory} threadId={state.threadId} />
      <Composer conversation={conversation} busy={state.busy} loading={state.loadingHistory} locked={auth.loggingOut} resetKey={draftRevision} />
      {auth.error && <div className="workspace-error" role="alert">{auth.error}</div>}
    </section>
    <Settings conversation={conversation} user={user} open={settingsOpen} close={() => { setSettingsOpen(false); document.getElementById('settingsTop')?.focus(); }} newThread={newThread} locked={auth.loggingOut || adminOpen} />
    {adminOpen && user.is_admin && <Accounts session={session} user={user} onClose={() => setAdminOpen(false)} onError={message => conversation.addError(message)} />}
  </main>;
}
