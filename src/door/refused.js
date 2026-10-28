/**
 * What every refusal at the door shares: who the caller is, and the one log
 * line a refusal writes. Used by door.js, forward.js and error-handler.js.
 */

/**
 * The client's IP: the X-Real-IP header, which nginx sets on every request
 * it proxies, or, when the header is absent (a direct call on localhost),
 * the socket's address. The door listens on 127.0.0.1, so nothing but nginx
 * and local calls reach it, and the header cannot come from outside.
 */
export function clientIp(req) {
  const header = req.headers['x-real-ip'];
  return typeof header === 'string' && header !== '' ? header : req.socket.remoteAddress;
}

/**
 * The one line a refusal writes to the journal:
 *   refused <ip> <method> <path> <status>: <reason>
 * Nothing is logged for a forwarded request or for a 429: nginx's access
 * log has every request with its status.
 */
export function logRefused(req, status, reason) {
  console.log(`refused ${clientIp(req)} ${req.method} ${req.originalUrl} ${status}: ${reason}`);
}
