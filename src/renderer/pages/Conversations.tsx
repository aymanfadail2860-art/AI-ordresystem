import { useEffect, useRef, useState } from 'react';
import { act, call, useQuery } from '../api';
import { AiModeBadge, Card, Empty, OrderStatusBadge, PageHeader, SimTag, ago, dateTime, kr } from '../components/ui';
import type { AiMode, Conversation, Customer, Message, Order } from '../../shared/types';
import type { Nav } from '../App';

interface Detail {
  conversation: Conversation;
  customer: Customer | null;
  messages: Message[];
  orders: Order[];
  smsCanObserveOutgoing: boolean;
}

export function Conversations({ nav }: { nav: Nav }) {
  const { data: list } = useQuery<Conversation[]>('conversations.list', {}, ['conversations', 'messages']);
  const [selected, setSelected] = useState<number | null>(nav.selected);
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  useEffect(() => setSelected(nav.selected), [nav.selected]);
  const shown = (list ?? []).filter((c) => filter === 'all' || c.aiMode !== 'ai_active' || c.unreadCount > 0);

  return (
    <>
      <PageHeader title="Kundesamtaler" subtitle="SMS-samtaler med kunder. Overtag en samtale for at stoppe AI'en med det samme." />
      <div className="tabs">
        <button className={`tab ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>Alle</button>
        <button className={`tab ${filter === 'attention' ? 'active' : ''}`} onClick={() => setFilter('attention')}>Kræver opmærksomhed</button>
      </div>
      <div className="split">
        <Card>
          {shown.length ? (
            <div className="list">
              {shown.map((c) => (
                <div key={c.id} className={`list-item ${selected === c.id ? 'active' : ''}`} onClick={() => setSelected(c.id)}>
                  <div className="row between">
                    <strong>{c.customerName ?? c.customerPhone}</strong>
                    <span className="muted small">{ago(c.lastMessageAt)}</span>
                  </div>
                  <div className="truncate muted">{c.lastMessagePreview ?? ''}</div>
                  <div className="row">
                    <AiModeBadge mode={c.aiMode} />
                    {c.activeOrderStatus && <OrderStatusBadge status={c.activeOrderStatus} />}
                    {c.unreadCount > 0 && <span className="badge accent">{c.unreadCount} ulæst</span>}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty>Ingen samtaler.</Empty>
          )}
        </Card>
        {selected ? <ConversationDetail id={selected} nav={nav} /> : <Card><Empty>Vælg en samtale.</Empty></Card>}
      </div>
    </>
  );
}

function ConversationDetail({ id, nav }: { id: number; nav: Nav }) {
  const { data } = useQuery<Detail>('conversations.get', { id }, ['conversations', 'messages', 'orders']);
  const [text, setText] = useState('');
  const chatRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void call('conversations.markRead', { id });
  }, [id, data?.messages.length]);
  useEffect(() => {
    chatRef.current?.scrollTo(0, chatRef.current.scrollHeight);
  }, [data?.messages.length]);
  if (!data) return <Card><Empty>Indlæser…</Empty></Card>;
  const { conversation: c, messages, orders } = data;
  const setMode = (mode: AiMode, reason: string) => void act(() => call('conversations.setMode', { id, mode, reason }));
  const send = async () => {
    if (!text.trim()) return;
    if (await act(() => call('conversations.sendStaffMessage', { id, text }))) setText('');
  };

  return (
    <div className="stack">
      <Card title={<>{c.customerName ?? c.customerPhone} <AiModeBadge mode={c.aiMode} /></>}>
        <div className="mode-bar">
          {c.aiMode === 'ai_active' ? (
            <>
              <button className="primary" onClick={() => setMode('manual', 'Overtaget af medarbejder')}>✋ Overtag samtale</button>
              <button onClick={() => setMode('ai_paused', 'Pauseret af medarbejder')}>Pausér AI</button>
            </>
          ) : (
            <button className="primary" onClick={() => setMode('ai_active', 'Genaktiveret af medarbejder')}>▶ Genaktivér AI</button>
          )}
          <span className="muted small">
            {c.modeReason ? `${c.modeReason}` : ''} {c.modeChangedAt ? `· ${dateTime(c.modeChangedAt)}` : ''}
          </span>
        </div>
        {c.aiMode !== 'ai_active' && (
          <div className="callout">
            AI'en sender ingen beskeder til denne kunde. Indgående beskeder registreres fortsat. Ved genaktivering besvares beskeder modtaget under overtagelsen ikke bagudrettet.
          </div>
        )}
        {!data.smsCanObserveOutgoing && (
          <div className="callout warn">Manuelle svar fra iPhonen kan ikke registreres automatisk med den aktuelle SMS-forbindelse. Overtag samtalen her, før du svarer fra iPhonen.</div>
        )}
        <div className="chat" ref={chatRef}>
          {messages.map((m) => (
            <div key={m.id} className={`bubble ${m.direction} ${m.author} ${m.status}`} title={m.error ?? ''}>
              {m.body}
              <div className="bubble-meta">
                {authorLabel(m)} · {dateTime(m.createdAt)}
                {m.direction === 'out' && ` · ${statusLabel(m.status)}`}
                {m.simulated && <SimTag />}
              </div>
              {m.status === 'uncertain' && (
                <div className="row" style={{ marginTop: 6 }}>
                  <span className="small">Kontrollér i Beskeder på iPhone:</span>
                  <button onClick={() => void act(() => call('messages.resolveUncertain', { id: m.id, wasSent: true }))}>Den blev sendt</button>
                  <button onClick={() => void act(() => call('messages.resolveUncertain', { id: m.id, wasSent: false }))}>Ikke sendt</button>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="composer">
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Skriv som medarbejder (samtalen overtages automatisk)…" onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && void send()} />
          <button className="primary" onClick={() => void send()}>Send</button>
        </div>
      </Card>
      <Card title="Tilknyttede ordrer">
        {orders.length ? (
          <table>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="clickable" onClick={() => nav.go('orders', o.id)}>
                  <td>#{o.id}</td>
                  <td><OrderStatusBadge status={o.status} /></td>
                  <td className="truncate">{o.lines.map((l) => `${l.quantity}× ${l.productName}`).join(', ')}</td>
                  <td className="num">{kr(o.totalOre)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Ingen ordrer.</Empty>
        )}
      </Card>
    </div>
  );
}

function authorLabel(m: Message) {
  if (m.direction === 'in') return 'Kunde';
  return { ai: 'AI', staff: 'Medarbejder', system: 'Automatisk', customer: 'Kunde' }[m.author];
}
function statusLabel(s: Message['status']) {
  return { queued: 'i kø', sending: 'sender…', sent: 'sendt', confirmed: 'bekræftet', uncertain: '⚠️ ukendt status', failed: 'fejlet', blocked: 'blokeret', received: '' }[s];
}
