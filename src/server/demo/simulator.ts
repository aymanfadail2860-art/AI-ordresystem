import type { Ctx } from '../context';
import type { SimulatedSmsAdapter } from '../adapters/sms/simulator';
import type { SimulatedTelegramAdapter } from '../adapters/telegram/simulator';
import type { TelegramButton } from '../adapters/telegram/types';
import { normalizePhone } from '../../core/phone';

/**
 * DEMO-SIMULATOR. Simulerer kunder (SMS) og chauffører (Telegram) mod de
 * simulerede adaptere. Sender ALDRIG rigtige SMS'er eller Telegram-beskeder –
 * den kan kun bruges sammen med simulerede adaptere.
 */
interface Step {
  /** Svar når systemets besked matcher. Første trin sendes med det samme. */
  when?: RegExp;
  say: string;
  delayMs?: number;
}

export interface Scenario {
  id: string;
  title: string;
  steps: Step[];
}

const STREETS = ['Fiktivgade', 'Demovej', 'Testallé', 'Prøvestræde', 'Eksempelvej', 'Simuleret Boulevard', 'Øvelsesgade', 'Modelvej'];
const POSTS = ['2200 København N', '2100 København Ø', '1620 København V', '2300 København S', '2000 Frederiksberg', '2400 København NV'];

function randomAddress(): string {
  const s = STREETS[Math.floor(Math.random() * STREETS.length)];
  return `${s} ${1 + Math.floor(Math.random() * 120)}, ${POSTS[Math.floor(Math.random() * POSTS.length)]}`;
}

export function demoScenarios(): Scenario[] {
  const addr = randomAddress();
  return [
    {
      id: 'quick',
      title: 'Hurtig bestilling i én SMS',
      steps: [
        { say: `Hej, kan jeg få 2 Red Bull og en pose chips til ${addr}?` },
        { when: /Svar JA/i, say: 'Ja tak', delayMs: 4000 },
      ],
    },
    {
      id: 'stepwise',
      title: 'Bestilling over flere beskeder',
      steps: [
        { say: 'Har I Monster?' },
        { when: /Monster/i, say: 'Så vil jeg gerne have 3 Monster og 2 cola', delayMs: 5000 },
        { when: /adresse/i, say: addr, delayMs: 6000 },
        { when: /Svar JA/i, say: 'ok bekræft', delayMs: 4000 },
      ],
    },
    {
      id: 'question',
      title: 'Produktspørgsmål',
      steps: [{ say: 'Hvad koster en Faxe Kondi?' }],
    },
    {
      id: 'complaint',
      title: 'Klage → overdragelse til medarbejder',
      steps: [{ say: 'Min ordre i går kom aldrig, jeg vil have mine penge tilbage!' }],
    },
    {
      id: 'cancel',
      title: 'Bestilling og annullering',
      steps: [
        { say: `4 Faxe Kondi og 2 vingummi til ${addr} tak` },
        { when: /Svar JA/i, say: 'ja', delayMs: 3000 },
        { when: /bekræftet/i, say: 'Undskyld, annuller min ordre', delayMs: 5000 },
      ],
    },
    {
      id: 'change',
      title: 'Ændring før bekræftelse',
      steps: [
        { say: `2 Coca-Cola Zero til ${addr}` },
        { when: /Svar JA/i, say: 'Tilføj også 2 Red Bull', delayMs: 4000 },
        { when: /Svar JA/i, say: 'ja det er fint', delayMs: 4000 },
      ],
    },
  ];
}

interface Bot {
  phone: string;
  scenario: Scenario;
  next: number;
}

export class DemoSimulator {
  private bots = new Map<string, Bot>();
  private trafficTimer: NodeJS.Timeout | null = null;
  private timers = new Set<NodeJS.Timeout>();
  private phoneCounter = 3000;
  private stopped = false;

  constructor(
    private ctx: Ctx,
    private sms: SimulatedSmsAdapter,
    private telegram: SimulatedTelegramAdapter,
  ) {
    if (!sms.simulated || !telegram.simulated) throw new Error('Demo-simulatoren kræver simulerede adaptere');
    sms.outbox.on('sent', (to: string, text: string) => this.onCustomerReceives(to, text));
    telegram.outbox.on('sent', (chatId: string, text: string, buttons: TelegramButton[][]) => this.onDriverReceives(chatId, text, buttons));
  }

  start(): void {
    this.stopped = false;
    this.applyTrafficSetting();
  }

