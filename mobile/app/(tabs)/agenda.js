/**
 * app/(tabs)/agenda.js — Agenda rendez-vous
 *
 * Liste les RDV, pastille AUJOURD'HUI, bouton + pour créer un RDV.
 * Création : choix client existant ou nom libre, date, heure, style, description.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, StyleSheet, SafeAreaView,
  RefreshControl, ActivityIndicator, TouchableOpacity,
  Modal, ScrollView, TextInput, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../hooks/useAuth';
import { apiFetch, EP } from '../../constants/Api';
import AppHeader from '../../components/AppHeader';

const DAYS_FR   = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const MONTHS_FR = ['jan', 'fév', 'mar', 'avr', 'mai', 'jun', 'jul', 'aoû', 'sep', 'oct', 'nov', 'déc'];
const STYLES    = ['Fine Line', 'Réalisme', 'Japonais', 'Blackwork', 'Old School', 'Géométrique', 'Tribal', 'Aquarelle', 'Flash', 'Chicano', 'Lettering', 'Dotwork'];
const ZONES     = ['Bras', 'Avant-bras', 'Épaule', 'Dos', 'Torse', 'Jambe', 'Cheville', 'Nuque', 'Doigt', 'Côtes', 'Mollet'];
const HOURS     = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00'];

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return {
    day:   DAYS_FR[d.getDay()],
    date:  d.getDate(),
    month: MONTHS_FR[d.getMonth()],
    time:  d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
    isToday: d.toDateString() === new Date().toDateString(),
  };
}

function statusColor(s) {
  return s === 'confirmed' ? '#22c55e' : s === 'pending' ? '#f59e0b' : s === 'cancelled' ? '#ef4444' : '#666';
}
function statusLabel(s) {
  return s === 'confirmed' ? 'Confirmé' : s === 'pending' ? 'En attente' : s === 'cancelled' ? 'Annulé' : s;
}

// Génère les 30 prochains jours comme options sélectionnables
function nextDays(n = 30) {
  const days = [];
  for (let i = 0; i < n; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    days.push({
      label: i === 0 ? "Auj." : i === 1 ? "Dem." : `${DAYS_FR[d.getDay()]} ${d.getDate()} ${MONTHS_FR[d.getMonth()]}`,
      short: i === 0 ? "Auj." : i === 1 ? "Dem." : `${d.getDate()} ${MONTHS_FR[d.getMonth()]}`,
      value: d.toISOString().split('T')[0],
    });
  }
  return days;
}

export default function AgendaScreen() {
  const { token }                    = useAuth();
  const [rdvs,     setRdvs]         = useState([]);
  const [loading,  setLoading]      = useState(true);
  const [refresh,  setRefresh]      = useState(false);
  const [filter,   setFilter]       = useState('upcoming');
  const [creating, setCreating]     = useState(false);

  const load = useCallback(async () => {
    try {
      const res  = await apiFetch(EP.appointments, {}, token);
      const data = await res.json();
      if (Array.isArray(data)) setRdvs(data);
    } catch (e) {
      console.warn('[Agenda]', e.message);
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

  async function deleteRdv(id) {
    Alert.alert('Supprimer ce RDV ?', '', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Supprimer', style: 'destructive', onPress: async () => {
        try {
          await apiFetch(EP.appointmentDelete(id), { method: 'DELETE' }, token);
          load();
        } catch (e) { Alert.alert('Erreur', e.message); }
      }},
    ]);
  }

  function renderRdv({ item }) {
    const d = formatDate(item.date_rdv || item.date || new Date().toISOString());
    return (
      <View style={[styles.card, d.isToday && styles.cardToday]}>
        {/* Pastille AUJOURD'HUI */}
        {d.isToday && (
          <View style={styles.todayPill}>
            <Text style={styles.todayPillTxt}>AUJOURD'HUI</Text>
          </View>
        )}

        <View style={styles.cardRow}>
          {/* Date */}
          <View style={[styles.dateBadge, d.isToday && { backgroundColor: 'rgba(168,85,247,0.15)' }]}>
            <Text style={styles.dateDay}>{d.day}</Text>
            <Text style={styles.dateNum}>{d.date}</Text>
            <Text style={styles.dateMon}>{d.month}</Text>
          </View>

          {/* Infos */}
          <View style={styles.cardInfo}>
            <Text style={styles.clientName}>{item.client_name || item.prenom_client || 'Client'}</Text>
            <Text style={styles.cardDetail}>
              <Ionicons name="time-outline" size={12} color="#666" /> {item.time || d.time}
              {item.style ? `  ·  ${item.style}` : ''}
            </Text>
            {item.description && (
              <Text style={styles.cardDesc} numberOfLines={1}>{item.description}</Text>
            )}
          </View>

          {/* Statut + suppression */}
          <View style={{ alignItems: 'flex-end', gap: 8 }}>
            <View style={[styles.statusPill, { backgroundColor: statusColor(item.status) + '22' }]}>
              <Text style={[styles.statusText, { color: statusColor(item.status) }]}>{statusLabel(item.status)}</Text>
            </View>
            <TouchableOpacity onPress={() => deleteRdv(item.id)}>
              <Ionicons name="trash-outline" size={16} color="#444" />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  const AddBtn = () => (
    <TouchableOpacity style={styles.addBtn} onPress={() => setCreating(true)}>
      <Ionicons name="add" size={22} color="#a855f7" />
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.root}>
      <AppHeader title="Agenda" right={<AddBtn />} />

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

      {loading ? (
        <View style={styles.center}><ActivityIndicator color="#a855f7" size="large" /></View>
      ) : filtered.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="calendar-outline" size={56} color="#333" />
          <Text style={styles.emptyTitle}>Aucun rendez-vous</Text>
          <Text style={styles.emptyText}>
            Appuie sur + pour créer ton premier RDV.
          </Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={item => String(item.id)}
          renderItem={renderRdv}
          refreshControl={
            <RefreshControl refreshing={refresh} onRefresh={() => { setRefresh(true); load(); }} tintColor="#a855f7" />
          }
          contentContainerStyle={{ padding: 16, gap: 12 }}
        />
      )}

      {/* Modal création RDV */}
      <CreateRdvModal
        visible={creating}
        onClose={() => setCreating(false)}
        onCreated={() => { setCreating(false); load(); }}
        token={token}
      />
    </SafeAreaView>
  );
}

