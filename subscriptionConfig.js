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