  stop(): void {
    this.stopped = true;
    if (this.trafficTimer) clearInterval(this.trafficTimer);
    this.trafficTimer = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  applyTrafficSetting(): void {
    if (this.trafficTimer) clearInterval(this.trafficTimer);
    this.trafficTimer = null;
    const s = this.ctx.settings.get().demo;
    if (s.autoTraffic && !this.stopped) {
      this.trafficTimer = setInterval(() => this.startScenario(), Math.max(10, s.trafficIntervalSeconds) * 1000);
    }
  }

  private later(ms: number, fn: () => void): NodeJS.Timeout {
    const speed = Math.max(1, this.ctx.settings.get().demo.speedFactor);
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.stopped) {
        try {
          fn();
        } catch (e) {
          this.ctx.events.log('warn', 'demo', 'sim_error', `Demo-simulator: ${(e as Error).message}`);
        }
      }
    }, ms / Math.min(speed, 4));
    this.timers.add(t);
    return t;
  }

  /** Start et kundescenarie (tilfældigt hvis intet id). Returnerer kundens nummer. */
  startScenario(id?: string): string {
    const all = demoScenarios();
    const scenario = all.find((s) => s.id === id) ?? all[Math.floor(Math.random() * all.length)];
    const phone = `+45999930${String(this.phoneCounter++ % 100).padStart(2, '0')}`;
    const bot: Bot = { phone, scenario, next: 1 };
    this.bots.set(phone, bot);
    this.sms.injectInbound(phone, scenario.steps[0].say);
    return phone;
  }

  sendAsCustomer(phone: string, text: string): void {
    const p = normalizePhone(phone);
    if (!p) throw new Error('Ugyldigt telefonnummer');
    this.bots.delete(p); // manuel styring overtager eventuel bot
    this.sms.injectInbound(p, text);
  }

  /** Simulér at en medarbejder svarer fra virksomhedens iPhone (manuel aktivitet). */
  sendAsStaffFromPhone(phone: string, text: string): void {
    const p = normalizePhone(phone);
    if (!p) throw new Error('Ugyldigt telefonnummer');
    this.sms.injectManualOutgoing(p, text);
  }

  sendAsDriver(driverId: number, text: string): void {
    const d = this.ctx.drivers.get(driverId);
    if (!d?.telegramUserId) throw new Error('Chaufføren er ikke forbundet');
    this.telegram.injectText(d.telegramUserId, d.name, text);
  }

  private onCustomerReceives(to: string, text: string): void {
    const bot = this.bots.get(to);
    if (!bot) return;
    const step = bot.scenario.steps[bot.next];
    if (!step) {
      this.bots.delete(to);
      return;
    }
    if (step.when && !step.when.test(text)) return;
    bot.next++;
    this.later(step.delayMs ?? 4000, () => this.sms.injectInbound(to, step.say));
  }

  // ---------------- Chauffør-bots ----------------

  private onDriverReceives(chatId: string, text: string, buttons: TelegramButton[][]): void {
    if (!chatId.startsWith('sim-driver-')) return;
    const driverId = parseInt(chatId.replace('sim-driver-', ''), 10);
    const d = this.ctx.drivers.get(driverId);
    if (!d) return;
    const flat = buttons.flat();
    const accept = flat.find((b) => b.data.endsWith(':accept'));
    const reject = flat.find((b) => b.data.endsWith(':reject'));
    if (accept && reject) {
      const yes = Math.random() < 0.88;
      this.later(3000 + Math.random() * 5000, () => this.telegram.injectCallback(chatId, d.name, yes ? accept.data : reject.data));
      return;
    }
    const pickup = flat.find((b) => b.data.endsWith(':pickup'));
    if (pickup) {
      const orderId = parseInt(pickup.data.split(':')[1], 10);
      this.simulateDelivery(driverId, chatId, d.name, orderId);
    }
    void text;
  }

  /**
   * Simulerer en chauffør via Telegram-beskeder (ingen GPS): kører mod
   * ordren, melder ETA undervejs, af og til trafik/forsinkelse, er fremme
   * og bekræfter levering.
   */
  private simulateDelivery(driverId: number, chatId: string, name: string, orderId: number): void {
    const order = this.ctx.orders.get(orderId);
    if (!order) return;
    const speed = Math.max(1, this.ctx.settings.get().demo.speedFactor);
    const travelMs = order.eta ? Math.max(60000, new Date(order.eta).getTime() - Date.now()) : 10 * 60000;
    const simMs = travelMs / speed;
    const roll = Math.random();
    const busy = () => {
      // Kør kun mod denne ordre, hvis den er først på ruten
      const first = this.ctx.drivers.routeStops(driverId)[0];
      return first && first.orderId !== orderId;
    };
    const step = (ms: number, fn: () => void) =>
      this.later(ms, () => {
        const o = this.ctx.orders.get(orderId);
        if (!o || !['driver_assigned', 'out_for_delivery'].includes(o.status)) return;
        if (busy()) {
          this.later(15000, () => step(0, fn));
          return;
        }
        fn();
      });
    step(4000, () => this.telegram.injectCallback(chatId, name, `ord:${orderId}:pickup`));
    if (roll < 0.2) step(4000 + simMs * 0.4, () => this.telegram.injectText(chatId, name, 'Der er trafik, bliver nok 10 min senere'));
    step(4000 + simMs * 0.7, () => this.telegram.injectText(chatId, name, `Ordre ${orderId}, jeg er der om 5 min`));
    step(5000 + simMs, () => this.telegram.injectCallback(chatId, name, `ord:${orderId}:arrived`));
    if (roll > 0.92) {
      step(9000 + simMs, () => this.telegram.injectText(chatId, name, 'Kunden svarer ikke'));
      step(20000 + simMs, () => this.telegram.injectText(chatId, name, `Ordre ${orderId} er leveret`));
    } else {
      step(9000 + simMs, () => this.telegram.injectText(chatId, name, `Ordre ${orderId} er leveret`));
    }
  }

  status(): { activeBots: number; autoTraffic: boolean } {
    return { activeBots: this.bots.size, autoTraffic: this.ctx.settings.get().demo.autoTraffic };
  }
}
