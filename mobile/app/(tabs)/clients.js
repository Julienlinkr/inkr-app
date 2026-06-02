/**
 * app/(tabs)/clients.js — CRM Clients
 *
 * Liste de tous les clients, recherche, fiche client avec historique.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  SafeAreaView, TextInput, RefreshControl, ActivityIndicator,
  Modal, ScrollView, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../hooks/useAuth';
import { apiFetch, API_BASE } from '../../constants/Api';

export default function ClientsScreen() {
  const { token }                     = useAuth();
  const [clients,  setClients]        = useState([]);
  const [filtered, setFiltered]       = useState([]);
  const [search,   setSearch]         = useState('');
  const [loading,  setLoading]        = useState(true);
  const [refresh,  setRefresh]        = useState(false);
  const [selected, setSelected]       = useState(null); // fiche client

  const load = useCallback(async () => {
    try {
      const res  = await apiFetch(`${API_BASE}/api/clients`, {}, token);
      const data = await res.json();
      if (Array.isArray(data)) {
        setClients(data);
        setFiltered(data);
      }
    } catch (e) {
      console.warn('[Clients]', e.message);
    } finally {
      setLoading(false);
      setRefresh(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  function doSearch(q) {
    setSearch(q);
    if (!q.trim()) { setFiltered(clients); return; }
    const ql = q.toLowerCase();
    setFiltered(clients.filter(c =>
      (c.name||'').toLowerCase().includes(ql) ||
      (c.email||'').toLowerCase().includes(ql) ||
      (c.phone||'').includes(ql) ||
      (c.city||'').toLowerCase().includes(ql)
    ));
  }

  function styleTag(style) {
    const colors = {
      'Fine Line': '#a855f7', 'Japonais': '#f59e0b', 'Réalisme': '#3b82f6',
      'Blackwork': '#6b7280', 'Tribal': '#22c55e', default: '#888',
    };
    return colors[style] || colors.default;
  }

  function renderClient({ item }) {
    const initial = (item.name || item.prenom || '?')[0].toUpperCase();
    const rdvCount = item.rdv_count || 0;
    return (
      <TouchableOpacity style={ss.clientRow} onPress={() => setSelected(item)} activeOpacity={0.75}>
        <View style={ss.clientAvatar}>
          <Text style={ss.clientAvatarTxt}>{initial}</Text>
        </View>
        <View style={ss.clientInfo}>
          <Text style={ss.clientName}>{item.name || item.prenom || 'Client'}</Text>
          <Text style={ss.clientSub} numberOfLines={1}>
            {item.email || ''}{item.city ? `  ·  ${item.city}` : ''}
          </Text>
          {item.styles && item.styles.length > 0 && (
            <Text style={[ss.clientTag, { color: styleTag(item.styles[0]) }]}>
              {item.styles[0]}
            </Text>
          )}
        </View>
        <View style={ss.clientRight}>
          {rdvCount > 0 && (
            <View style={ss.rdvBadge}>
              <Text style={ss.rdvBadgeTxt}>{rdvCount} RDV</Text>
            </View>
          )}
          <Ionicons name="chevron-forward" size={16} color="#444" />
        </View>
      </TouchableOpacity>
    );
  }

  if (loading) return (
    <SafeAreaView style={ss.root}>
      <View style={ss.center}><ActivityIndicator color="#a855f7" size="large" /></View>
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={ss.root}>
      {/* Header */}
      <View style={ss.header}>
        <Text style={ss.headerTitle}>Clients</Text>
        <View style={ss.countPill}>
          <Text style={ss.countTxt}>{clients.length}</Text>
        </View>
      </View>

      {/* Recherche */}
      <View style={ss.searchBar}>
        <Ionicons name="search" size={16} color="#555" />
        <TextInput
          style={ss.searchInput}
          placeholder="Nom, email, ville..."
          placeholderTextColor="#444"
          value={search}
          onChangeText={doSearch}
          autoCorrect={false}
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => doSearch('')}>
            <Ionicons name="close-circle" size={16} color="#555" />
          </TouchableOpacity>
        )}
      </View>

      {/* Liste */}
      {filtered.length === 0 ? (
        <View style={ss.center}>
          <Ionicons name="people-outline" size={56} color="#333" />
          <Text style={ss.emptyTitle}>{search ? 'Aucun résultat' : 'Aucun client'}</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={item => String(item.id)}
          renderItem={renderClient}
          refreshControl={<RefreshControl refreshing={refresh} onRefresh={() => { setRefresh(true); load(); }} tintColor="#a855f7" />}
          ItemSeparatorComponent={() => <View style={ss.sep} />}
          contentContainerStyle={{ paddingBottom: 20 }}
        />
      )}

      {/* Fiche client (Modal) */}
      <ClientModal client={selected} onClose={() => setSelected(null)} token={token} />
    </SafeAreaView>
  );
}

