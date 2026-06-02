/**
 * hooks/useAuth.js
 *
 * Gestion de l'authentification artiste inkr Pro.
 * - Stocke le JWT dans SecureStore (chiffré sur l'appareil)
 * - Expose : user, token, login(), logout(), loading
 */

import { useState, useEffect, createContext, useContext } from 'react';
import * as SecureStore from 'expo-secure-store';
import { apiFetch, EP } from '../constants/Api';

const TOKEN_KEY = 'inkr_pro_token';

// ── Contexte ─────────────────────────────────────────────────────────────────
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser]     = useState(null);
  const [token, setToken]   = useState(null);
  const [loading, setLoading] = useState(true);

  // Vérification du token au démarrage de l'app
  useEffect(() => {
    (async () => {
      try {
        const stored = await SecureStore.getItemAsync(TOKEN_KEY);
        if (stored) {
          const res  = await apiFetch(EP.me, {}, stored);
          const data = await res.json();
          if (data.user) {
            setToken(stored);
            setUser(data.user);
          } else {
            // Token expiré
            await SecureStore.deleteItemAsync(TOKEN_KEY);
          }
        }
      } catch (e) {
        console.warn('[useAuth] init error:', e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // ── Login ─────────────────────────────────────────────────────────────────
  async function login(email, password) {
    const res  = await apiFetch(EP.login, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Identifiants incorrects');
    }

    // Le backend renvoie le token dans le body pour les clients mobiles
    const jwt = data.token;
    if (!jwt) throw new Error('Token manquant — vérifie la version du backend');

    await SecureStore.setItemAsync(TOKEN_KEY, jwt);
    setToken(jwt);
    setUser(data.user);
    return data.user;
  }

  // ── Logout ────────────────────────────────────────────────────────────────
  async function logout() {
    try { await apiFetch(EP.logout, { method: 'POST' }, token); } catch (_) {}
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    setToken(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth doit être dans un AuthProvider');
  return ctx;
}