// ── Modal création RDV ────────────────────────────────────────────────────────
function CreateRdvModal({ visible, onClose, onCreated, token }) {
  const DAYS = nextDays(30);
  const [step,        setStep]       = useState(1); // 1=client 2=date 3=heure 4=infos
  const [clientName,  setClientName] = useState('');
  const [clientEmail, setEmail]      = useState('');
  const [clientPhone, setPhone]      = useState('');
  const [clients,     setClients]    = useState([]);
  const [search,      setSearch]     = useState('');
  const [selectedDay, setDay]        = useState(DAYS[0].value);
  const [selectedTime,setTime]       = useState('');
  const [style,       setStyle]      = useState('');
  const [zone,        setZone]       = useState('');
  const [desc,        setDesc]       = useState('');
  const [saving,      setSaving]     = useState(false);

  useEffect(() => {
    if (!visible) { setStep(1); setClientName(''); setEmail(''); setPhone(''); setStyle(''); setZone(''); setDesc(''); setSelectedTime_(''); return; }
    // Charger les clients pour la recherche
    apiFetch(EP.clients, {}, token)
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setClients(d); })
      .catch(() => {});
  }, [visible]);

  // hack pour reset time
  function setSelectedTime_(t) { setTime(t); }

  const filtered = search.trim()
    ? clients.filter(c => (c.name + ' ' + c.prenom).toLowerCase().includes(search.toLowerCase()))
    : [];

  function pickClient(c) {
    setClientName((c.prenom || '') + (c.name ? ' ' + c.name : ''));
    setEmail(c.email || '');
    setPhone(c.phone || '');
    setSearch('');
    setStep(2);
  }

  async function save() {
    if (!clientName.trim()) { Alert.alert('Requis', 'Nom du client manquant'); return; }
    if (!selectedDay)       { Alert.alert('Requis', 'Choisis une date'); return; }
    setSaving(true);
    try {
      const res  = await apiFetch(EP.appointments, {
        method: 'POST',
        body: JSON.stringify({
          client_name:  clientName.trim(),
          client_email: clientEmail,
          client_phone: clientPhone,
          style,
          body_zone:    zone,
          description:  desc,
          date:         selectedDay,
          time:         selectedTime,
        }),
      }, token);
      const data = await res.json();
      if (data.success) {
        Alert.alert('✓ RDV créé !', `${clientName} — ${selectedDay}${selectedTime ? ' à ' + selectedTime : ''}`);
        onCreated();
      } else {
        Alert.alert('Erreur', data.error || 'Impossible de créer le RDV');
      }
    } catch (e) {
      Alert.alert('Erreur', e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={ms.root}>
        <View style={ms.handle} />

        {/* Header */}
        <View style={ms.header}>
          <TouchableOpacity onPress={onClose} style={ms.closeBtn}>
            <Ionicons name="close" size={20} color="#fff" />
          </TouchableOpacity>
          <Text style={ms.headerTitle}>Nouveau RDV</Text>
          <View style={{ width: 36 }} />
        </View>

        {/* Étapes */}
        <View style={ms.steps}>
          {[1,2,3,4].map(s => (
            <TouchableOpacity key={s} onPress={() => s < step && setStep(s)} style={ms.stepWrap}>
              <View style={[ms.stepDot, step >= s && ms.stepDotActive]}>
                <Text style={[ms.stepNum, step >= s && ms.stepNumActive]}>{s}</Text>
              </View>
              <Text style={[ms.stepLbl, step >= s && ms.stepLblActive]}>
                {s === 1 ? 'Client' : s === 2 ? 'Date' : s === 3 ? 'Heure' : 'Infos'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 14 }}>

          {/* ─── Étape 1 : Client ─── */}
          {step === 1 && (
            <View style={{ gap: 12 }}>
              <Text style={ms.stepTitle}>Quel client ?</Text>
              <TextInput
                style={ms.input}
                placeholder="Rechercher un client existant..."
                placeholderTextColor="#444"
                value={search}
                onChangeText={setSearch}
                autoFocus
              />
              {filtered.slice(0, 5).map(c => (
                <TouchableOpacity key={c.id} style={ms.clientRow} onPress={() => pickClient(c)}>
                  <View style={ms.clientAvatar}>
                    <Text style={ms.clientAvatarTxt}>{(c.prenom || c.name || '?')[0].toUpperCase()}</Text>
                  </View>
                  <View>
                    <Text style={ms.clientRowName}>{c.prenom} {c.name}</Text>
                    {c.email && <Text style={ms.clientRowSub}>{c.email}</Text>}
                  </View>
                </TouchableOpacity>
              ))}

              <Text style={ms.orLabel}>— Ou entrer manuellement —</Text>
              <TextInput style={ms.input} placeholder="Nom complet *" placeholderTextColor="#444" value={clientName} onChangeText={setClientName} />
              <TextInput style={ms.input} placeholder="Email" placeholderTextColor="#444" value={clientEmail} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
              <TextInput style={ms.input} placeholder="Téléphone" placeholderTextColor="#444" value={clientPhone} onChangeText={setPhone} keyboardType="phone-pad" />
              <TouchableOpacity style={ms.nextBtn} onPress={() => { if (!clientName.trim()) { Alert.alert('Requis', 'Nom du client'); return; } setStep(2); }}>
                <Text style={ms.nextBtnTxt}>Suivant →</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* ─── Étape 2 : Date ─── */}
          {step === 2 && (
            <View style={{ gap: 12 }}>
              <Text style={ms.stepTitle}>Quelle date ?</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 4 }}>
                {DAYS.map(d => (
                  <TouchableOpacity
                    key={d.value}
                    style={[ms.dayChip, selectedDay === d.value && ms.dayChipActive]}
                    onPress={() => setDay(d.value)}
                  >
                    <Text style={[ms.dayChipTxt, selectedDay === d.value && ms.dayChipTxtActive]}>
                      {d.short}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <TouchableOpacity style={ms.nextBtn} onPress={() => setStep(3)}>
                <Text style={ms.nextBtnTxt}>Suivant →</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* ─── Étape 3 : Heure ─── */}
          {step === 3 && (
            <View style={{ gap: 12 }}>
              <Text style={ms.stepTitle}>À quelle heure ?</Text>
              <View style={ms.timeGrid}>
                {HOURS.map(h => (
                  <TouchableOpacity
                    key={h}
                    style={[ms.timeChip, selectedTime === h && ms.timeChipActive]}
                    onPress={() => setTime(h)}
                  >
                    <Text style={[ms.timeChipTxt, selectedTime === h && ms.timeChipTxtActive]}>{h}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity style={ms.nextBtn} onPress={() => setStep(4)}>
                <Text style={ms.nextBtnTxt}>Suivant →</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* ─── Étape 4 : Infos ─── */}
          {step === 4 && (
            <View style={{ gap: 12 }}>
              <Text style={ms.stepTitle}>Détails du tatouage</Text>

              <Text style={ms.label}>Style</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 4 }}>
                {STYLES.map(s => (
                  <TouchableOpacity
                    key={s}
                    style={[ms.chip, style === s && ms.chipActive]}
                    onPress={() => setStyle(s === style ? '' : s)}
                  >
                    <Text style={[ms.chipTxt, style === s && ms.chipTxtActive]}>{s}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <Text style={ms.label}>Zone du corps</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 4 }}>
                {ZONES.map(z => (
                  <TouchableOpacity
                    key={z}
                    style={[ms.chip, zone === z && ms.chipActive]}
                    onPress={() => setZone(z === zone ? '' : z)}
                  >
                    <Text style={[ms.chipTxt, zone === z && ms.chipTxtActive]}>{z}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <Text style={ms.label}>Description (optionnel)</Text>
              <TextInput
                style={[ms.input, { minHeight: 80, textAlignVertical: 'top' }]}
                placeholder="Motif, taille, couleurs..."
                placeholderTextColor="#444"
                value={desc}
                onChangeText={setDesc}
                multiline
              />

              {/* Récap */}
              <View style={ms.recap}>
                <Text style={ms.recapTitle}>Récapitulatif</Text>
                <Text style={ms.recapLine}>👤 {clientName}</Text>
                <Text style={ms.recapLine}>📅 {selectedDay}{selectedTime ? ' à ' + selectedTime : ''}</Text>
                {style && <Text style={ms.recapLine}>🎨 {style}{zone ? ' · ' + zone : ''}</Text>}
              </View>

              <TouchableOpacity style={ms.saveBtn} onPress={save} disabled={saving}>
                {saving
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={ms.saveBtnTxt}>✓ Créer le rendez-vous</Text>
                }
              </TouchableOpacity>
            </View>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: '#0d0d0d' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  emptyTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  emptyText:  { color: '#555', fontSize: 14, textAlign: 'center', paddingHorizontal: 40 },
  addBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(168,85,247,0.15)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(168,85,247,0.3)' },
  filterRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  filterBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#2a2a2a' },
  filterBtnActive: { backgroundColor: 'rgba(168,85,247,0.15)', borderColor: '#a855f7' },
  filterText: { color: '#666', fontSize: 13, fontWeight: '600' },
  filterTextActive: { color: '#a855f7' },
  card: { backgroundColor: '#1a1a1a', borderRadius: 16, padding: 14, borderWidth: 1, borderColor: '#2a2a2a' },
  cardToday: { borderColor: 'rgba(168,85,247,0.4)', backgroundColor: 'rgba(168,85,247,0.05)' },
  todayPill: { backgroundColor: 'rgba(168,85,247,0.15)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start', marginBottom: 8 },
  todayPillTxt: { color: '#a855f7', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  dateBadge: { width: 52, height: 60, backgroundColor: '#111', borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  dateDay: { color: '#a855f7', fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  dateNum: { color: '#fff', fontSize: 22, fontWeight: '800', lineHeight: 26 },
  dateMon: { color: '#666', fontSize: 11 },
  cardInfo: { flex: 1, gap: 4 },
  clientName: { color: '#fff', fontSize: 16, fontWeight: '700' },
  cardDetail: { color: '#666', fontSize: 13 },
  cardDesc:   { color: '#555', fontSize: 12 },
  statusPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  statusText: { fontSize: 11, fontWeight: '700' },
});

const ms = StyleSheet.create({
  root:    { flex: 1, backgroundColor: '#0d0d0d' },
  handle:  { width: 40, height: 4, backgroundColor: '#333', borderRadius: 2, alignSelf: 'center', marginTop: 10 },
  header:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
  closeBtn:{ width: 36, height: 36, borderRadius: 18, backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },

  // Étapes
  steps:   { flexDirection: 'row', justifyContent: 'center', gap: 20, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: '#1a1a1a', marginHorizontal: 16 },
  stepWrap:{ alignItems: 'center', gap: 4 },
  stepDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#2a2a2a' },
  stepDotActive: { backgroundColor: 'rgba(168,85,247,0.2)', borderColor: '#a855f7' },
  stepNum: { color: '#555', fontSize: 13, fontWeight: '700' },
  stepNumActive: { color: '#a855f7' },
  stepLbl: { color: '#555', fontSize: 11, fontWeight: '600' },
  stepLblActive: { color: '#a855f7' },
  stepTitle: { color: '#fff', fontSize: 18, fontWeight: '800', marginTop: 4 },

  // Client
  input:   { backgroundColor: '#1a1a1a', borderRadius: 12, borderWidth: 1, borderColor: '#2a2a2a', paddingHorizontal: 14, paddingVertical: 12, color: '#fff', fontSize: 15 },
  clientRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#1a1a1a', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#2a2a2a' },
  clientAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#a855f7', alignItems: 'center', justifyContent: 'center' },
  clientAvatarTxt: { color: '#fff', fontSize: 14, fontWeight: '800' },
  clientRowName: { color: '#fff', fontSize: 14, fontWeight: '600' },
  clientRowSub: { color: '#555', fontSize: 12 },
  orLabel: { color: '#333', fontSize: 13, textAlign: 'center', marginVertical: 4 },

  // Date
  dayChip: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#2a2a2a' },
  dayChipActive: { backgroundColor: 'rgba(168,85,247,0.15)', borderColor: '#a855f7' },
  dayChipTxt: { color: '#666', fontSize: 13, fontWeight: '600' },
  dayChipTxtActive: { color: '#a855f7' },

  // Heure
  timeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  timeChip: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#2a2a2a' },
  timeChipActive: { backgroundColor: 'rgba(168,85,247,0.15)', borderColor: '#a855f7' },
  timeChipTxt: { color: '#666', fontSize: 14, fontWeight: '600' },
  timeChipTxtActive: { color: '#a855f7' },

  // Infos
  label: { color: 'rgba(255,255,255,0.4)', fontSize: 12, fontWeight: '600' },
  chip:  { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#2a2a2a' },
  chipActive: { backgroundColor: 'rgba(168,85,247,0.12)', borderColor: '#a855f7' },
  chipTxt: { color: '#666', fontSize: 13, fontWeight: '600' },
  chipTxtActive: { color: '#a855f7' },

  // Récap
  recap: { backgroundColor: '#111', borderRadius: 12, padding: 14, gap: 6, borderWidth: 1, borderColor: '#2a2a2a' },
  recapTitle: { color: '#fff', fontSize: 14, fontWeight: '700', marginBottom: 4 },
  recapLine: { color: '#888', fontSize: 14 },

  // Boutons
  nextBtn: { backgroundColor: 'rgba(168,85,247,0.15)', borderRadius: 12, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(168,85,247,0.3)', marginTop: 4 },
  nextBtnTxt: { color: '#a855f7', fontWeight: '700', fontSize: 15 },
  saveBtn: { backgroundColor: '#a855f7', borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 4 },
  saveBtnTxt: { color: '#fff', fontWeight: '800', fontSize: 16 },
});