function ClientModal({ client, onClose, token }) {
  const [notes, setNotes] = useState(client?.notes || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => { setNotes(client?.notes || ''); }, [client]);

  if (!client) return null;

  async function saveNotes() {
    setSaving(true);
    try {
      await apiFetch(`${API_BASE}/api/clients/${client.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...client, notes }),
      }, token);
      Alert.alert('✓', 'Notes sauvegardées');
    } catch (e) {
      Alert.alert('Erreur', e.message);
    } finally {
      setSaving(false);
    }
  }

  const initial = (client.name || client.prenom || '?')[0].toUpperCase();

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={ms.root}>
        <View style={ms.handle} />

        {/* Header */}
        <View style={ms.header}>
          <TouchableOpacity onPress={onClose} style={ms.closeBtn}>
            <Ionicons name="close" size={22} color="#fff" />
          </TouchableOpacity>
          <Text style={ms.headerTitle}>Fiche client</Text>
          <View style={{ width: 36 }} />
        </View>

        <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
          {/* Avatar + nom */}
          <View style={ms.clientHeader}>
            <View style={ms.avatar}>
              <Text style={ms.avatarTxt}>{initial}</Text>
            </View>
            <Text style={ms.clientName}>{client.name || client.prenom}</Text>
            {client.city && <Text style={ms.clientCity}>📍 {client.city}</Text>}
          </View>

          {/* Infos */}
          <View style={ms.section}>
            {client.email && <InfoRow icon="mail"  label="Email"    value={client.email} />}
            {client.phone && <InfoRow icon="call"  label="Téléphone" value={client.phone} />}
            {client.instagram && <InfoRow icon="logo-instagram" label="Instagram" value={client.instagram} />}
          </View>

          {/* Styles préférés */}
          {client.styles?.length > 0 && (
            <View style={ms.section}>
              <Text style={ms.sectionTitle}>Styles préférés</Text>
              <View style={ms.tagsRow}>
                {client.styles.map(s => (
                  <View key={s} style={ms.tag}><Text style={ms.tagTxt}>{s}</Text></View>
                ))}
              </View>
            </View>
          )}

          {/* Stats */}
          <View style={[ms.section, ms.statsRow]}>
            <MiniStat label="RDV" value={client.rdv_count || 0} />
            <MiniStat label="Dépensé" value={`${client.total_spent || 0}€`} />
            <MiniStat label="Fidélité" value={`${client.loyalty_points || 0} pts`} />
          </View>

          {/* Notes */}
          <View style={ms.section}>
            <Text style={ms.sectionTitle}>Notes privées</Text>
            <TextInput
              style={ms.notesInput}
              value={notes}
              onChangeText={setNotes}
              multiline
              placeholder="Ajoute des notes sur ce client..."
              placeholderTextColor="#444"
            />
            <TouchableOpacity style={ms.saveBtn} onPress={saveNotes} disabled={saving}>
              <Text style={ms.saveBtnTxt}>{saving ? 'Sauvegarde...' : 'Sauvegarder les notes'}</Text>
            </TouchableOpacity>
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>
      </View>
    </Modal>
  );
}

function InfoRow({ icon, label, value }) {
  return (
    <View style={ms.infoRow}>
      <Ionicons name={icon} size={16} color="#a855f7" style={{ width: 20 }} />
      <View style={{ flex: 1 }}>
        <Text style={ms.infoLabel}>{label}</Text>
        <Text style={ms.infoValue}>{value}</Text>
      </View>
    </View>
  );
}

function MiniStat({ label, value }) {
  return (
    <View style={ms.miniStat}>
      <Text style={ms.miniStatVal}>{value}</Text>
      <Text style={ms.miniStatLbl}>{label}</Text>
    </View>
  );
}

const ss = StyleSheet.create({
  root:      { flex: 1, backgroundColor: '#0d0d0d' },
  center:    { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  header:    { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 10 },
  headerTitle: { fontSize: 28, fontWeight: '800', color: '#fff', letterSpacing: -0.5, flex: 1 },
  countPill: { backgroundColor: '#a855f7', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3 },
  countTxt:  { color: '#fff', fontWeight: '700', fontSize: 13 },
  searchBar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 10, backgroundColor: '#1a1a1a', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, borderWidth: 1, borderColor: '#2a2a2a' },
  searchInput: { flex: 1, color: '#fff', fontSize: 15 },
  emptyTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  sep:       { height: 1, backgroundColor: '#1a1a1a' },
  clientRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, gap: 12 },
  clientAvatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#2a2a2a', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  clientAvatarTxt: { color: '#fff', fontSize: 18, fontWeight: '700' },
  clientInfo: { flex: 1, gap: 3 },
  clientName: { color: '#fff', fontSize: 15, fontWeight: '600' },
  clientSub:  { color: '#666', fontSize: 12 },
  clientTag:  { fontSize: 11, fontWeight: '600', marginTop: 2 },
  clientRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rdvBadge:  { backgroundColor: '#1e3a5f', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 },
  rdvBadgeTxt: { color: '#3b82f6', fontSize: 11, fontWeight: '700' },
});

const ms = StyleSheet.create({
  root:    { flex: 1, backgroundColor: '#0d0d0d' },
  handle:  { width: 40, height: 4, backgroundColor: '#333', borderRadius: 2, alignSelf: 'center', marginTop: 10 },
  header:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
  closeBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  clientHeader: { alignItems: 'center', paddingVertical: 20, gap: 6, borderBottomWidth: 1, borderBottomColor: '#1e1e1e' },
  avatar:   { width: 72, height: 72, borderRadius: 36, backgroundColor: '#a855f7', alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  avatarTxt: { color: '#fff', fontSize: 28, fontWeight: '800' },
  clientName: { color: '#fff', fontSize: 20, fontWeight: '700' },
  clientCity: { color: '#666', fontSize: 13 },
  section:   { padding: 16, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  sectionTitle: { color: '#fff', fontSize: 14, fontWeight: '700', marginBottom: 10 },
  infoRow:   { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 6 },
  infoLabel: { color: '#666', fontSize: 11, marginBottom: 2 },
  infoValue: { color: '#fff', fontSize: 14 },
  tagsRow:   { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tag:       { backgroundColor: 'rgba(168,85,247,0.15)', borderRadius: 20, paddingHorizontal: 12, paddingVertical: 5, borderWidth: 1, borderColor: 'rgba(168,85,247,0.3)' },
  tagTxt:    { color: '#a855f7', fontSize: 12, fontWeight: '600' },
  statsRow:  { flexDirection: 'row', justifyContent: 'space-around' },
  miniStat:  { alignItems: 'center', gap: 4 },
  miniStatVal: { color: '#fff', fontSize: 22, fontWeight: '800' },
  miniStatLbl: { color: '#666', fontSize: 12 },
  notesInput: { backgroundColor: '#111', borderRadius: 12, borderWidth: 1, borderColor: '#2a2a2a', padding: 14, color: '#fff', fontSize: 14, minHeight: 100, textAlignVertical: 'top' },
  saveBtn:   { backgroundColor: 'rgba(168,85,247,0.15)', borderRadius: 10, padding: 12, alignItems: 'center', marginTop: 10, borderWidth: 1, borderColor: 'rgba(168,85,247,0.3)' },
  saveBtnTxt: { color: '#a855f7', fontWeight: '700', fontSize: 14 },
});
