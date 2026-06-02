/**
 * app/(tabs)/index.js — Dashboard Accueil
 *
 * Vue d'ensemble : stats du jour, pastille "AUJOURD'HUI" pour les RDV,
 * derniers messages non lus, prochains rendez-vous.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, SafeAreaView,
  TouchableOpacity, RefreshControl, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../hooks/useAuth';
import { apiFetch, EP } from '../../constants/Api';
import AppHeader from '../../components/AppHeader';

export default function DashboardScreen() {
  const { user, token }         = useAuth();
  const router                   = useRouter();
  const [stats,    setStats]    = useState(null);
  const [convs,    setConvs]    = useState([]);
  const [rdvs,     setRdvs]     = useState([]);
  const [todayRdv, setTodayRdv] = useState([]);
  const [refresh,  setRefresh]  = useState(false);
  const [loading,  setLoading]  = useState(true);

  const load = useCallback(async () => {
    try {
      const [convRes, rdvRes, clientRes] = await Promise.all([
        apiFetch(EP.conversations, {}, token),
        apiFetch(EP.appointments,  {}, token), // endpoint mobile Bearer auth
        apiFetch(EP.clients,       {}, token), // endpoint mobile Bearer auth
      ]);
      const convData   = await convRes.json();
      const rdvData    = await rdvRes.json();
      const clientData = await clientRes.json();

      const convList   = Array.isArray(convData)   ? convData   : [];
      const rdvList    = Array.isArray(rdvData)    ? rdvData    : [];
      const clientList = Array.isArray(clientData) ? clientData : [];

      const today = new Date().toDateString();
      const rdvAujourdhui = rdvList.filter(r => {
        const d = new Date(r.date_rdv || r.date);
        return d.toDateString() === today && r.status !== 'cancelled';
      });

      setConvs(convList.slice(0, 3));
      setTodayRdv(rdvAujourdhui);
      setRdvs(rdvList.filter(r => new Date(r.date_rdv || r.date) >= new Date()).slice(0, 3));
      setStats({
        messages:   convList.filter(c => c.unread_count > 0).length,
        rdvAujourd: rdvAujourdhui.length,
        clients:    clientList.length,
        rdvTotal:   rdvList.length,
      });
    } catch (e) {
      console.warn('[Dashboard]', e.message);
    } finally {
      setLoading(false);
      setRefresh(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bonjour' : hour < 18 ? 'Bon après-midi' : 'Bonsoir';

  if (loading) return (
    <SafeAreaView style={ss.root}>
      <AppHeader noBorder />
      <View style={ss.center}><ActivityIndicator color="#a855f7" size="large" /></View>
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={ss.root}>
      <AppHeader noBorder />
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refresh} onRefresh={() => { setRefresh(true); load(); }} tintColor="#a855f7" />}
      >
        {/* Salutation */}
        <View style={ss.greetRow}>
          <View>
            <Text style={ss.greeting}>{greeting},</Text>
            <Text style={ss.name}>{user?.name?.split(' ')[0] || 'Artiste'} 👋</Text>
          </View>
          <View style={ss.avatarSmall}>
            <Text style={ss.avatarTxt}>{(user?.name || '?')[0].toUpperCase()}</Text>
          </View>
        </View>

        {/* ── Bandeau RDV AUJOURD'HUI ── */}
        {todayRdv.length > 0 && (
          <TouchableOpacity
            style={ss.todayBanner}
            onPress={() => router.push('/(tabs)/agenda')}
            activeOpacity={0.8}
          >
            <View style={ss.todayLeft}>
              <View style={ss.todayDot} />
              <View>
                <Text style={ss.todayLabel}>AUJOURD'HUI</Text>
                <Text style={ss.todayCount}>
                  {todayRdv.length} rendez-vous
                </Text>
              </View>
            </View>
            <View style={ss.todayAvatars}>
              {todayRdv.slice(0, 3).map((r, i) => (
                <View key={i} style={[ss.todayAvatar, { marginLeft: i > 0 ? -10 : 0 }]}>
                  <Text style={ss.todayAvatarTxt}>
                    {(r.client_name || r.prenom_client || '?')[0].toUpperCase()}
                  </Text>
                </View>
              ))}
              {todayRdv.length > 3 && (
                <View style={[ss.todayAvatar, { marginLeft: -10, backgroundColor: '#2a2a2a' }]}>
                  <Text style={ss.todayAvatarTxt}>+{todayRdv.length - 3}</Text>
                </View>
              )}
            </View>
            <Ionicons name="chevron-forward" size={16} color="#a855f7" />
          </TouchableOpacity>
        )}

        {/* Stats cards */}
        <View style={ss.statsGrid}>
          <StatCard icon="chatbubbles" color="#a855f7" value={stats?.messages || 0}   label="Non lus"     onPress={() => router.push('/(tabs)/messages')} />
          <StatCard icon="calendar"    color="#3b82f6" value={stats?.rdvAujourd || 0} label="Aujourd'hui" onPress={() => router.push('/(tabs)/agenda')} />
          <StatCard icon="people"      color="#22c55e" value={stats?.clients || 0}    label="Clients"     onPress={() => router.push('/(tabs)/clients')} />
          <StatCard icon="time"        color="#f59e0b" value={stats?.rdvTotal || 0}   label="RDV total"   onPress={() => router.push('/(tabs)/agenda')} />
        </View>

        {/* Accès rapides */}
        <Text style={ss.sectionTitle}>Accès rapides</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={ss.quickRow}>
          <QuickBtn icon="megaphone"   label="Campagne"    color="#ec4899" onPress={() => router.push('/(tabs)/plus')} />
          <QuickBtn icon="star"        label="Fidélité"    color="#f59e0b" onPress={() => router.push('/(tabs)/plus')} />
          <QuickBtn icon="flash"       label="Flash deal"  color="#a855f7" onPress={() => router.push('/(tabs)/plus')} />
          <QuickBtn icon="settings"    label="Automatiser" color="#3b82f6" onPress={() => router.push('/(tabs)/plus')} />
        </ScrollView>

        {/* Derniers messages */}
        {convs.length > 0 && <>
          <View style={ss.sectionRow}>
            <Text style={ss.sectionTitle}>Derniers messages</Text>
            <TouchableOpacity onPress={() => router.push('/(tabs)/messages')}>
              <Text style={ss.seeAll}>Voir tout</Text>
            </TouchableOpacity>
          </View>
          {convs.map(c => (
            <TouchableOpacity key={c.id} style={ss.miniCard}
              onPress={() => router.push({ pathname: `/chat/${c.id}`, params: { clientName: c.client_prenom || c.client_name } })}>
              <View style={ss.miniAvatar}>
                <Text style={ss.miniAvatarTxt}>{(c.client_prenom || c.client_name || '?')[0].toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={ss.miniName}>{c.client_prenom || c.client_name || 'Client'}</Text>
                <Text style={ss.miniSub} numberOfLines={1}>{c.last_message || c.sujet || '...'}</Text>
              </View>
              {c.unread_count > 0 && (
                <View style={ss.unreadDot}><Text style={ss.unreadTxt}>{c.unread_count}</Text></View>
              )}
            </TouchableOpacity>
          ))}
        </>}

        {/* Prochains RDV */}
        {rdvs.length > 0 && <>
          <View style={ss.sectionRow}>
            <Text style={ss.sectionTitle}>Prochains RDV</Text>
            <TouchableOpacity onPress={() => router.push('/(tabs)/agenda')}>
              <Text style={ss.seeAll}>Voir tout</Text>
            </TouchableOpacity>
          </View>
          {rdvs.map(r => {
            const isToday = new Date(r.date_rdv || r.date).toDateString() === new Date().toDateString();
            return (
              <View key={r.id} style={ss.miniCard}>
                <View style={[ss.miniAvatar, { backgroundColor: '#1e3a5f' }]}>
                  <Ionicons name="calendar" size={18} color="#3b82f6" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={ss.miniName}>{r.client_name || r.prenom_client || 'Client'}</Text>
                  <Text style={ss.miniSub}>{r.description || 'Rendez-vous tatouage'}</Text>
                </View>
                {isToday && (
                  <View style={ss.newBadge}><Text style={ss.newBadgeTxt}>AUJD</Text></View>
                )}
              </View>
            );
          })}
        </>}

        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function StatCard({ icon, color, value, label, onPress }) {
  return (
    <TouchableOpacity style={ss.statCard} onPress={onPress} activeOpacity={0.8}>
      <View style={[ss.statIcon, { backgroundColor: color + '22' }]}>
        <Ionicons name={icon} size={22} color={color} />
      </View>
      <Text style={ss.statValue}>{value}</Text>
      <Text style={ss.statLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function QuickBtn({ icon, label, color, onPress }) {
  return (
    <TouchableOpacity style={ss.quickBtn} onPress={onPress} activeOpacity={0.8}>
      <View style={[ss.quickIcon, { backgroundColor: color + '22' }]}>
        <Ionicons name={icon} size={22} color={color} />
      </View>
      <Text style={ss.quickLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

const ss = StyleSheet.create({
  root:     { flex: 1, backgroundColor: '#0d0d0d' },
  center:   { flex: 1, alignItems: 'center', justifyContent: 'center' },
  greetRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingTop: 12 },
  greeting: { color: '#666', fontSize: 14 },
  name:     { color: '#fff', fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  avatarSmall: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#a855f7', alignItems: 'center', justifyContent: 'center' },
  avatarTxt:   { color: '#fff', fontSize: 18, fontWeight: '800' },

  // Bandeau AUJOURD'HUI
  todayBanner: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 16, marginBottom: 14,
    backgroundColor: 'rgba(168,85,247,0.1)',
    borderRadius: 16, padding: 14, gap: 12,
    borderWidth: 1, borderColor: 'rgba(168,85,247,0.3)',
  },
  todayLeft:   { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  todayDot:    { width: 8, height: 8, borderRadius: 4, backgroundColor: '#a855f7' },
  todayLabel:  { color: '#a855f7', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  todayCount:  { color: '#fff', fontSize: 15, fontWeight: '700', marginTop: 2 },
  todayAvatars:{ flexDirection: 'row', marginRight: 8 },
  todayAvatar: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#a855f7', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#0d0d0d' },
  todayAvatarTxt: { color: '#fff', fontSize: 10, fontWeight: '800' },

  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 16, marginBottom: 8 },
  statCard:  { flex: 1, minWidth: '45%', backgroundColor: '#1a1a1a', borderRadius: 16, padding: 16, gap: 8, borderWidth: 1, borderColor: '#2a2a2a' },
  statIcon:  { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  statValue: { color: '#fff', fontSize: 28, fontWeight: '800', letterSpacing: -1 },
  statLabel: { color: '#666', fontSize: 12, fontWeight: '600' },

  sectionTitle: { color: '#fff', fontSize: 16, fontWeight: '700', paddingHorizontal: 16, marginTop: 20, marginBottom: 10 },
  sectionRow:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingRight: 16 },
  seeAll:       { color: '#a855f7', fontSize: 13, fontWeight: '600' },
  quickRow:     { paddingHorizontal: 16, gap: 10, paddingBottom: 4 },
  quickBtn:     { alignItems: 'center', gap: 6, width: 76 },
  quickIcon:    { width: 56, height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  quickLabel:   { color: '#888', fontSize: 11, fontWeight: '600', textAlign: 'center' },

  miniCard:     { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  miniAvatar:   { width: 42, height: 42, borderRadius: 21, backgroundColor: '#2a2a2a', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  miniAvatarTxt:{ color: '#fff', fontSize: 16, fontWeight: '700' },
  miniName:     { color: '#fff', fontSize: 14, fontWeight: '600' },
  miniSub:      { color: '#666', fontSize: 12, marginTop: 2 },
  unreadDot:    { backgroundColor: '#a855f7', borderRadius: 10, minWidth: 20, height: 20, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  unreadTxt:    { color: '#fff', fontSize: 11, fontWeight: '800' },
  newBadge:     { backgroundColor: 'rgba(34,197,94,0.15)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: 'rgba(34,197,94,0.3)' },
  newBadgeTxt:  { color: '#22c55e', fontSize: 10, fontWeight: '800' },
});
