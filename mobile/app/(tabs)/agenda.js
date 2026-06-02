/**
 * app/(tabs)/agenda.js — Agenda rendez-vous
 *
 * Affiche les prochains RDV du tatoueur.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, StyleSheet, SafeAreaView,
  RefreshControl, ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../hooks/useAuth';
import { apiFetch, EP } from '../../constants/Api';

const DAYS_FR = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const MONTHS_FR = ['jan', 'fév', 'mar', 'avr', 'mai', 'jun', 'jul', 'aoû', 'sep', 'oct', 'nov', 'déc'];

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return {
    day:   DAYS_FR[d.getDay()],
    date:  d.getDate(),
    month: MONTHS_FR[d.getMonth()],
    time:  d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
  };
}

function statusColor(status) {
  switch (status) {
    case 'confirmed': return '#22c55e';
    case 'pending':   return '#f59e0b';
    case 'cancelled': return '#ef4444';
    default:          return '#666';
  }
}

function statusLabel(status) {
  switch (status) {
    case 'confirmed': return 'Confirmé';
    case 'pending':   return 'En attente';
    case 'cancelled': return 'Annulé';
    default:          return status;
  }
}

export default function AgendaScreen() {
  const { token }                  = useAuth();
  const [rdvs,    setRdvs]        = useState([]);
  const [loading, setLoading]     = useState(true);
  const [refresh, setRefresh]     = useState(false);
  const [filter,  setFilter]      = useState('upcoming'); // 'upcoming' | 'all'

  const load = useCallback(async () => {
    try {
      const res  = await apiFetch(EP.appointments, {}, token);
      const data = await res.json();
      if (Array.isArray(data)) setRdvs(data);
    } catch (e) {
      console.warn('[Agenda] load error:', e.message);
    } finally {
      setLoading(false);
      setRefresh(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const filtered = rdvs.filter(r => {
    if (filter === 'all') return true;
    return new Date(r.date_rdv || r.date) >= new Date();
  });

  function renderRdv({ item }) {
    const d = formatDate(item.date_rdv || item.date || new Date().toISOString());
    return (
      <View style={styles.card}>
        {/* Date bloc */}
        <View style={styles.dateBadge}>
          <Text style={styles.dateDay}>{d.day}</Text>
          <Text style={styles.dateNum}>{d.date}</Text>
          <Text style={styles.dateMon}>{d.month}</Text>
        </View>

        {/* Infos */}
        <View style={styles.cardInfo}>
          <Text style={styles.clientName}>
            {item.client_name || item.prenom_client || 'Client'}
          </Text>
          <Text style={styles.cardDetail}>
            <Ionicons name="time-outline" size={12} color="#666" /> {d.time}
            {item.duree ? `  ·  ${item.duree}h` : ''}
          </Text>
          {item.description && (
            <Text style={styles.cardDesc} numberOfLines={1}>{item.description}</Text>
          )}
        </View>

        {/* Status */}
        <View style={[styles.statusDot, { backgroundColor: statusColor(item.status) }]}>
          <Text style={styles.statusText}>{statusLabel(item.status)}</Text>
        </View>
      </View>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Agenda</Text>
        </View>
        <View style={styles.center}>
          <ActivityIndicator color="#a855f7" size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Agenda</Text>
      </View>

      {/* Filtres */}
      <View style={styles.filterRow}>
        {['upcoming', 'all'].map(f => (
          <TouchableOpacity
            key={f}
            style={[styles.filterBtn, filter === f && styles.filterBtnActive]}
            onPress={() => setFilter(f)}
          >
            <Text style={[styles.filterText, filter === f && styles.filterTextActive]}>
              {f === 'upcoming' ? '📅 À venir' : '🗓 Tous'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {filtered.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="calendar-outline" size={56} color="#333" />
          <Text style={styles.emptyTitle}>Aucun rendez-vous</Text>
          <Text style={styles.emptyText}>
            {filter === 'upcoming'
              ? 'Pas de RDV à venir pour l\'instant.'
              : 'Aucun RDV dans l\'historique.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={item => String(item.id)}
          renderItem={renderRdv}
          refreshControl={
            <RefreshControl
              refreshing={refresh}
              onRefresh={() => { setRefresh(true); load(); }}
              tintColor="#a855f7"
            />
          }
          contentContainerStyle={{ padding: 16, gap: 12 }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: '#0d0d0d' },
  header: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1e1e1e',
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: -0.5,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  emptyTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  emptyText: { color: '#555', fontSize: 14, textAlign: 'center', paddingHorizontal: 40 },
  filterRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  filterBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  filterBtnActive: { backgroundColor: 'rgba(168,85,247,0.15)', borderColor: '#a855f7' },
  filterText: { color: '#666', fontSize: 13, fontWeight: '600' },
  filterTextActive: { color: '#a855f7' },
  card: {
    backgroundColor: '#1a1a1a',
    borderRadius: 16,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  dateBadge: {
    width: 52,
    height: 60,
    backgroundColor: '#111',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  dateDay: { color: '#a855f7', fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  dateNum: { color: '#fff', fontSize: 22, fontWeight: '800', lineHeight: 26 },
  dateMon: { color: '#666', fontSize: 11 },
  cardInfo: { flex: 1, gap: 4 },
  clientName: { color: '#fff', fontSize: 16, fontWeight: '700' },
  cardDetail: { color: '#666', fontSize: 13 },
  cardDesc:   { color: '#555', fontSize: 12 },
  statusDot: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    opacity: 0.9,
  },
  statusText: { color: '#fff', fontSize: 11, fontWeight: '700' },
});
