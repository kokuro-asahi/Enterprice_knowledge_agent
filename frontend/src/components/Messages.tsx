import { memo, useLayoutEffect, useRef } from 'react';
import { renderMarkdown } from '../markdown';
import type { Message } from '../types';
import { ToolCard } from './ToolCard';

const MessageRow = memo(function MessageRow({ message }: { message: Message }) {
  if (message.role === 'tool') return <ToolCard data={message.data} status={message.status} />;
  return <article className={`message ${message.role}`}>
    <div className="message-role">{message.role}</div>
    <div className="message-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }} />
  </article>;
});
export function Messages({ messages, loading, threadId }: { messages: Message[]; loading: boolean; threadId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const latestUser = messages.findLast(message => message.role === 'user')?.id;
  useLayoutEffect(() => { follow.current = true; }, [threadId, loading]);
  useLayoutEffect(() => { if (latestUser) follow.current = true; }, [latestUser]);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node && follow.current) node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
  }, [messages]);
  return <div ref={ref} id="messages" className="messages" tabIndex={0} aria-label="对话消息" aria-busy={loading}
    onScroll={event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 4; }}
    onWheel={event => { if (event.deltaY < 0 && event.currentTarget.scrollHeight > event.currentTarget.clientHeight) follow.current = false; }}>
    {loading ? <div className="history-loading" role="status">正在加载历史消息…</div> : !messages.length ? <div className="empty">向我提问公司的请假、报销、审批流程或其他制度问题，我会检索已启用的制度资料并给出依据。</div> : messages.map(message => <MessageRow key={message.id} message={message} />)}
  </div>;
}
