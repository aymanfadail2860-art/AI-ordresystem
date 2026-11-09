/**
 * SMS-adapterens kontrakt. Resten af systemet kender KUN denne kontrakt,
 * så backend (imsg, simulator, fremtidige alternativer) kan udskiftes.
 */
export interface InboundSms {
  /** Stabil, unik ID fra beskedsystemet (fx Messages-GUID). Bruges til dubletkontrol. */
  externalGuid: string;
  externalRowId?: number;
  chatId?: string;
  /** Afsenderens telefonnummer (rå form – normaliseres af gatewayen). */
  from: string;
  text: string;
  receivedAt: string;
  /** 'SMS', 'RCS', 'iMessage' … som rapporteret af kilden. */
  service: string;
}

/** En udgående besked observeret i beskeddatabasen (kan være vores egen eller en manuel). */
export interface OutgoingObserved {
  externalGuid: string;
  externalRowId?: number;
  chatId?: string;
  to: string;
  text: string;
  at: string;
  service: string;
}

/**
 * Udfald af en afsendelse:
 * - sent: bekræftet afsendt (ved imsg: fundet i chat.db efter afsendelse)
 * - not_started: bevist IKKE afsendt → sikkert at prøve igen
 * - uncertain: ukendt udfald → må ALDRIG gensendes automatisk
 */
export type SendDisposition = 'sent' | 'not_started' | 'uncertain';

export interface SendResult {
  disposition: SendDisposition;
  externalGuid?: string;
  externalRowId?: number;
  error?: string;
}

export type AdapterHealth = 'ok' | 'degraded' | 'error';

export interface SmsAdapterHandlers {
  onInbound(msg: InboundSms): void;
  onOutgoingObserved(msg: OutgoingObserved): void;
  onHealth(state: AdapterHealth, message: string): void;
  /** Senest behandlede række-cursor (til genoptagelse efter genstart). */
  loadCursor(): number | null;
  saveCursor(cursor: number): void;
}

export interface SmsAdapter {
  readonly kind: 'simulator' | 'imsg';
  /** true = simulation. Må aldrig præsenteres som produktionsintegration. */
  readonly simulated: boolean;
  /** Om adapteren kan observere udgående beskeder sendt manuelt fra iPhone/Mac. */
  readonly canObserveOutgoing: boolean;
  start(handlers: SmsAdapterHandlers): Promise<void>;
  stop(): Promise<void>;
  send(to: string, text: string): Promise<SendResult>;
}
