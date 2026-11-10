import { useState } from 'react';
import { act, call, toast, useQuery } from '../api';
import { Card, Empty, Field, Modal, PageHeader, SimTag, dateTime } from '../components/ui';
import type { ManagementCommand, ManagementRole, ManagementUser, Replenishment } from '../../shared/types';
import { MANAGEMENT_ROLE_LABELS } from '../../shared/types';
import { ReplenishmentCard } from './Replenishment';

interface Overview {
  users: ManagementUser[];
  commands: ManagementCommand[];
  messages: { id: number; chatId: string; direction: 'in' | 'out'; userName: string | null; body: string; status: string; simulated: boolean; createdAt: string }[];
  pendingConfirmations: ManagementCommand[];
  settings: { groupChatId: string; allowPrivateChats: boolean; confirmTimeoutMinutes: number };
}

const DECISION: Record<string, { label: string; tone: string }> = {
  answered: { label: 'Besvaret', tone: 'info' },
  executed: { label: 'Udført', tone: 'ok' },
  needs_confirmation: { label: 'Afventer bekræftelse', tone: 'warn' },
  cancelled: { label: 'Annulleret', tone: 'neutral' },
  expired: { label: 'Udløbet', tone: 'neutral' },
  denied: { label: 'Afvist (rettighed)', tone: 'danger' },
  failed: { label: 'Kunne ikke udføres', tone: 'danger' },
  rejected: { label: 'Ikke mulig', tone: 'warn' },
  clarify: { label: 'Opklarende spørgsmål', tone: 'neutral' },
};

