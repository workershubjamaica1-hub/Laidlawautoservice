// ai.js — the "Ask the mechanic" chat. Streams answers from Claude; with no API key it falls back
// to the built-in rule-based answers (diagnose() in server.js) so the page keeps working.
//
// Protocol (newline-delimited JSON over a normal POST response):
//   {"t":"text","d":"..."}   a piece of the answer
//   {"t":"done"}             finished
//   {"t":"error","m":"..."}  something went wrong (shown to the customer)
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.AI_EFFORT || 'medium'; // low | medium | high | xhigh | max
// Copy-paste into a dashboard often adds spaces, line breaks or quotes: strip them
const API_KEY = (process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || '').replace(/\s+/g, '').replace(/^["']+|["']+$/g, '');
const client = API_KEY ? new Anthropic({ apiKey: API_KEY }) : null;
console.log(client
  ? `AI assistant: Claude (${MODEL}, effort ${EFFORT}). Key starts "${API_KEY.slice(0, 10)}...", ${API_KEY.length} characters.`
  : 'AI assistant: NO API KEY FOUND (set AI_API_KEY). Using the basic built-in answers.');
if (!client) {
  // Names only, never values: helps spot a misspelled variable name
  const near = Object.keys(process.env).filter(k => /ai|anthropic|claude|key|api/i.test(k) && !/^(SUPABASE_SECRET_KEY)$/.test(k));
  console.log('Environment variables that look related: ' + (near.length ? near.map(k => JSON.stringify(k) + (process.env[k] ? '' : ' (EMPTY)')).join(', ') : 'none'));
}

const MAX_MESSAGES = 20;          // conversation turns sent to the model
const MAX_MESSAGE_CHARS = 4000;   // per message
const HOURLY_LIMIT = Number(process.env.AI_HOURLY_LIMIT || 40); // questions per user per hour

const SERVICE_VALUES = ['diagnostics', 'mechanical', 'tire', 'electrical', 'maintenance', 'bodywork', 'roadside', 'towing', 'other'];

const SYSTEM_PROMPT = `You are the in-house mechanic assistant for AutoAid 24/7, a vehicle repair and roadside assistance service in Jamaica. Customers talk to you through a chat on the AutoAid 24/7 website.

Who you help: vehicle owners, usually not mechanics. Cars, light trucks, small trucks and heavy trucks (including diesel engines, air brakes and hydraulics). Many vehicles are Japanese imports and Jamaican roads, heat, potholes, salt air and fuel quality are normal context.

How to answer:
- Answer the question that was asked, at the level of detail the customer needs. Go as technical as the question requires: fault codes, sensor behaviour, torque and fluid specs, diagnostic steps and likely causes ranked by probability are all fair game. Explain jargon in plain words when the customer does not use it themselves.
- Start with the most likely cause, then what to check or try, in order from cheapest/easiest to most involved. Say what would rule each cause in or out.
- If the symptom is vague, ask one or two short clarifying questions (when does it happen: cold start, braking, turning, under load; any warning lights; sounds, smells, smoke) instead of guessing. Do not interrogate; give useful preliminary guidance while you ask.
- Be honest about uncertainty. You cannot see or hear the vehicle, so say "most likely" or "could be" rather than stating a diagnosis as certain, and say when a hands-on inspection or a scan tool is needed.
- Safety first. If the problem could make the vehicle unsafe to drive (brake failure or soft pedal, steering problems, overheating, fuel leak, smoke, burning smell, airbag or ABS warnings with other symptoms), say so plainly at the top and tell them to stop driving it or get it towed. Never encourage a DIY job that is dangerous without proper equipment (supporting a vehicle, fuel system, airbags, high-voltage hybrid systems, air-brake components).
- Do not invent prices, part numbers or specifications you are not sure of. If you are unsure of an exact figure for their model, say to check the owner's manual or the shop.
- Keep it conversational and well organised: short paragraphs, and a short list only when listing steps or causes. No headings, no emojis, no markdown tables. Keep replies concise unless the question needs depth.
- Stay on vehicles and the shop. Politely decline unrelated requests.

Booking: when a professional inspection or repair is the sensible next step, say so and end your message with exactly one booking tag on its own final line, in this form:
[[BOOK:category|urgency]]
category must be one of: ${SERVICE_VALUES.join(', ')}. urgency must be one of: high (unsafe or getting worse fast, get it checked soon), medium (book when they can), low (routine). The website turns the tag into a "Book service" button, so never mention the tag or write it anywhere else. Leave it out when you are only answering a question or asking for more detail.`;

// Rate limit per user: HOURLY_LIMIT questions per rolling hour (in memory; resets on restart)
const usage = new Map();
function overLimit(userId) {
  const now = Date.now();
  const recent = (usage.get(userId) || []).filter(t => now - t < 3600 * 1000);
  if (recent.length >= HOURLY_LIMIT) { usage.set(userId, recent); return true; }
  recent.push(now);
  usage.set(userId, recent);
  return false;
}

// Accepts [{role, content}, ...] from the browser and returns a clean, valid conversation or null
function cleanMessages(input) {
  if (!Array.isArray(input) || !input.length) return null;
  const out = [];
  for (const m of input.slice(-MAX_MESSAGES)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return null;
    const content = m.content.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!content) return null;
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += '\n' + content; // keep roles alternating
    else out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift(); // must start with the customer
  return out.length && out[out.length - 1].role === 'user' ? out : null;
}

const vehicleLine = v =>
  `The customer is asking about their ${v.year} ${v.type} (${v.category.replace('-', ' ')}).`;

module.exports = function createAiChat({ supabase, diagnose, isCustomer }) {
  return async function aiChat(req, res) {
    const messages = cleanMessages(req.body && req.body.messages);
    if (!messages) return res.status(400).json({ error: 'Type a question first.' });
    if (overLimit(req.user.id)) {
      return res.status(429).json({ error: 'You have asked a lot of questions this hour. Try again a bit later, or book a service and talk to the mechanic.' });
    }

    // Vehicle context (customers can only ask about their own vehicles)
    let vehicle = null;
    const vehicleId = Number(req.body.vehicleId);
    if (vehicleId) {
      let q = supabase.from('vehicles').select('year, type, category').eq('id', vehicleId);
      if (isCustomer(req)) q = q.eq('user_id', req.user.id);
      const { data, error } = await q.maybeSingle();
      if (error) throw error;
      vehicle = data;
    }

    res.status(200);
    res.set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = obj => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };

    // No API key yet: answer with the built-in rules, in the same format
    if (!client) {
      const asked = messages.filter(m => m.role === 'user').map(m => m.content).join(' ');
      const r = diagnose(asked, vehicle && vehicle.category);
      let text = r.answer + (r.tip ? '\n\n' + r.tip : '');
      if (r.category && r.urgency !== 'unknown') text += `\n[[BOOK:${r.category}|${r.urgency}]]`;
      send({ t: 'text', d: text });
      send({ t: 'done' });
      return res.end();
    }

    const system = SYSTEM_PROMPT + (vehicle ? '\n\n' + vehicleLine(vehicle) : '\n\nThe customer has not said which vehicle this is about. Ask if it matters for the answer.');
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 6000,
      system,
      output_config: { effort: EFFORT },
      messages
    });
    res.on('close', () => { if (!res.writableEnded) stream.abort(); }); // customer closed the page
    stream.on('text', delta => send({ t: 'text', d: delta }));

    try {
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') {
        send({ t: 'error', m: "I can't help with that one here. For anything about your vehicle, describe the symptom or book a service and the mechanic will take a look." });
      } else if (final.stop_reason === 'max_tokens') {
        send({ t: 'text', d: '\n\n(That answer was cut short. Ask me to continue.)' });
        send({ t: 'done' });
      } else {
        send({ t: 'done' });
      }
    } catch (err) {
      if (!(err instanceof Anthropic.APIUserAbortError)) {
        console.error('AI chat error:', err.status || '', err.message);
        let m = 'The mechanic assistant had a problem. Try again in a moment.';
        if (err instanceof Anthropic.RateLimitError) m = 'The assistant is very busy right now. Try again in a minute.';
        else if (err instanceof Anthropic.AuthenticationError) m = 'The assistant is not set up correctly. Please tell the shop.';
        send({ t: 'error', m });
      }
    } finally {
      res.end();
    }
  };
};
