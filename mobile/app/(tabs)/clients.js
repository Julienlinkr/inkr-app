/**
 * app/(tabs)/clients.js — CRM Clients
 *
 * Liste, recherche, fiche client + bouton + pour créer un client directement.
 * Synchronisé avec la BDD via endpoint mobile Bearer auth.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  SafeAreaView, TextInput, RefreshControl, ActivityIndicator,
  Modal, ScrollView, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../hooks/useAuth';
import { apiFetch, EP } from '../../constants/Api';
import AppHeader from '../../components/AppHeader';

const ALL_STYLES = ['Japonais', 'Fine Line', 'Réalisme', 'Géométrique', 'Tribal', 'Old School', 'Aquarelle', 'Animaux', 'Flash', 'Blackwork', 'Lettering', 'Chicano', 'Dotwork'];

export default function ClientsScreen() {
  const { token }                   = useAuth();
  const [clients,  setClients]      = useState([]);
  const [filtered, setFiltered]     = useState([]);
  const [search,   setSearch]       = useState('');
  const [loading,  setLoading]      = useState(true);
  const [refresh,  setRefresh]      = useState(false);
  const [selected, setSelected]     = useState(null);
  const [creating, setCreating]     = useState(false);

  const load = useCallback(async () => {
    try {
      const res  = await apiFetch(EP.clients, {}, token);
      const data = await res.json();
      if (Array.isArray(data)) { setClients(data); setFiltered(data); }
    } catch (e) { console.warn('[Clients]', e.message); }
    finally { setLoading(false); setRefresh(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  function doSearch(q) {
    setSearch(q);
    if (!q.trim()) { setFiltered(clients); return; }
    const ql = q.toLowerCase();
    setFiltered(clients.filter(c =>
      (c.name || '').toLowerCase().includes(ql) ||
      (c.prenom || '').toLowerCase().includes(ql) ||
      (c.email || '').toLowerCase().includes(ql) ||
      (c.phone || '').includes(ql) ||
      (c.city || '').toLowerCase().includes(ql)
    ));
  }

  function renderClient({ item }) {
    const displayName = [item.prenom, item.name].filter(Boolean).join(' ') || 'Client';
    const initial = displayName[0].toUpperCase();
    const rdvCount = item.rdv_count || 0;
    let stylesArr = [];
    try { stylesArr = JSON.parse(item.styles || item.tags || '[]'); } catch {}
    const styleColors = { 'Fine Line': '#a855f7', 'Japonais': '#f59e0b', 'Réalisme': '#3b82f6', 'Blackwork': '#6b7280', 'Tribal': '#22c55e' };

    return (
      <TouchableOpacity style={ss.clientRow} onPress={() => setSelected(item)} activeOpacity={0.75}>
        <View style={ss.clientAvatar}><Text style={ss.clientAvatarTxt}>{initial}</Text></View>
        <View style={ss.clientInfo}>
          <Text style={ss.clientName}>{displayName}</Text>
          <Text style={ss.clientSub} numberOfLines={1}>
            {item.email || ''}{item.city ? `  ·  ${item.city}` : ''}
          </Text>
          {stylesArr.length > 0 && (
            <Text style={[ss.clientTag, { color: styleColors[stylesArr[0]] || '#888' }]}>{stylesArr[0]}</Text>
          )}
        </View>
        <View style={ss.clientRight}>
          {rdvCount > 0 && (
            <View style={ss.rdvBadge}><Text style={ss.rdvBadgeTxt}>{rdvCount} RDV</Text></View>
          )}
          <Ionicons name="chevron-forward" size={16} color="#444" />
        </View>
      </TouchableOpacity>
    );
  }

  const AddBtn = () => (
    <TouchableOpacity style={ss.addBtn} onPress={() => setCreating(true)}>
      <Ionicons name="add" size={22} color="#a855f7" />
    </TouchableOpacity>
  );

  if (loading) return (
    <SafeAreaView style={ss.root}>
      <AppHeader title="Clients" right={<AddBtn />} />
      <View style={ss.center}><ActivityIndicator color="#a855f7" size="large" /></View>
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={ss.root}>
      <AppHeader title={`Clients · ${clients.length}`} right={<AddBtn />} />

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

      {filtered.length === 0 ? (
        <View style={ss.center}>
          <Ionicons name="people-outline" size={56} color="#333" />
          <Text style={ss.emptyTitle}>{search ? 'Aucun résultat' : 'Aucun client'}</Text>
          {!search && <Text style={ss.emptyHint}>Appuie sur + pour ajouter ton premier client.</Text>}
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

      <ClientModal client={selected} onClose={() => setSelected(null)} token={token} onSaved={load} />
      <CreateClientModal visible={creating} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} token={token} />
    </SafeAreaView>
  );
}

// ── Fiche client ──────────────────────────────────────────────────────────────
function ClientModal({ client, onClose, token, onSaved }) {
  const [notes, setNotes]   = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setNotes(client?.notes || ''); }, [client]);
  if (!client) return null;

  const displayName = [client.prenom, client.name].filter(Boolean).join(' ') || 'Client';
  let stylesArr = [];
  try { stylesArr = JSON.parse(client.styles || client.tags || '[]'); } catch {}

  async function saveNotes() {
    setSaving(true);
    try {
      await apiFetch(EP.client(client.id), { method: 'PUT', body: JSON.stringify({ ...client, notes }) }, token);
      Alert.alert('✓', 'Notes sauvegardées');
      onSaved?.();
    } catch (e) { Alert.alert('Erreur', e.message); }
    finally { setSaving(false); }
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={fm.root}>
        <View style={fm.handle} />
        <View style={fm.header}>
          <TouchableOpacity onPress={onClose} style={fm.closeBtn}><Ionicons name="close" size={22} color="#fff" /></TouchableOpacity>
          <Text style={fm.headerTitle}>Fiche client</Text>
          <View style={{ width: 36 }} />
        </View>
        <ScrollView showsVerticalScrollIndicator={false}>
          <View style={fm.clientHeader}>
            <View style={fm.avatar}><Text style={fm.avatarTxt}>{displayName[0].toUpperCase()}</Text></View>
            <Text style={fm.clientName}>{displayName}</Text>
            {client.city && <Text style={fm.clientCity}>📍 {client.city}</Text>}
          </View>
          <View style={fm.section}>
            {client.email     && <InfoRow icon="mail"           label="Email"     value={client.email} />}
            {client.phone     && <InfoRow icon="call"           label="Téléphone" value={client.phone} />}
            {client.instagram && <InfoRow icon="logo-instagram" label="Instagram" value={client.instagram} />}
          </View>
          {stylesArr.length > 0 && (
            <View style={fm.section}>
              <Text style={fm.sectionTitle}>Styles préférés</Text>
              <View style={fm.tagsRow}>
                {stylesArr.map(s => <View key={s} style={fm.tag}><Text style={fm.tagTxt}>{s}</Text></View>)}
              </View>
            </View>
          )}
          <View style={[fm.section, fm.statsRow]}>
            <MiniStat label="RDV"      value={client.rdv_count || 0} />
            <MiniStat label="Dépensé"  value={`${client.total_spent || 0}€`} />
            <MiniStat label="Fidélité" value={`${client.loyalty_points || 0} pts`} />
          </View>
          <View style={fm.section}>
            <Text style={fm.sectionTitle}>Notes privées</Text>
            <TextInput style={fm.notesInput} value={notes} onChangeText={setNotes} multiline placeholder="Notes sur ce client..." placeholderTextColor="#444" />
            <TouchableOpacity style={fm.saveBtn} onPress={saveNotes} disabled={saving}>
              <Text style={fm.saveBtnTxt}>{saving ? 'Sauvegarde...' : 'Sauvegarder les notes'}</Text>
            </TouchableOpacity>
          </View>
          <View style={{ height: 40 }} />
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Créer client ──────────────────────────────────────────────────────────────
function CreateClientModal({ visible, onClose, onCreated, token }) {
  const [prenom, setPrenom]     = useState('');
  const [nom,    setNom]        = useState('');
  const [email,  setEmail]      = useState('');
  const [phone,  setPhone]      = useState('');
  const [city,   setCity]       = useState('');
  const [insta,  setInsta]      = useState('');
  const [selStyles, setStyles]  = useState([]);
  const [saving, setSaving]     = useState(false);

  useEffect(() => {
    if (!visible) { setPrenom(''); setNom(''); setEmail(''); setPhone(''); setCity(''); setInsta(''); setStyles([]); }
  }, [visible]);

  function toggleStyle(s) {
    setStyles(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);
  }

  async function save() {
    if (!nom.trim() && !prenom.trim()) { Alert.alert('Requis', 'Entrez un nom ou prénom.'); return; }
    setSaving(true);
    try {
      const res  = await apiFetch(EP.clients, {
        method: 'POST',
        body: JSON.stringify({ prenom: prenom.trim(), name: nom.trim(), email: email.trim(), phone: phone.trim(), city: city.trim(), instagram: insta.trim(), tags: selStyles }),
      }, token);
      const data = await res.json();
      if (data.success) { Alert.alert('✓ Client créé !', [prenom, nom].filter(Boolean).join(' ')); onCreated(); }
      else Alert.alert('Erreur', data.error || 'Impossible de créer le client');
    } catch (e) { Alert.alert('Erreur', e.message); }
    finally { setSaving(false); }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={cm.root}>
        <View style={cm.handle} />
        <View style={cm.header}>
          <TouchableOpacity onPress={onClose} style={cm.closeBtn}><Ionicons name="close" size={20} color="#fff" /></TouchableOpacity>
          <Text style={cm.headerTitle}>Nouveau client</Text>
          <View style={{ width: 36 }} />
        </View>
        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 14 }}>
          <View style={cm.row}>
            <View style={{ flex: 1 }}>
              <Text style={cm.label}>Prénom</Text>
              <TextInput style={cm.input} placeholder="Prénom" placeholderTextColor="#444" value={prenom} onChangeText={setPrenom} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={cm.label}>Nom</Text>
              <TextInput style={cm.input} placeholder="Nom" placeholderTextColor="#444" value={nom} onChangeText={setNom} />
            </View>
          </View>
          <View><Text style={cm.label}>Email</Text><TextInput style={cm.input} placeholder="email@exemple.com" placeholderTextColor="#444" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" /></View>
          <View><Text style={cm.label}>Téléphone</Text><TextInput style={cm.input} placeholder="+33 6 ..." placeholderTextColor="#444" value={phone} onChangeText={setPhone} keyboardType="phone-pad" /></View>
          <View><Text style={cm.label}>Ville</Text><TextInput style={cm.input} placeholder="Paris, Lyon..." placeholderTextColor="#444" value={city} onChangeText={setCity} /></View>
          <View><Text style={cm.label}>Instagram</Text><TextInput style={cm.input} placeholder="@handle" placeholderTextColor="#444" value={insta} onChangeText={setInsta} autoCapitalize="none" /></View>

          <Text style={cm.label}>Styles préférés</Text>
          <View style={cm.stylesGrid}>
            {ALL_STYLES.map(s => {
              const active = selStyles.includes(s);
              return (
                <TouchableOpacity key={s} onPress={() => toggleStyle(s)}>
                  <View style={[cm.chip, active && cm.chipActive]}>
                    {active && <Ionicons name="checkmark" size={11} color="#a855f7" />}
                    <Text style={[cm.chipTxt, active && cm.chipTxtActive]}>{s}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          <TouchableOpacity style={cm.saveBtn} onPress={save} disabled={saving}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={cm.saveBtnTxt}>✓ Créer le client</Text>}
          </TouchableOpacity>
          <View style={{ height: 40 }} />
        </ScrollView>
      </View>
    </Modal>
  );
}

function InfoRow({ icon, label, value }) {
  return (
    <View style={fm.infoRow}>
      <Ionicons name={icon} size={16} color="#a855f7" style={{ width: 20 }} />
      <View style={{ flex: 1 }}>
        <Text style={fm.infoLabel}>{label}</Text>
        <Text style={fm.infoValue}>{value}</Text>
      </View>
    </View>
  );
}

function MiniStat({ label, value }) {
  return (
    <View style={fm.miniStat}>
      <Text style={fm.miniStatVal}>{value}</Text>
      <Text style={fm.miniStatLbl}>{label}</Text>
    </View>
  );
}

const ss = StyleSheet.create({
  root:      { flex: 1, backgroundColor: '#0d0d0d' },
  center:    { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  addBtn:    { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(168,85,247,0.15)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(168,85,247,0.3)' },
  emptyTitle:{ color: '#fff', fontSize: 18, fontWeight: '700' },
  emptyHint: { color: '#555', fontSize: 14, textAlign: 'center', paddingHorizontal: 40 },
  sep:       { height: 1, backgroundColor: '#1a1a1a' },
  searchBar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 10, backgroundColor: '#1a1a1a', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, borderWidth: 1, borderColor: '#2a2a2a' },
  searchInput:{ flex: 1, color: '#fff', fontSize: 15 },
  clientRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, gap: 12 },
  clientAvatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#2a2a2a', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  clientAvatarTxt: { color: '#fff', fontSize: 18, fontWeight: '700' },
  clientInfo: { flex: 1, gap: 3 },
  clientName: { color: '#fff', fontSize: 15, fontWeight: '600' },
  clientSub:  { color: '#666', fontSize: 12 },
  clientTag:  { fontSize: 11, fontWeight: '600', marginTop: 2 },
  clientRight:{ flexDirection: 'row', alignItems: 'center', gap: 6 },
  rdvBadge:  { backgroundColor: '#1e3a5f', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 },
  rdvBadgeTxt:{ color: '#3b82f6', fontSize: 11, fontWeight: '700' },
});

const fm = StyleSheet.create({
  root:    { flex: 1, backgroundColor: '#0d0d0d' },
  handle:  { width: 40, height: 4, backgroundColor: '#333', borderRadius: 2, alignSelf: 'center', marginTop: 10 },
  header:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
  closeBtn:{ width: 36, height: 36, borderRadius: 18, backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center' },
  headerTitle:{ color: '#fff', fontSize: 16, fontWeight: '700' },
  clientHeader:{ alignItems: 'center', paddingVertical: 20, gap: 6, borderBottomWidth: 1, borderBottomColor: '#1e1e1e' },
  avatar:  { width: 72, height: 72, borderRadius: 36, backgroundColor: '#a855f7', alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  avatarTxt:{ color: '#fff', fontSize: 28, fontWeight: '800' },
  clientName:{ color: '#fff', fontSize: 20, fontWeight: '700' },
  clientCity:{ color: '#666', fontSize: 13 },
  section: { padding: 16, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  sectionTitle:{ color: '#fff', fontSize: 14, fontWeight: '700', marginBottom: 10 },
  infoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 6 },
  infoLabel:{ color: '#666', fontSize: 11, marginBottom: 2 },
  infoValue:{ color: '#fff', fontSize: 14 },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tag:     { backgroundColor: 'rgba(168,85,247,0.15)', borderRadius: 20, paddingHorizontal: 12, paddingVertical: 5, borderWidth: 1, borderColor: 'rgba(168,85,247,0.3)' },
  tagTxt:  { color: '#a855f7', fontSize: 12, fontWeight: '600' },
  statsRow:{ flexDirection: 'row', justifyContent: 'space-around' },
  miniStat:{ alignItems: 'center', gap: 4 },
  miniStatVal:{ color: '#fff', fontSize: 22, fontWeight: '800' },
  miniStatLbl:{ color: '#666', fontSize: 12 },
  notesInput:{ backgroundColor: '#111', borderRadius: 12, borderWidth: 1, borderColor: '#2a2a2a', padding: 14, color: '#fff', fontSize: 14, minHeight: 100, textAlignVertical: 'top' },
  saveBtn: { backgroundColor: 'rgba(168,85,247,0.15)', borderRadius: 10, padding: 12, alignItems: 'center', marginTop: 10, borderWidth: 1, borderColor: 'rgba(168,85,247,0.3)' },
  saveBtnTxt:{ color: '#a855f7', fontWeight: '700', fontSize: 14 },
});

const cm = StyleSheet.create({
  root:    { flex: 1, backgroundColor: '#0d0d0d' },
  handle:  { width: 40, height: 4, backgroundColor: '#333', borderRadius: 2, alignSelf: 'center', marginTop: 10 },
  header:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
  closeBtn:{ width: 36, height: 36, borderRadius: 18, backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center' },
  headerTitle:{ color: '#fff', fontSize: 17, fontWeight: '700' },
  row:     { flexDirection: 'row', gap: 12 },
  label:   { color: 'rgba(255,255,255,0.4)', fontSize: 12, fontWeight: '600', marginBottom: 6 },
  input:   { backgroundColor: '#1a1a1a', borderRadius: 12, borderWidth: 1, borderColor: '#2a2a2a', paddingHorizontal: 14, paddingVertical: 12, color: '#fff', fontSize: 15 },
  stylesGrid:{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip:    { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#2a2a2a' },
  chipActive:{ backgroundColor: 'rgba(168,85,247,0.12)', borderColor: '#a855f7' },
  chipTxt: { color: '#666', fontSize: 13, fontWeight: '600' },
  chipTxtActive:{ color: '#a855f7' },
  saveBtn: { backgroundColor: '#a855f7', borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 8 },
  saveBtnTxt:{ color: '#fff', fontWeight: '800', fontSize: 16 },
});
