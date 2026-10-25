// jobEvents.js — a tiny shared event bus so the places that create jobs (a booking, an emergency, a free Premium service)
// can tell the alert code "a new job exists" without depending on it.
//   events.emit('new-job', row)   row = the service_requests row that was just inserted
const { EventEmitter } = require('events');
module.exports = new EventEmitter();
