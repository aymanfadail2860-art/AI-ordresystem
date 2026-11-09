import type { AiGateway } from './gateway';
import {
  ManagementInterpretationSchema,
  emptyManagementInterpretation,
  type ManagementInterpretation,
} from './schemas';

export interface ManagementTurnContext {
  text: string;
  drivers: { id: number; name: string }[];
  products: { sku: string; name: string; synonyms: string[] }[];
}

export interface ManagementInterpreter {
  readonly simulated: boolean;
  interpret(ctx: ManagementTurnContext): Promise<ManagementInterpretation>;
}

/** Claude-fortolkning (produktion). Returnerer kun intention + parametre. */
export class ClaudeManagementInterpreter implements ManagementInterpreter {
  readonly simulated = false;
  constructor(private gateway: AiGateway) {}

  async interpret(ctx: ManagementTurnContext): Promise<ManagementInterpretation> {
    const system = `You interpret Danish messages from managers of a drinks delivery business, written in their management Telegram group.
Return ONLY a structured interpretation. You never answer the question yourself and never state numbers: the system fetches all facts from its database.
Intents:
- revenue_today ("hvad har vi omsat for i dag"), orders_outstanding ("hvor mange ordrer mangler vi"), driver_status ("hvordan går det med chauffør 2"),
  most_delayed ("hvem er mest forsinket"), driver_stock ("hvor meget cola har chauffør 1 tilbage" → driverRef, productRef), all_driver_stock,
  orders_awaiting_delivery, explain_assignment ("hvorfor valgte du chauffør 2 til ordre 190" → orderId), stock_problems ("vis alle lagerproblemer"),
  report (daily operations report), route_economics (economic analysis of a driver's route)
- Actions: reassign_order ("flyt ordre 185 til chauffør 3"; force=true only if the manager explicitly says to do it even if promises break),
  prioritize_order ("prioritér ordre 220"), request_route_plan ("find en bedre rute til chauffør 4"), pause_order, resume_order, manual_handling,
  approve_replenishment / reject_replenishment (replenishmentId), set_automation (enable true/false), change_rule (ruleKey + ruleValue in minutes),
  help, unknown.
driverRef: the driver number or name exactly as written ("2", "Sara"). orderId: only numbers explicitly written. Never guess.
If unclear, set ambiguous=true and write a short Danish clarificationQuestion.
Drivers: ${ctx.drivers.map((d) => `#${d.id} ${d.name}`).join(', ')}
Products: ${ctx.products.map((p) => `${p.sku}=${p.name}${p.synonyms.length ? ` (${p.synonyms.join(', ')})` : ''}`).join('; ')}`;
    const res = await this.gateway.structured('management_interpret', 'management_agent', {
      system,
      userContent: JSON.stringify({ message: ctx.text }),
      schema: ManagementInterpretationSchema,
      maxTokens: 1024,
      effort: 'low',
    });
    return res.output ?? { ...emptyManagementInterpretation(), ambiguous: true };
  }
}

/** Regelbaseret fortolkning (Demo Mode og tests – ingen API-kald). */
export class RuleBasedManagementInterpreter implements ManagementInterpreter {
  readonly simulated = true;
  constructor(private gateway: AiGateway | null) {}

  async interpret(ctx: ManagementTurnContext): Promise<ManagementInterpretation> {
    const raw = ctx.text.trim();
    const t = raw.toLowerCase();
    const r = emptyManagementInterpretation();
    r.confidence = 0.85;
    const num = (re: RegExp) => {
      const m = raw.match(re);
      return m ? parseInt(m[1], 10) : null;
    };
    r.orderId = num(/ordre\s*(?:nr\.?\s*)?#?(\d{1,7})/i);
    const dNum = raw.match(/chauff(?:ø|o)r(?:en)?\s*(?:nr\.?\s*)?#?(\d{1,5})/i);
    if (dNum) r.driverRef = dNum[1];
    else {
      const byName = ctx.drivers.find((d) => d.name.split(' ').some((w) => w.length > 2 && new RegExp(`\\b${w}\\b`, 'i').test(raw)));
      if (byName) r.driverRef = byName.name;
    }
    const prod = ctx.products.find((p) => [p.name, ...p.synonyms].some((n) => n.length > 2 && t.includes(n.toLowerCase())));
    if (prod) r.productRef = prod.sku;
    r.replenishmentId = num(/opfyldning\s*(?:nr\.?\s*)?#?(\d{1,7})/i);

    if (/^(hjælp|help|\/hjælp|\/help|kommandoer)/.test(t)) r.intent = 'help';
    else if (/(godkend|accepter).*opfyldning/.test(t)) r.intent = 'approve_replenishment';
    else if (/(afvis).*opfyldning/.test(t)) r.intent = 'reject_replenishment';
    else if (/(flyt|omfordel|giv)\s+ordre/.test(t)) {
      r.intent = 'reassign_order';
      r.force = /(alligevel|uanset|selvom)/.test(t);
    } else if (/priorit/.test(t)) r.intent = 'prioritize_order';
    else if (/(bedre rute|optim|ny rute|ruteplan)/.test(t)) r.intent = 'request_route_plan';
    else if (/(genoptag|fortsæt med|ophæv pause)/.test(t)) r.intent = 'resume_order';
    else if (/pause/.test(t) && r.orderId) r.intent = 'pause_order';
    else if (/manuel/.test(t) && r.orderId) r.intent = 'manual_handling';
    else if (/hvorfor/.test(t) && r.orderId) r.intent = 'explain_assignment';
    else if (/(slå|sæt).*automatik.*(fra|til)/.test(t)) {
      r.intent = 'set_automation';
      r.enable = /til\b/.test(t.split('automatik')[1] ?? '');
    } else if (/(tolerance|maks.*leveringstid|forsinkelsesgrænse|status.*forældet)/.test(t) && /\d/.test(t)) {
      r.intent = 'change_rule';
      r.ruleKey = /tolerance/.test(t) ? 'promiseToleranceMinutes' : /leveringstid/.test(t) ? 'maxDeliveryMinutes' : /forsinkelsesgrænse/.test(t) ? 'lateThresholdMinutes' : 'statusStaleMinutes';
      r.ruleValue = num(/(\d{1,4})/);
    } else if (/(omsat|omsætning|omsætter|indtjening)/.test(t)) r.intent = 'revenue_today';
    else if (/(lagerproblem|lagermangel|mangler varer|vareunderskud)/.test(t)) r.intent = 'stock_problems';
    else if (/(rapport|status for dagen|dagens status)/.test(t)) r.intent = 'report';
    else if (/(økonomi|rentab|dækningsbidrag|økonomisk)/.test(t)) r.intent = 'route_economics';
    else if (/(mest forsinket|hvem er forsinket|forsinkelser)/.test(t)) r.intent = 'most_delayed';
    else if (/(hvor (meget|mange)).*(tilbage|har chauff|i bilen)/.test(t) || (/lager/.test(t) && r.driverRef)) r.intent = 'driver_stock';
    else if (/(alle chauff|chaufførernes lager|billager)/.test(t)) r.intent = 'all_driver_stock';
    else if (/(afventer levering|ikke leveret endnu|undervejs|på vej ud)/.test(t)) r.intent = 'orders_awaiting_delivery';
    else if (/(hvor mange ordrer|mangler vi|udestående|åbne ordrer)/.test(t)) r.intent = 'orders_outstanding';
    else if (r.driverRef && /(hvordan går det|status|hvor er)/.test(t)) r.intent = 'driver_status';
    else {
      r.intent = 'unknown';
      r.ambiguous = true;
      r.confidence = 0.3;
      r.clarificationQuestion = 'Det forstod jeg ikke. Skriv "hjælp" for at se, hvad jeg kan.';
    }
    this.gateway?.logSimulated('management_agent', 'management_interpret', raw.length + 800, 80);
    return r;
  }
}
