// subscriptionConfig.js — monthly subscription settings for service providers (role "staff") and how to read an account's status.
//
// Everything is switched off until SUBSCRIPTIONS_ENABLED=true, so nothing changes for existing technicians until you turn it on.
// Settings (environment variables):
//   SUBSCRIPTIONS_ENABLED   true to require a paid subscription
//   SUBSCRIPTION_PRICE      the monthly fee, e.g. 5000
//   SUBSCRIPTION_CURRENCY   default JMD
//   SUBSCRIPTION_DAYS       how many days one payment covers (default 30)
//   SUBSCRIPTION_GRACE_DAYS extra days after expiry before access is blocked (default 5)
const DAY = 24 * 60 * 60 * 1000;
const num = (v, fallback) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback);

const config = {
  enabled: String(process.env.SUBSCRIPTIONS_ENABLED || '').toLowerCase() === 'true',
  price: num(process.env.SUBSCRIPTION_PRICE, 0),
  currency: (process.env.SUBSCRIPTION_CURRENCY || 'JMD').toUpperCase(),
  days: num(process.env.SUBSCRIPTION_DAYS, 30),
  graceDays: num(process.env.SUBSCRIPTION_GRACE_DAYS, 5)
};
const priceLabel = () => (config.price ? `${config.currency === 'JMD' ? 'J$' : config.currency + ' '}${config.price.toLocaleString('en-JM', { maximumFractionDigits: 2 })}` : '');

// status: not-required | active | grace | expired | none
//   active  = paid up
//   grace   = past the paid date but still inside the grace days (access continues)
//   expired = grace is over (access blocked)
//   none    = has never paid (access blocked)
function statusOf(user, now = Date.now()) {
  if (!config.enabled || !user || user.role !== 'staff') return { status: 'not-required', restricted: false, paidUntil: null, graceUntil: null, daysLeft: null };
  const paid = user.subscription_paid_until ? Date.parse(user.subscription_paid_until) : null;
  if (!paid) return { status: 'none', restricted: true, paidUntil: null, graceUntil: null, daysLeft: null };
  const graceUntil = paid + config.graceDays * DAY;
  const daysLeft = Math.ceil((paid - now) / DAY);
  const iso = t => new Date(t).toISOString();
  if (paid > now) return { status: 'active', restricted: false, paidUntil: iso(paid), graceUntil: iso(graceUntil), daysLeft };
  if (graceUntil > now) return { status: 'grace', restricted: false, paidUntil: iso(paid), graceUntil: iso(graceUntil), daysLeft: Math.max(0, Math.ceil((graceUntil - now) / DAY)) };
  return { status: 'expired', restricted: true, paidUntil: iso(paid), graceUntil: iso(graceUntil), daysLeft: 0 };
}

module.exports = { config, statusOf, priceLabel, DAY };

