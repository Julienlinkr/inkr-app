/**
 * constants/Api.js
 *
 * Configuration API inkr Pro — mobile.
 *
 * ⚠️  Remplace API_BASE par l'URL Railway de production avant de builder.
 *     Exemple : 'https://inkr-app-production.up.railway.app'
 *     Pour tester en local avec l'iPhone sur le même wifi :
 *       API_BASE = 'http://TON_IP_LOCAL:3000'  (ex: http://192.168.1.10:3000)
 */

// ── URL de base du backend inkr ──────────────────────────────────────────────
export const API_BASE = 'https://inkr-app-production.up.railway.app'; // ← à changer

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
  // Agenda
  appointments:       `${API_BASE}/api/appointments`,
  // Push notifications
  registerPush:       `${API_BASE}/api/auth/mobile/push-token`,
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
