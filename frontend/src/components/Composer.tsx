import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { Conversation } from '../conversation';

export function Composer({ conversation, busy, loading, locked, resetKey }: { conversation: Conversation; busy: boolean; loading: boolean; locked: boolean; resetKey: number }) {
  const [text, setText] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [showImage, setShowImage] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setText(''); setImageUrl(''); ref.current?.focus(); }, [resetKey]);
  useLayoutEffect(() => {
    if (ref.current) { ref.current.style.height = 'auto'; ref.current.style.height = `${Math.min(ref.current.scrollHeight, 160)}px`; }
  }, [text]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || loading || locked || (!text.trim() && !imageUrl.trim())) return;
    const error = conversation.validate();
    if (error) { conversation.addError(error); return; }
    void conversation.send(text, imageUrl);
    setText(''); setImageUrl('');
  };
  return <form id="composer" className="composer" onSubmit={submit}>
    <div className="composer-box"><textarea ref={ref} id="prompt" rows={1} placeholder="给 Agent 发送消息…" aria-label="消息内容" value={text} onChange={event => setText(event.target.value)} disabled={locked || loading}
      onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
      <div className="composer-tools"><div className="composer-tools-left">
        <button className="tool-button" type="button" aria-label="添加附件" disabled title="暂不支持本地附件">＋</button>
        <button id="imageToggle" className="tool-button image-tool" type="button" aria-label="添加图片链接" aria-expanded={showImage} disabled={locked} onClick={() => { setShowImage(!showImage); if (!showImage) requestAnimationFrame(() => imageRef.current?.focus()); }}>▧</button>
        <button className="mode-chip" type="button" disabled>深度思考 <span>⌄</span></button>
      </div><div className="composer-tools-right"><span className="shortcut-hint">⌘ ↵ 发送</span><button id="send" type="submit" aria-label="发送消息" disabled={busy || loading || locked}>↑</button></div></div>
    </div>
    <input ref={imageRef} id="imageUrl" className={`image-url ${showImage ? 'show' : ''}`} placeholder="粘贴图片 URL 后发送" aria-label="图片 URL" autoComplete="off" value={imageUrl} onChange={event => setImageUrl(event.target.value)} disabled={locked || loading} />
    <p className="composer-hint">Agent 可能会出错，请核对重要信息。</p>
  </form>;
}
