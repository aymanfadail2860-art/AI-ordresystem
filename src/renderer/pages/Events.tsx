import { useState } from 'react';
import { act, call, useQuery } from '../api';
import { Card, Empty, PageHeader, dateTime } from '../components/ui';
import type { SystemEvent } from '../../shared/types';
import type { Nav } from '../App';

export function Events({ nav }: { nav: Nav }) {
  const [onlyOpen, setOnlyOpen] = useState(true);
  const { data } = useQuery<SystemEvent[]>('events.list', { onlyOpen, limit: 300 }, ['events']);
  return (
    <>
      <PageHeader
        title="Hændelser"
        subtitle="Monitoring Agent: fejl, advarsler og situationer, der kræver menneskelig handling."
        actions={
          <>
            <label className="row"><input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Kun åbne</label>
            <button onClick={() => void act(() => call('events.ackAll'))}>Markér alle som set</button>
          </>
        }
      />
      <Card>
        {data?.length ? (
          data.map((e) => {
            const d = e.data ?? {};
            return (
              <div key={e.id} className="event-row">
                <span className={`lvl ${e.level}`} />
                <div style={{ flex: 1 }}>
                  <div>{e.message}</div>
                  <div className="muted small">
                    {dateTime(e.createdAt)} · {e.source} · {e.type}
                    {e.acknowledgedAt && ' · set'}
                  </div>
                </div>
                {typeof d.orderId === 'number' && <button onClick={() => nav.go('orders', d.orderId as number)}>Ordre #{String(d.orderId)}</button>}
                {typeof d.conversationId === 'number' && <button onClick={() => nav.go('conversations', d.conversationId as number)}>Samtale</button>}
                {typeof d.driverId === 'number' && <button onClick={() => nav.go('drivers', d.driverId as number)}>Chauffør</button>}
                {!e.acknowledgedAt && e.requiresAction && <button className="primary" onClick={() => void act(() => call('events.ack', { id: e.id }))}>Håndteret</button>}
              </div>
            );
          })
        ) : (
          <Empty>{onlyOpen ? 'Intet kræver handling.' : 'Ingen hændelser.'}</Empty>
        )}
      </Card>
    </>
  );
}
