import type { Budget, CurrencyCost } from "./contracts.js";
import type { CapabilityBilling } from "../ports/index.js";

export type BudgetReservationSlice = {
  logicalRequests?: number;
  knownBackendCalls?: number;
  modelInputTokens?: number;
  modelOutputTokens?: number;
  pages?: number;
  browserSteps?: number;
  bytes?: number;
};

export type BudgetUsageDelta = BudgetReservationSlice & {
  unknownBackendCalls?: number;
  cost?: CurrencyCost;
};

export type StepReservation = {
  stepId: string;
  reserved: Required<BudgetReservationSlice>;
  settled: boolean;
  outcomeUnknown: boolean;
  actual?: Required<BudgetReservationSlice>;
};

export type LedgerSnapshot = {
  limits: Budget;
  reserved: Required<BudgetReservationSlice>;
  consumed: Required<BudgetReservationSlice>;
  unknownBackendCalls: number;
  activeConcurrency: number;
  costs: readonly CurrencyCost[];
  pendingSteps: readonly string[];
  outcomeUnknownSteps: readonly string[];
};

const emptySlice = (): Required<BudgetReservationSlice> => ({
  logicalRequests: 0,
  knownBackendCalls: 0,
  modelInputTokens: 0,
  modelOutputTokens: 0,
  pages: 0,
  browserSteps: 0,
  bytes: 0,
});

function normalizeSlice(slice: BudgetReservationSlice): Required<BudgetReservationSlice> {
  return {
    logicalRequests: Math.max(0, Math.trunc(slice.logicalRequests ?? 0)),
    knownBackendCalls: Math.max(0, Math.trunc(slice.knownBackendCalls ?? 0)),
    modelInputTokens: Math.max(0, Math.trunc(slice.modelInputTokens ?? 0)),
    modelOutputTokens: Math.max(0, Math.trunc(slice.modelOutputTokens ?? 0)),
    pages: Math.max(0, Math.trunc(slice.pages ?? 0)),
    browserSteps: Math.max(0, Math.trunc(slice.browserSteps ?? 0)),
    bytes: Math.max(0, Math.trunc(slice.bytes ?? 0)),
  };
}

export class BudgetLedger {
  private readonly startTimeMs: number;
  private readonly reservations = new Map<string, StepReservation>();
  private readonly reservedTotals = emptySlice();
  private readonly consumedTotals = emptySlice();
  private readonly costs: CurrencyCost[] = [];
  private unknownBackendCalls = 0;
  private activeConcurrency = 0;

  constructor(private readonly limits: Budget, nowMs = Date.now()) {
    this.startTimeMs = nowMs;
  }

  getRemainingWallTimeMs(nowMs = Date.now()): number {
    return Math.max(0, this.limits.wallTimeMs - Math.max(0, nowMs - this.startTimeMs));
  }

  canAffordRoute(billing: CapabilityBilling, strictCostCap: boolean): { ok: true } | { ok: false; reason: string } {
    if (strictCostCap && this.limits.currencyLimit && billing === "paid_unknown") {
      return {
        ok: false,
        reason: "Route has unknown billing cost and cannot be guaranteed under strict currencyLimit.",
      };
    }
    if (this.limits.currencyLimit && billing === "paid_known") {
      const spentMinor = this.knownCurrencyTotal(this.limits.currencyLimit.currency);
      if (spentMinor >= this.limits.currencyLimit.minorUnits) {
        return { ok: false, reason: "Configured currencyLimit has been reached." };
      }
    }
    return { ok: true };
  }

  knownCurrencyTotal(currency: string): number {
    let total = 0;
    for (const c of this.costs) {
      if (c.currency === currency && c.kind !== "unknown" && typeof c.minorUnits === "number") {
        total += c.minorUnits;
      }
    }
    return total;
  }

  reserve(
    stepId: string,
    slice: BudgetReservationSlice,
    nowMs = Date.now(),
  ): { ok: true; reservation: StepReservation } | { ok: false; reason: string } {
    if (this.reservations.has(stepId)) {
      return { ok: false, reason: `Step ${stepId} is already reserved.` };
    }
    if (this.getRemainingWallTimeMs(nowMs) <= 0) {
      return { ok: false, reason: "Wall-time budget exhausted." };
    }
    if (this.activeConcurrency >= this.limits.concurrency) {
      return { ok: false, reason: "Concurrency budget exhausted." };
    }

    const req = normalizeSlice(slice);
    if (this.reservedTotals.logicalRequests + req.logicalRequests > this.limits.logicalRequests) {
      return { ok: false, reason: "Logical request budget exhausted." };
    }
    if (
      this.limits.knownBackendCalls !== undefined &&
      this.reservedTotals.knownBackendCalls + req.knownBackendCalls > this.limits.knownBackendCalls
    ) {
      return { ok: false, reason: "Backend call budget exhausted." };
    }
    if (
      this.limits.modelInputTokens !== undefined &&
      this.reservedTotals.modelInputTokens + req.modelInputTokens > this.limits.modelInputTokens
    ) {
      return { ok: false, reason: "Model input token budget exhausted." };
    }
    if (
      this.limits.modelOutputTokens !== undefined &&
      this.reservedTotals.modelOutputTokens + req.modelOutputTokens > this.limits.modelOutputTokens
    ) {
      return { ok: false, reason: "Model output token budget exhausted." };
    }
    if (this.limits.pages !== undefined && this.reservedTotals.pages + req.pages > this.limits.pages) {
      return { ok: false, reason: "Page budget exhausted." };
    }
    if (
      this.limits.browserSteps !== undefined &&
      this.reservedTotals.browserSteps + req.browserSteps > this.limits.browserSteps
    ) {
      return { ok: false, reason: "Browser step budget exhausted." };
    }
    if (this.limits.bytes !== undefined && this.reservedTotals.bytes + req.bytes > this.limits.bytes) {
      return { ok: false, reason: "Byte transfer budget exhausted." };
    }

    this.activeConcurrency += 1;
    (Object.keys(req) as (keyof Required<BudgetReservationSlice>)[]).forEach((k) => {
      this.reservedTotals[k] += req[k];
    });
    const entry: StepReservation = {
      stepId,
      reserved: req,
      settled: false,
      outcomeUnknown: false,
    };
    this.reservations.set(stepId, entry);
    return { ok: true, reservation: entry };
  }

