/**
 * app/_layout.js — Root layout
 *
 * Gère la navigation globale et le contexte d'auth.
 * - Si l'user n'est pas connecté → redirige vers /login
 * - Si connecté → affiche les tabs
 */

import { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { AuthProvider, useAuth } from '../hooks/useAuth';

// Empêche le splash de se fermer automatiquement
SplashScreen.preventAutoHideAsync();

function RootLayoutNav() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router   = useRouter();

  useEffect(() => {
    if (loading) return;
    SplashScreen.hideAsync();

    const inAuth = segments[0] === 'login';

    if (!user && !inAuth) {
      router.replace('/login');
    } else if (user && inAuth) {
      router.replace('/(tabs)');
    }
  }, [user, loading]);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login"   options={{ animation: 'fade' }} />
      <Stack.Screen name="(tabs)"  options={{ animation: 'fade' }} />
      <Stack.Screen name="chat/[id]" options={{
        headerShown: true,
        headerStyle: { backgroundColor: '#0d0d0d' },
        headerTintColor: '#ffffff',
        headerBackTitle: '',
        animation: 'slide_from_right',
      }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="light" />
      <RootLayoutNav />
    </AuthProvider>
  );
}