// ---------------------------------------------------------------------------------------------------------------------
// Premium customers: a paid membership with free servicing perks. Off until PREMIUM_ENABLED=true.
//   PREMIUM_PRICE_MONTHLY / PREMIUM_PRICE_YEARLY   the fees (leave one blank to not offer that plan). Uses SUBSCRIPTION_CURRENCY.
//   PREMIUM_OIL_PER_YEAR     free oil and filter changes per membership year (default 4)
//   PREMIUM_OIL_GAP_DAYS     minimum days between two free oil changes (default 80, about one every 3 months)
//   PREMIUM_PAY_OIL          what AutoAid pays a technician for a free oil and filter change
//   PREMIUM_PAY_BRAKES       what AutoAid pays a technician for the yearly brake pad check (includes the labour to replace pads)
// The membership year starts when a membership becomes active and rolls over every 365 days while it stays active.
// Pad parts are paid for by the customer: the technician records them as the job amount.
// ---------------------------------------------------------------------------------------------------------------------
const premium = {
  enabled: String(process.env.PREMIUM_ENABLED || '').toLowerCase() === 'true',
  priceMonthly: num(process.env.PREMIUM_PRICE_MONTHLY, 0),
  priceYearly: num(process.env.PREMIUM_PRICE_YEARLY, 0),
  oilPerYear: num(process.env.PREMIUM_OIL_PER_YEAR, 4),
  oilGapDays: num(process.env.PREMIUM_OIL_GAP_DAYS, 80),
  payOil: num(process.env.PREMIUM_PAY_OIL, 0),
  payBrakes: num(process.env.PREMIUM_PAY_BRAKES, 0)
};
const money = n => `${config.currency === 'JMD' ? 'J$' : config.currency + ' '}${Number(n).toLocaleString('en-JM', { maximumFractionDigits: 2 })}`;
const PERKS = {
  oil: { label: 'Free oil and filter change', category: 'maintenance', description: 'Premium: free oil and filter change' },
  brakes: { label: 'Yearly brake disc pad check', category: 'mechanical', description: 'Premium: yearly brake disc pad check (replace the pads if needed; the customer pays for the pad parts)' }
};
// Plans on offer: only those with a price
function premiumPlans() {
  const plans = [];
  if (premium.priceMonthly > 0) plans.push({ id: 'monthly', label: 'Monthly', price: premium.priceMonthly, priceLabel: money(premium.priceMonthly), days: 30 });
  if (premium.priceYearly > 0) {
    const save = premium.priceMonthly > 0 ? Math.round((1 - premium.priceYearly / (premium.priceMonthly * 12)) * 100) : 0;
    plans.push({ id: 'yearly', label: 'Yearly', price: premium.priceYearly, priceLabel: money(premium.priceYearly), days: 365, saving: save > 0 ? save : 0 });
  }
  return plans;
}

// status: not-required | none | active | expired     (only customers can be members)
function premiumStatusOf(user, now = Date.now()) {
  if (!premium.enabled || !user || user.role !== 'customer') return { status: 'not-required', paidUntil: null, daysLeft: null, windowStart: null, windowEnd: null };
  const paid = user.premium_paid_until ? Date.parse(user.premium_paid_until) : null;
  if (!paid) return { status: 'none', paidUntil: null, daysLeft: null, windowStart: null, windowEnd: null };
  const iso = t => new Date(t).toISOString();
  if (paid <= now) return { status: 'expired', paidUntil: iso(paid), daysLeft: 0, windowStart: null, windowEnd: null };
  // which membership year are we in? years run from premium_year_start in blocks of 365 days
  const year = 365 * DAY, start = user.premium_year_start ? Date.parse(user.premium_year_start) : now;
  const k = Math.max(0, Math.floor((now - start) / year));
  return { status: 'active', paidUntil: iso(paid), daysLeft: Math.ceil((paid - now) / DAY), windowStart: iso(start + k * year), windowEnd: iso(start + (k + 1) * year) };
}

// Works out how many perks are used this membership year. `rows` are the member's service requests that carry a premium_perk
// (cancelled ones are ignored, so cancelling a booking gives the perk back).
function perkAllowance(rows, status, now = Date.now()) {
  const live = rows.filter(r => r.premium_perk && r.status !== 'cancelled');
  const inYear = r => status.windowStart && Date.parse(r.created_at) >= Date.parse(status.windowStart);
  const oil = live.filter(r => r.premium_perk === 'oil'), brakes = live.filter(r => r.premium_perk === 'brakes');
  const oilYear = oil.filter(inYear).length, brakesYear = brakes.filter(inYear).length;
  const lastOil = oil.reduce((m, r) => Math.max(m, Date.parse(r.created_at)), 0);
  const nextOil = lastOil ? lastOil + premium.oilGapDays * DAY : 0;
  const oilLeft = Math.max(0, premium.oilPerYear - oilYear);
  return {
    oil: { used: oilYear, limit: premium.oilPerYear, left: oilLeft, nextAvailable: nextOil > now ? new Date(nextOil).toISOString() : null,
           canBook: oilLeft > 0 && nextOil <= now },
    brakes: { used: brakesYear, limit: 1, left: Math.max(0, 1 - brakesYear), canBook: brakesYear < 1 }
  };
}

module.exports.premium = premium;
module.exports.premiumPlans = premiumPlans;
module.exports.premiumStatusOf = premiumStatusOf;
module.exports.perkAllowance = perkAllowance;
module.exports.PERKS = PERKS;
module.exports.money = money;
