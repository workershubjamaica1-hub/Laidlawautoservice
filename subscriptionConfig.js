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
// Premium: a yearly membership for ONE vehicle, priced by the type of vehicle. Off until PREMIUM_ENABLED=true.
// Each membership year gives PREMIUM_SERVICES_PER_YEAR services (default 2). A service is a diagnostic check followed by servicing
// (an oil and filter change). AutoAid provides the technician; the customer supplies the oil and filter (or agrees a price with the technician).
//
//   PREMIUM_PRICE_CAR / _SUV / _SMALL_TRUCK / _LARGE_TRUCK   the yearly price for each vehicle type (blank or 0 = not offered)
//   PREMIUM_PAY_CAR / _SUV / _SMALL_TRUCK / _LARGE_TRUCK     what AutoAid pays a technician for ONE service on that type of vehicle
//   PREMIUM_SERVICES_PER_YEAR   services in each membership year (default 2)
//   PREMIUM_SERVICE_GAP_DAYS    minimum days between two services on the same vehicle (default 60)
// Which vehicle types fall into which price (the categories are the ones customers choose when they add a vehicle):
//   Car               car
//   SUV or van        suv, van
//   Pickup or small truck   light-truck, small-truck
//   Large truck or bus      heavy-truck, bus
// Motorcycles and "other" vehicles are not covered. The membership year starts when a membership becomes active and rolls over
// every 365 days while it stays active.
// ---------------------------------------------------------------------------------------------------------------------
const premium = {
  enabled: String(process.env.PREMIUM_ENABLED || '').toLowerCase() === 'true',
  servicesPerYear: num(process.env.PREMIUM_SERVICES_PER_YEAR, 2),
  gapDays: num(process.env.PREMIUM_SERVICE_GAP_DAYS, 60)
};
const money = n => `${config.currency === 'JMD' ? 'J$' : config.currency + ' '}${Number(n).toLocaleString('en-JM', { maximumFractionDigits: 2 })}`;
const TIERS = [
  { id: 'car', label: 'Car', env: 'CAR', categories: ['car'] },
  { id: 'suv', label: 'SUV or van', env: 'SUV', categories: ['suv', 'van'] },
  { id: 'small-truck', label: 'Pickup or small truck', env: 'SMALL_TRUCK', categories: ['light-truck', 'small-truck'] },
  { id: 'large-truck', label: 'Large truck or bus', env: 'LARGE_TRUCK', categories: ['heavy-truck', 'bus'] }
];
// the prices and technician pay are read each time, so a changed setting is picked up as soon as the site restarts
const premiumTiers = () => TIERS.map(t => {
  const price = num(process.env['PREMIUM_PRICE_' + t.env], 0), pay = num(process.env['PREMIUM_PAY_' + t.env], 0);
  return { id: t.id, label: t.label, categories: t.categories, price, priceLabel: price > 0 ? money(price) : '', pay, days: 365 };
});
const tierOfCategory = category => premiumTiers().find(t => t.categories.includes(category)) || null;
// the plan on offer for a vehicle: only when its type is covered and has a price
const premiumPlanFor = vehicle => { const t = vehicle && tierOfCategory(vehicle.category); return t && t.price > 0 ? t : null; };
const PERK = { label: 'Free service (diagnostic check and servicing)', category: 'maintenance',
  description: 'Premium service: a diagnostic check, then servicing (oil and filter change). The customer supplies the oil and filter, or agrees a price with the technician if the technician supplies them' };

// status: not-required | none | active | expired     (a membership belongs to one vehicle)
function premiumStatusOf(vehicle, now = Date.now()) {
  if (!premium.enabled || !vehicle) return { status: 'not-required', paidUntil: null, daysLeft: null, windowStart: null, windowEnd: null };
  const paid = vehicle.premium_paid_until ? Date.parse(vehicle.premium_paid_until) : null;
  if (!paid) return { status: 'none', paidUntil: null, daysLeft: null, windowStart: null, windowEnd: null };
  const iso = t => new Date(t).toISOString();
  if (paid <= now) return { status: 'expired', paidUntil: iso(paid), daysLeft: 0, windowStart: null, windowEnd: null };
  // which membership year are we in? years run from premium_year_start in blocks of 365 days
  const year = 365 * DAY, start = vehicle.premium_year_start ? Date.parse(vehicle.premium_year_start) : now;
  const k = Math.max(0, Math.floor((now - start) / year));
  return { status: 'active', paidUntil: iso(paid), daysLeft: Math.ceil((paid - now) / DAY), windowStart: iso(start + k * year), windowEnd: iso(start + (k + 1) * year) };
}

// How many services are used this membership year. `rows` are this vehicle's service requests that carry a premium_perk
// (cancelled ones are ignored, so cancelling a booking gives the service back).
function serviceAllowance(rows, status, now = Date.now()) {
  const live = rows.filter(r => r.premium_perk === 'service' && r.status !== 'cancelled');
  const inYear = r => status.windowStart && Date.parse(r.created_at) >= Date.parse(status.windowStart);
  const used = live.filter(inYear).length, last = live.reduce((m, r) => Math.max(m, Date.parse(r.created_at)), 0);
  const next = last ? last + premium.gapDays * DAY : 0;
  const left = Math.max(0, premium.servicesPerYear - used);
  return { used, limit: premium.servicesPerYear, left, nextAvailable: next > now ? new Date(next).toISOString() : null, canBook: left > 0 && next <= now };
}

module.exports.premium = premium;
module.exports.premiumTiers = premiumTiers;
module.exports.tierOfCategory = tierOfCategory;
module.exports.premiumPlanFor = premiumPlanFor;
module.exports.premiumStatusOf = premiumStatusOf;
module.exports.serviceAllowance = serviceAllowance;
module.exports.PERK = PERK;
module.exports.money = money;
