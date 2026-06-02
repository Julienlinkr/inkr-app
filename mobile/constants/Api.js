/**
 * constants/Api.js
 *
 * Configuration API inkr Pro — mobile.
 *
 * ⚠️  Remplace API_BASE par l'URL Railway de production avant de builder.
 *     Exemple : 'https://www.inkr.club'
 *     Pour tester en local avec l'iPhone sur le même wifi :
 *       API_BASE = 'http://TON_IP_LOCAL:3000'  (ex: http://192.168.1.10:3000)
 */

// ── URL de base du backend inkr ──────────────────────────────────────────────
export const API_BASE = 'https://www.inkr.club'; // ← à changer

// ── Header spécial pour identifier les requêtes mobiles ─────────────────────
// Le backend retourne le JWT dans le body quand ce header est présent.
export const MOBILE_HEADERS = {
  'Content-Type': 'application/json',
  'X-Inkr-Client': 'mobile',
};

// ── Endpoints ────────────────────────────────────────────────────────────────
export const EP = {
  login:              `${API_BASE}/api/auth/login`,
  me:                 `${API_BASE}/api/auth/me`,
  profile:            `${API_BASE}/api/auth/profile`,
  logout:             `${API_BASE}/api/auth/logout`,
  // Conversations artiste (voir messages des clients)
  conversations:      `${API_BASE}/api/auth/mobile/conversations`,
  conversation:  (id) => `${API_BASE}/api/auth/mobile/conversations/${id}`,
  reply:         (id) => `${API_BASE}/api/auth/mobile/conversations/${id}/reply`,
  // Agenda (Bearer auth — endpoint mobile dédié)
  appointments:       `${API_BASE}/api/auth/mobile/agenda`,
  appointmentUpdate:  (id) => `${API_BASE}/api/auth/mobile/agenda/${id}`,
  appointmentDelete:  (id) => `${API_BASE}/api/auth/mobile/agenda/${id}`,
  // Clients (Bearer auth — endpoint mobile dédié)
  clients:            `${API_BASE}/api/auth/mobile/clients`,
  client:        (id) => `${API_BASE}/api/auth/mobile/clients/${id}`,
  // Push notifications
  registerPush:       `${API_BASE}/api/auth/mobile/push-token`,
  // Campagnes marketing
  campaigns:          `${API_BASE}/api/auth/mobile/campaigns`,
  campaign:      (id) => `${API_BASE}/api/auth/mobile/campaigns/${id}`,
  campaignSend:  (id) => `${API_BASE}/api/auth/mobile/campaigns/${id}/send`,
  // Automatisations
  automations:        `${API_BASE}/api/auth/mobile/automations`,
  automation:    (id) => `${API_BASE}/api/auth/mobile/automations/${id}`,
  // Fidélité
  loyalty:            `${API_BASE}/api/auth/mobile/loyalty`,
};

/**
 * apiFetch — wrapper fetch qui injecte automatiquement le token Bearer
 * @param {string} url
 * @param {object} options  — options fetch standard
 * @param {string} token    — JWT stocké dans SecureStore
 */
export async function apiFetch(url, options = {}, token = null) {
  const headers = {
    ...MOBILE_HEADERS,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };
  const res = await fetch(url, { ...options, headers });
  return res;
}
