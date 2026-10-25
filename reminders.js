// reminders.js — tells customers when their vehicle's fitness certificate, registration, insurance or oil change is coming up.
// It looks twice a day. Each date is reminded once when it is 14 days away and once more on the day it falls due or after.
const WARN_DAYS = 14;
const FIELDS = { fitness: 'fitness_due', registration: 'registration_due', insurance: 'insurance_due', oil: 'oil_due' };
const NAME = { fitness: 'fitness certificate', registration: 'vehicle registration', insurance: 'insurance', oil: 'next oil change' };

const dayNumber = iso => Math.floor(Date.parse(iso + 'T00:00:00Z') / 86400000);
const today = () => Math.floor(Date.now() / 86400000);

module.exports = function reminders({ supabase, push }) {
  async function run() {
    try {
      const { data: vehicles, error } = await supabase.from('vehicles').select('*');
      if (error) throw error;
      const due = vehicles.filter(v => v.user_id && Object.values(FIELDS).some(f => v[f]));
      if (!due.length) return 0;
      const { data: owners, error: e2 } = await supabase.from('users').select('id, name, email, active, deleted_at').in('id', [...new Set(due.map(v => v.user_id))]);
      if (e2) throw e2;
      const byId = new Map(owners.map(o => [o.id, o]));
      let sent = 0;
      for (const v of due) {
        const owner = byId.get(v.user_id); if (!owner || owner.active === false || owner.deleted_at) continue;
        const reminded = { ...(v.reminded || {}) }; let changed = false;
        for (const [key, col] of Object.entries(FIELDS)) {
          const date = v[col]; if (!date) continue;
          const days = dayNumber(String(date).slice(0, 10)) - today();
          const stage = days <= 0 ? 'final' : days <= WARN_DAYS ? 'soon' : null;
          if (!stage) continue;
          if (stage === 'soon' && reminded[key] === date) continue;
          if (stage === 'final' && (reminded[key + '_final'] === date)) continue;
          const car = v.year + ' ' + v.type;
          const when = days > 1 ? 'in ' + days + ' days' : days === 1 ? 'tomorrow' : days === 0 ? 'today' : Math.abs(days) + ' day' + (days === -1 ? '' : 's') + ' ago';
          const title = (days <= 0 ? 'Overdue: ' : 'Coming up: ') + NAME[key] + ' for your ' + car;
          const body = 'Your ' + NAME[key] + ' for the ' + car + ' is due ' + when + ' (' + String(date).slice(0, 10) + '). ' + (key === 'oil' ? 'Book a service in AutoAid 24/7 so a technician can help.' : 'Open My garage in AutoAid 24/7 to update the date once it is done.');
          if (push) {
            await push.notify([owner.id], { title, body, url: '/app.html#garage', tag: 'reminder-' + v.id + '-' + key }).catch(() => {});
            await push.email([owner], title, body).catch(() => {});
          }
          reminded[key] = date; if (stage === 'final') reminded[key + '_final'] = date;
          changed = true; sent++;
        }
        if (changed) await supabase.from('vehicles').update({ reminded }).eq('id', v.id);
      }
      return sent;
    } catch (e) { console.error('Reminder run failed:', e.message); return 0; }
  }
  setTimeout(run, 90 * 1000).unref();
  setInterval(run, 12 * 60 * 60 * 1000).unref();
  return { run, FIELDS };
};
module.exports.FIELDS = FIELDS;
