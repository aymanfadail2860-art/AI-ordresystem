import { DEFAULT_ADAPTIVE } from '../core/routePlanning';
import type { ModelPricing, Settings } from '../shared/types';

/**
 * Standardpriser pr. million tokens (USD) for Claude-modeller.
 * Kilde: Anthropics prisliste (cache 2026-10-06). Priserne kan ændres i
 * AI Control Center – de er konfiguration, ikke hardcodede antagelser.
 */
export const DEFAULT_MODEL_PRICING: ModelPricing[] = [
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5 (lille, hurtig)',
    inputPerMTokUsd: 0.1,
    outputPerMTokUsd: 0.5,
    cacheReadPerMTokUsd: 0.01,
    cacheWritePerMTokUsd: 0.125,
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5 (mellem)',
    inputPerMTokUsd: 2,
    outputPerMTokUsd: 10,
    cacheReadPerMTokUsd: 0.2,
    cacheWritePerMTokUsd: 2.5,
  },
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5 (stor)',
    inputPerMTokUsd: 4,
    outputPerMTokUsd: 20,
    cacheReadPerMTokUsd: 0.2,
    cacheWritePerMTokUsd: 5,
  },
];

const day = (open: string, close: string, closed = false) => ({ open, close, closed });

export function defaultSettings(mode: Settings['installation']['mode']): Settings {
  return {
    company: { name: '', phone: '', email: '', address: '', cvr: '', timezone: 'Europe/Copenhagen' },
    installation: { mode, setupCompleted: false, automationEnabled: mode === 'demo' },
    automation: { customerReplies: true, autoDispatch: true, customerEtaUpdates: true },
    pricing: {
      deliveryFeeOre: 3900,
      freeDeliveryThresholdOre: 30000,
      minimumOrderOre: 0,
      currency: 'DKK',
    },
    delivery: {
      centerLat: 55.6761,
      centerLng: 12.5683,
      radiusKm: 12,
      postalCodes: [],
      defaultPrepMinutes: 5,
      quoteExpiryMinutes: 30,
      offerTimeoutSeconds: 120,
      requireDriverAcceptance: true,
      allowCentralPickup: true,
    },
    logistics: {
      statusStaleMinutes: 20,
      statusRequestAfterMinutes: 20,
      escalateNoStatusMinutes: 35,
      serviceMinutesPerStop: 3,
      historicalBufferMaxMinutes: 8,
      extraCapacityMinutes: 45,
    },
    notifications: {
      lateThresholdMinutes: 10,
      earlyThresholdMinutes: 15,
      minMinutesBetweenUpdates: 10,
      maxUpdatesPerOrder: 3,
      arrivalSoonMaxMinutes: 15,
      arrivalSoonTemplate: 'Din bestilling forventes leveret om cirka {minutes} minutter. Du må meget gerne stå klar.',
      delayTemplate: 'Din levering (ordre #{orderId}) er desværre forsinket. Ny forventet tid er ca. kl. {time}.',
      delayNoTimeTemplate: 'Din levering (ordre #{orderId}) er desværre forsinket. Vi giver besked, når chaufføren er tæt på.',
    },
    management: { groupChatId: '', allowPrivateChats: true, confirmTimeoutMinutes: 10, hourlyReports: true },
    monitoring: {
      enabled: true,
      notifyGroup: true,
      criticalDelayMinutes: 15,
      takeoverDelayMinutes: 40,
      unresponsiveMinutes: 25,
      capacityWaitMinutes: 10,
      volumeChangeFactor: 2,
      volumeMinOrders: 8,
      approvalWarnMinutes: 5,
      dedupeLinkedDecisions: true,
    },
    replenishment: { enabled: true, pickupMinutes: 8, reminderAfterMinutes: 10, escalateLeadMinutes: 10, minRouteImprovementOre: 1000, topUpHorizonMinutes: 90, topUpMaxUnits: 40 },
    economics: {
      strategy: 'adaptive',
      adaptive: { ...DEFAULT_ADAPTIVE },
      priorityWeight: 3,
      defaultMarginPct: 35,
      driveCostPerMinuteOre: 400,
      waitCostPerMinuteOre: 60,
      valueWeightScaleOre: 30000,
      latePenaltyPerMinuteOre: 1500,
      riskPenaltyPerMinuteOre: 20,
      disruptionCostOre: 300,
      reassignmentCostOre: 2500,
      nearbyThresholdMinutes: 5,
      nearbyBonusOre: 1500,
      promiseToleranceMinutes: 5,
      maxDeliveryMinutes: 120,
      significantChangeMinutes: 5,
      minReassignmentGainOre: 3000,
    },
    openingHours: {
      mon: day('10:00', '02:00'),
      tue: day('10:00', '02:00'),
      wed: day('10:00', '02:00'),
      thu: day('10:00', '03:00'),
      fri: day('10:00', '05:00'),
      sat: day('10:00', '05:00'),
      sun: day('12:00', '00:00'),
    },
    messages: {
      greeting: 'Hej! Du skriver med {company}. Hvad må vi bringe til dig?',
      closed: 'Tak for din besked. Vi har desværre lukket lige nu. Vi åbner igen {nextOpen}.',
      outsideArea: 'Beklager, adressen ligger uden for vores leveringsområde.',
      handoffToHuman: 'Tak – en medarbejder vender tilbage til dig hurtigst muligt.',
      orderConfirmed: 'Tak! Din ordre #{orderId} er bekræftet. Vi giver besked, når en chauffør er på vej.',
      delivered: 'Din ordre #{orderId} er leveret. Tak fordi du handlede hos {company}!',
    },
    ai: {
      enabled: true,
      monthlyBudgetUsd: 50,
      warnAtPct: 80,
      routing: {
        customer_interpret: 'claude-haiku-5-5',
        customer_escalation: 'claude-opus-5-5',
        driver_interpret: 'claude-haiku-5-5',
        management_interpret: 'claude-haiku-5-5',
      },
      fallbackModels: ['claude-sonnet-5-5'],
      models: DEFAULT_MODEL_PRICING,
      maxContextMessages: 12,
      escalateBelowConfidence: 0.6,
    },
    sms: {
      backend: mode === 'demo' ? 'none' : 'imsg',
      imsgPath: '',
      region: 'DK',
      service: 'sms',
      pauseOnUnknownOutgoing: true,
    },
    telegram: { botUsername: '', driverGroupChatId: '' },
    maps: { region: 'dk', language: 'da', cacheTtlHours: 24 * 14 },
    retention: { messageBodyDays: 180, inactiveCustomerDays: 730, eventLogDays: 90 },
    backup: { enabled: true, intervalHours: 24, keep: 14 },
    demo: { autoTraffic: false, trafficIntervalSeconds: 45, speedFactor: 10 },
  };
}

/** Dyb fletning af gemte indstillinger oven på standardværdier (nye felter får default). */
export function mergeSettings<T>(base: T, override: unknown): T {
  if (override === null || override === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) {
    return (override as T) ?? base;
  }
  if (typeof override !== 'object' || Array.isArray(override)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    out[k] = k in out ? mergeSettings(out[k], v) : v;
  }
  return out as T;
}