  settle(stepId: string, usage: BudgetUsageDelta): void {
    const entry = this.reservations.get(stepId);
    if (!entry || entry.settled) return;
    entry.settled = true;
    this.activeConcurrency = Math.max(0, this.activeConcurrency - 1);

    const actual = normalizeSlice(usage);
    entry.actual = actual;
    (Object.keys(actual) as (keyof Required<BudgetReservationSlice>)[]).forEach((k) => {
      this.reservedTotals[k] = Math.max(0, this.reservedTotals[k] - entry.reserved[k] + actual[k]);
      this.consumedTotals[k] += actual[k];
    });
    if (typeof usage.unknownBackendCalls === "number" && usage.unknownBackendCalls > 0) {
      this.unknownBackendCalls += Math.trunc(usage.unknownBackendCalls);
    }
    if (usage.cost) {
      this.costs.push(usage.cost);
    }
  }

  markOutcomeUnknown(stepId: string, source = "interrupted"): void {
    const entry = this.reservations.get(stepId);
    if (!entry || entry.settled) return;
    entry.settled = true;
    entry.outcomeUnknown = true;
    this.activeConcurrency = Math.max(0, this.activeConcurrency - 1);
    // Keep reserved amounts accounted for so resumed runs do not reclaim spent unknown quota.
    this.unknownBackendCalls += Math.max(1, entry.reserved.logicalRequests);
    this.costs.push({
      kind: "unknown",
      currency: this.limits.currencyLimit?.currency ?? "USD",
      source,
      recordedAt: new Date().toISOString(),
    });
  }

  restoreFromPrior(prior: {
    consumed?: Partial<Required<BudgetReservationSlice>>;
    unknownSteps?: readonly { stepId: string; slice: BudgetReservationSlice }[];
    costs?: readonly CurrencyCost[];
  }): void {
    if (prior.consumed) {
      (Object.keys(this.consumedTotals) as (keyof Required<BudgetReservationSlice>)[]).forEach((k) => {
        const val = Math.max(0, Math.trunc(prior.consumed?.[k] ?? 0));
        this.consumedTotals[k] += val;
        this.reservedTotals[k] += val;
      });
    }
    if (prior.unknownSteps) {
      for (const item of prior.unknownSteps) {
        const slice = normalizeSlice(item.slice);
        (Object.keys(slice) as (keyof Required<BudgetReservationSlice>)[]).forEach((k) => {
          this.reservedTotals[k] += slice[k];
        });
        this.reservations.set(item.stepId, {
          stepId: item.stepId,
          reserved: slice,
          settled: true,
          outcomeUnknown: true,
        });
        this.unknownBackendCalls += Math.max(1, slice.logicalRequests);
      }
    }
    if (prior.costs) {
      this.costs.push(...prior.costs);
    }
  }

  createChildBudget(fraction = 0.5, nowMs = Date.now()): Budget {
    const clamped = Math.min(1, Math.max(0.1, fraction));
    const rem = (limit: number | undefined, used: number): number | undefined =>
      limit === undefined ? undefined : Math.max(0, Math.floor((limit - used) * clamped));
    return {
      wallTimeMs: Math.max(1, Math.floor(this.getRemainingWallTimeMs(nowMs) * clamped)),
      logicalRequests: Math.max(
        0,
        Math.floor((this.limits.logicalRequests - this.reservedTotals.logicalRequests) * clamped),
      ),
      knownBackendCalls: rem(this.limits.knownBackendCalls, this.reservedTotals.knownBackendCalls),
      modelInputTokens: rem(this.limits.modelInputTokens, this.reservedTotals.modelInputTokens),
      modelOutputTokens: rem(this.limits.modelOutputTokens, this.reservedTotals.modelOutputTokens),
      pages: rem(this.limits.pages, this.reservedTotals.pages),
      browserSteps: rem(this.limits.browserSteps, this.reservedTotals.browserSteps),
      bytes: rem(this.limits.bytes, this.reservedTotals.bytes),
      concurrency: Math.max(1, Math.min(this.limits.concurrency, Math.ceil(this.limits.concurrency * clamped))),
      currencyLimit: this.limits.currencyLimit
        ? {
            currency: this.limits.currencyLimit.currency,
            minorUnits: Math.max(
              0,
              Math.floor(
                (this.limits.currencyLimit.minorUnits -
                  this.knownCurrencyTotal(this.limits.currencyLimit.currency)) *
                  clamped,
              ),
            ),
          }
        : undefined,
    };
  }

  snapshot(): LedgerSnapshot {
    const pendingSteps: string[] = [];
    const outcomeUnknownSteps: string[] = [];
    for (const entry of this.reservations.values()) {
      if (!entry.settled) pendingSteps.push(entry.stepId);
      if (entry.outcomeUnknown) outcomeUnknownSteps.push(entry.stepId);
    }
    return {
      limits: this.limits,
      reserved: { ...this.reservedTotals },
      consumed: { ...this.consumedTotals },
      unknownBackendCalls: this.unknownBackendCalls,
      activeConcurrency: this.activeConcurrency,
      costs: [...this.costs],
      pendingSteps,
      outcomeUnknownSteps,
    };
  }
}
