/**
 * app/login.js — Écran de connexion artiste inkr Pro
 *
 * Design sombre, gradient inkr, input épurés style iOS.
 */

import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert, Image,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useAuth } from '../hooks/useAuth';

export default function LoginScreen() {
  const { login }          = useAuth();
  const [email, setEmail]  = useState('');
  const [pass,  setPass]   = useState('');
  const [busy,  setBusy]   = useState(false);

  async function handleLogin() {
    if (!email.trim() || !pass.trim()) {
      Alert.alert('Champs requis', 'Remplis ton email et ton mot de passe.');
      return;
    }
    setBusy(true);
    try {
      await login(email.trim().toLowerCase(), pass);
      // La redirection est gérée par _layout.js (via useAuth user)
    } catch (err) {
      Alert.alert('Connexion échouée', err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* Fond dégradé sombre */}
      <View style={styles.bg} />

      <View style={styles.inner}>

        {/* Logo inkr */}
        <View style={styles.logoWrap}>
          <Text style={styles.logo}>inkr</Text>
          <View style={styles.logoBadge}>
            <Text style={styles.logoBadgeText}>PRO</Text>
          </View>
        </View>
        <Text style={styles.subtitle}>Espace artiste</Text>

        {/* Card formulaire */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Connexion</Text>

          <View style={styles.fieldWrap}>
            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              placeholder="ton@email.com"
              placeholderTextColor="#555"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View style={styles.fieldWrap}>
            <Text style={styles.label}>Mot de passe</Text>
            <TextInput
              style={styles.input}
              placeholder="••••••••"
              placeholderTextColor="#555"
              value={pass}
              onChangeText={setPass}
              secureTextEntry
            />
          </View>

          {/* Bouton */}
          <TouchableOpacity
            onPress={handleLogin}
            disabled={busy}
            activeOpacity={0.85}
          >
            <LinearGradient
              colors={['#667eea', '#a855f7', '#ec4899']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.btn}
            >
              {busy
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.btnText}>Se connecter →</Text>
              }
            </LinearGradient>
          </TouchableOpacity>
        </View>

        <Text style={styles.footer}>
          Pas encore sur inkr Pro ?{'\n'}
          <Text style={styles.footerLink}>inkr.club/pro</Text>
        </Text>

      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0d0d0d' },
  bg: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0d0d0d',
  },
  inner: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 28,
    paddingBottom: 40,
  },
  logoWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  logo: {
    fontSize: 48,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: -2,
  },
  logoBadge: {
    backgroundColor: '#a855f7',
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
    marginLeft: 8,
    alignSelf: 'flex-end',
    marginBottom: 8,
  },
  logoBadgeText: {
    color: 'white',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  subtitle: {
    fontSize: 16,
    color: 'rgba(255,255,255,0.4)',
    marginBottom: 40,
    letterSpacing: 0.2,
  },
  card: {
    backgroundColor: '#1a1a1a',
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#ffffff',
    marginBottom: 24,
  },
  fieldWrap: { marginBottom: 18 },
  label: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.5)',
    marginBottom: 8,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  input: {
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: '#ffffff',
    fontSize: 16,
  },
  btn: {
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  btnText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  footer: {
    textAlign: 'center',
    color: 'rgba(255,255,255,0.3)',
    fontSize: 13,
    marginTop: 32,
    lineHeight: 20,
  },
  footerLink: {
    color: '#a855f7',
    fontWeight: '600',
  },
});
