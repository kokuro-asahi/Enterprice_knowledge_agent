import type { ToolData } from '../types';

const formatValue = (value: unknown) => Array.isArray(value) ? value.join(', ') : String(value);
function Arguments({ args }: { args: Record<string, unknown> }) {
  const options = Object.entries(args).filter(([key]) => key !== 'query');
  return <><p className="tool-query">搜索：{formatValue(args.query || '未提供搜索词')}</p>
    {options.length > 0 && <p className="tool-meta">{options.map(([key, value]) => `${key}: ${formatValue(value)}`).join(' · ')}</p>}</>;
}
const safeUrl = (value?: string) => value && /^https?:\/\//i.test(value) ? value : undefined;
export function ToolCard({ data, status }: { data: ToolData; status: string }) {
  const search = data.tool_type === 'bocha_search' || data.tool_type === 'search_enterprise_policy';
  if (!search) {
    const labels = data.tool_type === 'read_file' ? ['正在读取参考资料', '已读取参考资料'] :
      !data.tool_type || data.tool_type === 'unknown_tool' ? ['正在准备工具', '工具已完成'] : ['正在使用辅助工具', '辅助工具已完成'];
    return <div className={`tool-activity ${status === 'failed' ? 'failed' : ''}`}>· {status === 'failed' ? data.error?.message || '辅助工具调用失败' : labels[status === 'running' ? 0 : 1]}</div>;
  }
  const name = data.tool_type === 'bocha_search' ? '联网搜索' : '企业制度知识库';
  const results = data.result?.results || [];
  return <article className={`message tool tool-search ${status === 'failed' ? 'error' : ''}`}>
    <div className="message-role">{name} · {status === 'running' ? '搜索中' : status === 'failed' ? '搜索失败' : '搜索完成'}</div>
    <details className="tool-details"><summary>{status === 'running' ? '查看搜索内容' : status === 'failed' ? '查看失败详情' : '查看搜索结果'}</summary>
      <div className="tool-result">{status === 'running' ? <Arguments args={data.arguments || {}} /> : status === 'failed' ? <p>{data.error?.message || '工具调用失败'}</p> : <>
        {data.result?.query && <Arguments args={{ query: data.result.query }} />}
        {!results.length ? <p>没有返回可展示的检索结果。</p> : <ol className="search-results">{results.map((result, index) => <li key={index}>
          <strong>{result.title || '未命名结果'}</strong>
          {data.tool_type === 'bocha_search' && safeUrl(result.url) ? <a href={safeUrl(result.url)} target="_blank" rel="noopener noreferrer">{result.site_name || result.url}</a> :
            <span className="tool-meta">{[result.source_article, result.source_pages?.length ? `页码：${result.source_pages.join(', ')}` : '', result.file_id].filter(Boolean).join(' · ')}</span>}
          {(result.snippet || result.content) && <p>{result.snippet || result.content}</p>}
        </li>)}</ol>}
      </>}</div>
    </details>
  </article>;
}