/** Ledelsescenter: Telegram-ledelsesgruppen, godkendelser, kommandolog og rettigheder. */
export function ManagementCenter() {
  const [tab, setTab] = useState<'approvals' | 'log' | 'chat' | 'users'>('approvals');
  const { data } = useQuery<Overview>('management.overview', {}, ['management', 'settings']);
  const { data: info } = useQuery<{ mode: string }>('system.info', {}, ['settings']);
  const isDemo = info?.mode === 'demo';
  const { data: reps } = useQuery<{ active: Replenishment[] }>('replenishment.overview', {}, ['replenishment', 'inventory', 'logistics']);
  if (!data) return <Empty>Indlæser…</Empty>;
  const pendingReps = reps?.active.filter((r) => r.status === 'awaiting_management') ?? [];

  return (
    <>
      <PageHeader
        title="Ledelsescenter"
        subtitle="Ledelsesgruppen i Telegram fungerer som kontrolcenter. AI'en forstår instruktionen – alle tal hentes fra databasen, og handlinger går gennem forretningsreglerne."
      />
      {!data.settings.groupChatId && <div className="callout warn" style={{ marginBottom: 12 }}>Ingen ledelsesgruppe er konfigureret. Opfyldningsforslag kan stadig godkendes her.</div>}
      <div className="tabs">
        <button className={`tab ${tab === 'approvals' ? 'active' : ''}`} onClick={() => setTab('approvals')}>
          Godkendelser {pendingReps.length + data.pendingConfirmations.length ? `(${pendingReps.length + data.pendingConfirmations.length})` : ''}
        </button>
        <button className={`tab ${tab === 'log' ? 'active' : ''}`} onClick={() => setTab('log')}>Kommandoer og handlinger</button>
        <button className={`tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>Gruppechat</button>
        <button className={`tab ${tab === 'users' ? 'active' : ''}`} onClick={() => setTab('users')}>Ledere og rettigheder</button>
      </div>
      {tab === 'approvals' && (
        <div className="stack">
          {pendingReps.length ? pendingReps.map((r) => <ReplenishmentCard key={r.id} rep={r} />) : <Card title="Lageropfyldninger"><Empty>Ingen opfyldninger afventer godkendelse.</Empty></Card>}
          <Card title="Instruktioner der afventer bekræftelse i Telegram">
            {data.pendingConfirmations.length ? (
              <table>
                <tbody>
                  {data.pendingConfirmations.map((c) => (
                    <tr key={c.id}>
                      <td>{dateTime(c.createdAt)}</td>
                      <td>{c.userName}</td>
                      <td>{c.instruction}</td>
                      <td className="muted small">{c.result}</td>
                      {isDemo && c.userTelegramId?.startsWith('sim-') && (
                        <td>
                          <button className="primary" onClick={() => void act(() => call('demo.sendAsManager', { who: c.userTelegramId, data: `mgmt:${c.id}:confirm` }))}>Bekræft (demo)</button>{' '}
                          <button onClick={() => void act(() => call('demo.sendAsManager', { who: c.userTelegramId, data: `mgmt:${c.id}:cancel` }))}>Annullér</button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>Ingen.</Empty>
            )}
            <p className="muted small">Følsomme handlinger skal bekræftes af den leder, der gav instruktionen (eller en administrator) med knappen i Telegram.</p>
          </Card>
        </div>
      )}
      {tab === 'log' && (
        <Card title="Revisionsspor">
          <table>
            <thead>
              <tr><th>Tid</th><th>Bruger</th><th>Instruktion</th><th>Intention</th><th>Ordrer</th><th>Beslutning</th><th>Resultat</th></tr>
            </thead>
            <tbody>
              {data.commands.map((c) => (
                <tr key={c.id}>
                  <td>{dateTime(c.createdAt)}</td>
                  <td>{c.userName ?? <span className="muted">ukendt</span>}{c.confirmedBy && <div className="muted small">bekræftet: {c.confirmedBy}</div>}</td>
                  <td>{c.instruction}</td>
                  <td><code>{c.intent ?? '–'}</code></td>
                  <td>{c.affectedOrders.map((x) => '#' + x).join(', ')}</td>
                  <td><span className={`badge ${DECISION[c.decision]?.tone ?? 'neutral'}`}>{DECISION[c.decision]?.label ?? c.decision}</span></td>
                  <td className="muted small" style={{ maxWidth: 360, whiteSpace: 'pre-wrap' }}>{c.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.commands.length && <Empty>Ingen instruktioner endnu.</Empty>}
        </Card>
      )}
      {tab === 'chat' && (
        <Card title={`Ledelsesgruppe ${data.settings.groupChatId || ''}`}>
          <div className="chat" style={{ maxHeight: 640 }}>
            {data.messages.map((m) => (
              <div key={m.id} className={`bubble ${m.direction === 'in' ? 'in' : 'out system'}`}>
                {m.direction === 'in' && <strong>{m.userName}: </strong>}
                {m.body}
                <div className="bubble-meta">{dateTime(m.createdAt)}{m.simulated && <SimTag />}</div>
              </div>
            ))}
            {!data.messages.length && <Empty>Ingen beskeder.</Empty>}
          </div>
        </Card>
      )}
      {tab === 'users' && <UsersTab data={data} />}
    </>
  );
}

function UsersTab({ data }: { data: Overview }) {
  const [creating, setCreating] = useState(false);
  const [group, setGroup] = useState(data.settings.groupChatId);
  const [priv, setPriv] = useState(data.settings.allowPrivateChats);
  return (
    <div className="stack">
      <Card title="Ledelsesgruppe" actions={<button className="primary" onClick={() => void act(() => call('management.setGroup', { groupChatId: group, allowPrivateChats: priv })).then((ok) => ok && toast('Gemt'))}>Gem</button>}>
        <div className="form-grid">
          <Field label="Telegram-chat-ID for gruppen" hint="Tilføj botten til gruppen, slå privacy mode fra hos @BotFather (/setprivacy), og indsæt gruppens chat-ID (fx -1001234567890).">
            <input value={group} onChange={(e) => setGroup(e.target.value)} />
          </Field>
          <label className="row"><input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} /> Tillad registrerede ledere at skrive privat til botten</label>
        </div>
        <p className="muted small">Kun beskeder fra denne chat (og evt. private chats) OG fra registrerede brugere behandles. Alle andre afvises og logges.</p>
      </Card>
      <Card title="Ledere og roller" actions={<button className="primary" onClick={() => setCreating(true)}>+ Ny bruger</button>}>
        <table>
          <thead><tr><th>Navn</th><th>Rolle</th><th>Telegram</th><th>Aktiv</th><th /></tr></thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.id} style={{ opacity: u.active ? 1 : 0.5 }}>
                <td>{u.name}</td>
                <td>
                  <select value={u.role} style={{ width: 'auto' }} onChange={(e) => void act(() => call('management.updateUser', { id: u.id, role: e.target.value }))}>
                    {(['admin', 'manager', 'observer'] as ManagementRole[]).map((r) => <option key={r} value={r}>{MANAGEMENT_ROLE_LABELS[r]}</option>)}
                  </select>
                </td>
                <td>{u.telegramUserId ? <span className="badge ok">Forbundet</span> : <>Kode: <code>{u.linkCode}</code> → skriv <code>/leder {u.linkCode}</code></>}</td>
                <td><input type="checkbox" checked={u.active} onChange={(e) => void act(() => call('management.updateUser', { id: u.id, active: e.target.checked }))} /></td>
                <td><button className="link" onClick={() => void act(() => call('management.regenerateCode', { id: u.id }))}>Ny kode</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="muted small">
          <li><strong>Observatør:</strong> må kun se oplysninger.</li>
          <li><strong>Leder:</strong> + omfordeling, prioritering, ruteforslag, pause/genoptag, manuel håndtering, godkendelse af opfyldning.</li>
          <li><strong>Administrator:</strong> + kritiske regler (tolerance, maks. leveringstid m.m.) og automatik til/fra. Brugere og roller administreres her (kræver PIN).</li>
        </ul>
      </Card>
      {creating && <CreateUser onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateUser({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<ManagementRole>('manager');
  return (
    <Modal title="Ny ledelsesbruger" onClose={onClose} footer={<button className="primary" onClick={() => void act(() => call('management.createUser', { name, role })).then((ok) => ok && onClose())}>Opret</button>}>
      <Field label="Navn"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Rolle">
        <select value={role} onChange={(e) => setRole(e.target.value as ManagementRole)}>
          {(['admin', 'manager', 'observer'] as ManagementRole[]).map((r) => <option key={r} value={r}>{MANAGEMENT_ROLE_LABELS[r]}</option>)}
        </select>
      </Field>
      <p className="muted small">Brugeren får en engangskode og skriver <code>/leder KODE</code> til botten for at blive tilknyttet sin Telegram-konto.</p>
    </Modal>
  );
}

