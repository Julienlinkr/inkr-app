/**
 * app/(tabs)/plus.js — Hub "Plus" inkr Pro
 *
 * Campagnes marketing, Fidélité clients, Automatisations, Mon profil.
 * Chaque fonctionnalité s'ouvre dans un Modal dédié.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, Modal, FlatList, TextInput, Alert,
  ActivityIndicator, Switch,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useAuth } from '../../hooks/useAuth';
import { apiFetch, EP } from '../../constants/Api';

// ─── Écran principal ──────────────────────────────────────────────────────────
export default function PlusScreen() {
  const router = useRouter();
  const [openModal, setOpenModal] = useState(null); // 'campagnes' | 'fidelite' | 'automations'

  const features = [
    {
      key:   'campagnes',
      icon:  'megaphone',
      label: 'Campagnes',
      desc:  'Email & SMS marketing ciblé',
      color: '#ec4899',
      bg:    'rgba(236,72,153,0.12)',
    },
    {
      key:   'fidelite',
      icon:  'star',
      label: 'Fidélité',
      desc:  'Points & top clients',
      color: '#f59e0b',
      bg:    'rgba(245,158,11,0.12)',
    },
    {
      key:   'automations',
      icon:  'flash',
      label: 'Automatisations',
      desc:  'Réponses & relances auto',
      color: '#3b82f6',
      bg:    'rgba(59,130,246,0.12)',
    },
    {
      key:   'profil',
      icon:  'person-circle',
      label: 'Mon profil',
      desc:  'Infos, styles, auto-réponse',
      color: '#a855f7',
      bg:    'rgba(168,85,247,0.12)',
    },
  ];

  function handlePress(key) {
    if (key === 'profil') {
      router.push('/(tabs)/profil');
    } else {
      setOpenModal(key);
    }
  }

  return (
    <SafeAreaView style={ss.root}>
      <ScrollView showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={ss.header}>
          <Text style={ss.headerTitle}>Plus</Text>
        </View>

        {/* Grille de fonctionnalités */}
        <View style={ss.grid}>
          {features.map(f => (
            <TouchableOpacity
              key={f.key}
              style={ss.card}
              onPress={() => handlePress(f.key)}
              activeOpacity={0.75}
            >
              <View style={[ss.cardIcon, { backgroundColor: f.bg }]}>
                <Ionicons name={f.icon} size={26} color={f.color} />
              </View>
              <Text style={ss.cardLabel}>{f.label}</Text>
              <Text style={ss.cardDesc}>{f.desc}</Text>
              <Ionicons name="chevron-forward" size={14} color="#444" style={ss.cardArrow} />
            </TouchableOpacity>
          ))}
        </View>

        {/* Bandeau inkr Pro */}
        <View style={ss.proCard}>
          <LinearGradient
            colors={['rgba(168,85,247,0.15)', 'rgba(59,130,246,0.1)']}
            style={ss.proGradient}
          >
            <Ionicons name="diamond" size={22} color="#a855f7" />
            <View style={{ flex: 1 }}>
              <Text style={ss.proTitle}>inkr Pro</Text>
              <Text style={ss.proSub}>Toutes les fonctionnalités activées</Text>
            </View>
            <View style={ss.proActiveBadge}>
              <Text style={ss.proActiveTxt}>Actif</Text>
            </View>
          </LinearGradient>
        </View>

        <View style={{ height: 30 }} />
      </ScrollView>

      {/* Modals */}
      <CampagnesModal
        visible={openModal === 'campagnes'}
        onClose={() => setOpenModal(null)}
      />
      <FideliteModal
        visible={openModal === 'fidelite'}
        onClose={() => setOpenModal(null)}
      />
      <AutomationsModal
        visible={openModal === 'automations'}
        onClose={() => setOpenModal(null)}
      />
    </SafeAreaView>
  );
}

// ─── Modal Campagnes ──────────────────────────────────────────────────────────
function CampagnesModal({ visible, onClose }) {
  const { token }                         = useAuth();
  const [campaigns,    setCampaigns]      = useState([]);
  const [loading,      setLoading]        = useState(false);
  const [creating,     setCreating]       = useState(false); // show create form
  const [sending,      setSending]        = useState(null);  // id en cours d'envoi
  const [name,         setName]           = useState('');
  const [message,      setMessage]        = useState('');
  const [channels,     setChannels]       = useState(['email']);

  const load = useCallback(async () => {
    if (!visible) return;
    setLoading(true);
    try {
      const res  = await apiFetch(EP.campaigns, {}, token);
      const data = await res.json();
      if (Array.isArray(data)) setCampaigns(data);
    } catch (e) {
      console.warn('[Campagnes]', e.message);
    } finally {
      setLoading(false);
    }
  }, [visible, token]);

  // Recharger à chaque ouverture
  useEffect(() => { if (visible) load(); }, [visible, load]);

  async function createCampaign() {
    if (!name.trim() || !message.trim()) {
      Alert.alert('Requis', 'Remplis le nom et le message.'); return;
    }
    try {
      const res  = await apiFetch(EP.campaigns, {
        method: 'POST',
        body:   JSON.stringify({ name, message, channels }),
      }, token);
      const data = await res.json();
      if (data.success) {
        setName(''); setMessage(''); setChannels(['email']);
        setCreating(false);
        load();
      } else {
        Alert.alert('Erreur', data.error || 'Impossible de créer la campagne');
      }
    } catch (e) {
      Alert.alert('Erreur', e.message);
    }
  }

  async function sendCampaign(id) {
    Alert.alert('Envoyer la campagne ?', 'Elle sera envoyée à tous tes clients ciblés.', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Envoyer', style: 'default', onPress: async () => {
        setSending(id);
        try {
          const res  = await apiFetch(EP.campaignSend(id), { method: 'POST' }, token);
          const data = await res.json();
          if (data.success) {
            const r = data.results;
            Alert.alert('✓ Envoyée', `${r.email} emails · ${r.sms} SMS\n(${r.audience_count} clients ciblés)`);
            load();
          } else {
            Alert.alert('Erreur', data.error || 'Échec de l\'envoi');
          }
        } catch (e) {
          Alert.alert('Erreur', e.message);
        } finally {
          setSending(null);
        }
      }},
    ]);
  }

  async function deleteCampaign(id) {
    Alert.alert('Supprimer ?', 'Cette action est irréversible.', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Supprimer', style: 'destructive', onPress: async () => {
        try {
          await apiFetch(EP.campaign(id), { method: 'DELETE' }, token);
          load();
        } catch (e) {
          Alert.alert('Erreur', e.message);
        }
      }},
    ]);
  }

  function toggleChannel(ch) {
    setChannels(prev =>
      prev.includes(ch) ? prev.filter(c => c !== ch) : [...prev, ch]
    );
  }

  function statusBadge(status) {
    const map = {
      draft:  { label: 'Brouillon', color: '#6b7280', bg: 'rgba(107,114,128,0.15)' },
      sent:   { label: 'Envoyée',   color: '#22c55e', bg: 'rgba(34,197,94,0.12)'  },
      failed: { label: 'Échec',     color: '#ef4444', bg: 'rgba(239,68,68,0.12)'  },
    };
    return map[status] || map.draft;
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={ms.root}>
        <View style={ms.handle} />

        {/* Header modal */}
        <View style={ms.header}>
          <TouchableOpacity onPress={onClose} style={ms.closeBtn}>
            <Ionicons name="close" size={20} color="#fff" />
          </TouchableOpacity>
          <Text style={ms.headerTitle}>Campagnes</Text>
          <TouchableOpacity
            style={ms.addBtn}
            onPress={() => setCreating(c => !c)}
          >
            <Ionicons name={creating ? 'remove' : 'add'} size={20} color="#ec4899" />
          </TouchableOpacity>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, gap: 14 }}
          keyboardShouldPersistTaps="handled"
        >

          {/* Formulaire de création */}
          {creating && (
            <View style={ms.createForm}>
              <Text style={ms.formTitle}>Nouvelle campagne</Text>

              <Text style={ms.formLabel}>Nom de la campagne</Text>
              <TextInput
                style={ms.input}
                placeholder="Ex : Promo été 2025"
                placeholderTextColor="#444"
                value={name}
                onChangeText={setName}
              />

              <Text style={ms.formLabel}>Message</Text>
              <Text style={ms.formHint}>Variables : {`{{prénom}}`} {`{{studio}}`} {`{{lien_résa}}`}</Text>
              <TextInput
                style={[ms.input, ms.textarea]}
                placeholder={`Bonjour {{prénom}} ! Profite de notre offre flash ✨`}
                placeholderTextColor="#444"
                value={message}
                onChangeText={setMessage}
                multiline
              />

              <Text style={ms.formLabel}>Canaux</Text>
              <View style={ms.channelRow}>
                {['email', 'sms'].map(ch => (
                  <TouchableOpacity
                    key={ch}
                    style={[ms.channelBtn, channels.includes(ch) && ms.channelBtnActive]}
                    onPress={() => toggleChannel(ch)}
                  >
                    <Ionicons
                      name={ch === 'email' ? 'mail' : 'phone-portrait'}
                      size={14}
                      color={channels.includes(ch) ? '#ec4899' : '#555'}
                    />
                    <Text style={[ms.channelTxt, channels.includes(ch) && ms.channelTxtActive]}>
                      {ch === 'email' ? 'Email' : 'SMS'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <TouchableOpacity style={ms.createBtn} onPress={createCampaign}>
                <Text style={ms.createBtnTxt}>Créer la campagne</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Liste des campagnes */}
          {loading ? (
            <ActivityIndicator color="#ec4899" style={{ marginTop: 40 }} />
          ) : campaigns.length === 0 ? (
            <View style={ms.empty}>
              <Ionicons name="megaphone-outline" size={48} color="#333" />
              <Text style={ms.emptyTxt}>Aucune campagne</Text>
              <Text style={ms.emptyHint}>Crée ta première campagne avec le + en haut</Text>
            </View>
          ) : (
            campaigns.map(c => {
              const badge = statusBadge(c.status);
              const chans = JSON.parse(c.channels || '[]');
              return (
                <View key={c.id} style={ms.campaignCard}>
                  <View style={ms.campaignTop}>
                    <View style={{ flex: 1 }}>
                      <Text style={ms.campaignName} numberOfLines={1}>{c.name}</Text>
                      <View style={ms.campaignMeta}>
                        {chans.map(ch => (
                          <View key={ch} style={ms.metaTag}>
                            <Text style={ms.metaTagTxt}>{ch === 'email' ? '✉️ Email' : '📱 SMS'}</Text>
                          </View>
                        ))}
                        {c.sent_count > 0 && (
                          <Text style={ms.sentCount}>{c.sent_count} envois</Text>
                        )}
                      </View>
                    </View>
                    <View style={[ms.statusBadge, { backgroundColor: badge.bg }]}>
                      <Text style={[ms.statusTxt, { color: badge.color }]}>{badge.label}</Text>
                    </View>
                  </View>

                  <Text style={ms.campaignMsg} numberOfLines={2}>{c.message}</Text>

                  <View style={ms.campaignActions}>
                    <TouchableOpacity
                      style={ms.sendBtn}
                      onPress={() => sendCampaign(c.id)}
                      disabled={!!sending}
                    >
                      {sending === c.id
                        ? <ActivityIndicator color="#ec4899" size="small" />
                        : <>
                            <Ionicons name="send" size={14} color="#ec4899" />
                            <Text style={ms.sendBtnTxt}>Envoyer</Text>
                          </>
                      }
                    </TouchableOpacity>
                    <TouchableOpacity style={ms.deleteBtn} onPress={() => deleteCampaign(c.id)}>
                      <Ionicons name="trash-outline" size={16} color="#ef4444" />
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })
          )}

          <View style={{ height: 30 }} />
        </ScrollView>
      </View>
    </Modal>
  );
}

// ─── Modal Fidélité ───────────────────────────────────────────────────────────
function FideliteModal({ visible, onClose }) {
  const { token }                   = useAuth();
  const [data,    setData]          = useState(null);
  const [loading, setLoading]       = useState(false);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    apiFetch(EP.loyalty, {}, token)
      .then(r => r.json())
      .then(d => setData(d))
      .catch(e => console.warn('[Fidélité]', e.message))
      .finally(() => setLoading(false));
  }, [visible, token]);

  const stats   = data?.stats  || {};
  const clients = data?.clients || [];

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={ms.root}>
        <View style={ms.handle} />

        <View style={ms.header}>
          <TouchableOpacity onPress={onClose} style={ms.closeBtn}>
            <Ionicons name="close" size={20} color="#fff" />
          </TouchableOpacity>
          <Text style={ms.headerTitle}>Fidélité clients</Text>
          <View style={{ width: 36 }} />
        </View>

        {loading ? (
          <View style={ms.centered}><ActivityIndicator color="#f59e0b" size="large" /></View>
        ) : (
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 16, gap: 16 }}>

            {/* Stats globales */}
            <View style={ms.statsRow}>
              <MiniStat label="Clients" value={stats.total_clients || 0} color="#f59e0b" />
              <MiniStat label="Points total" value={stats.total_points || 0} color="#a855f7" />
              <MiniStat label="CA total" value={`${stats.total_revenue || 0}€`} color="#22c55e" />
            </View>

            {/* Classement */}
            <Text style={ms.sectionTitle}>Top clients 🏆</Text>

            {clients.length === 0 ? (
              <View style={ms.empty}>
                <Ionicons name="star-outline" size={48} color="#333" />
                <Text style={ms.emptyTxt}>Aucun client fidélisé</Text>
              </View>
            ) : (
              clients.map((c, i) => {
                const initial = ((c.prenom || c.name || '?')[0]).toUpperCase();
                const medals  = ['🥇', '🥈', '🥉'];
                return (
                  <View key={i} style={ms.loyaltyRow}>
                    <Text style={ms.rank}>{medals[i] || `#${i + 1}`}</Text>
                    <View style={ms.loyaltyAvatar}>
                      <Text style={ms.loyaltyAvatarTxt}>{initial}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={ms.loyaltyName}>{c.prenom || c.name}</Text>
                      <Text style={ms.loyaltySub}>{c.rdv_count || 0} RDV · {c.total_spent || 0}€ dépensé</Text>
                    </View>
                    <View style={ms.pointsBadge}>
                      <Text style={ms.pointsTxt}>{c.loyalty_points || 0} pts</Text>
                    </View>
                  </View>
                );
              })
            )}

            {/* Info programme */}
            <View style={ms.infoBox}>
              <Ionicons name="information-circle" size={18} color="#f59e0b" />
              <Text style={ms.infoTxt}>
                Les points sont attribués automatiquement à chaque RDV confirmé. Tu peux
                offrir des réductions ou avantages aux clients avec le plus de points.
              </Text>
            </View>

            <View style={{ height: 30 }} />
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

// ─── Modal Automatisations ────────────────────────────────────────────────────
function AutomationsModal({ visible, onClose }) {
  const { token }                   = useAuth();
  const [automations, setAutos]     = useState([]);
  const [loading,     setLoading]   = useState(false);
  const [saving,      setSaving]    = useState(null); // id en cours de sauvegarde
  const [editing,     setEditing]   = useState(null); // { id, message }

  const load = useCallback(async () => {
    if (!visible) return;
    setLoading(true);
    try {
      const res  = await apiFetch(EP.automations, {}, token);
      const data = await res.json();
      if (Array.isArray(data)) setAutos(data);
    } catch (e) {
      console.warn('[Automations]', e.message);
    } finally {
      setLoading(false);
    }
  }, [visible, token]);

  useEffect(() => { if (visible) load(); }, [visible, load]);

  async function toggleAuto(auto) {
    setSaving(auto.id);
    try {
      await apiFetch(EP.automation(auto.id), {
        method: 'PUT',
        body:   JSON.stringify({ enabled: !auto.enabled, message: auto.message }),
      }, token);
      setAutos(prev => prev.map(a => a.id === auto.id ? { ...a, enabled: !a.enabled } : a));
    } catch (e) {
      Alert.alert('Erreur', e.message);
    } finally {
      setSaving(null);
    }
  }

  async function saveMessage(id, message) {
    setSaving(id);
    const auto = automations.find(a => a.id === id);
    try {
      await apiFetch(EP.automation(id), {
        method: 'PUT',
        body:   JSON.stringify({ enabled: auto?.enabled ?? 1, message }),
      }, token);
      setAutos(prev => prev.map(a => a.id === id ? { ...a, message } : a));
      setEditing(null);
      Alert.alert('✓', 'Message mis à jour');
    } catch (e) {
      Alert.alert('Erreur', e.message);
    } finally {
      setSaving(null);
    }
  }

  function autoIcon(name = '') {
    const n = name.toLowerCase();
    if (n.includes('bienvenu') || n.includes('nouveau')) return 'hand-right';
    if (n.includes('rappel') || n.includes('rdv'))       return 'alarm';
    if (n.includes('relance') || n.includes('inactif'))  return 'refresh';
    if (n.includes('anniv'))                              return 'gift';
    return 'flash';
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={ms.root}>
        <View style={ms.handle} />

        <View style={ms.header}>
          <TouchableOpacity onPress={onClose} style={ms.closeBtn}>
            <Ionicons name="close" size={20} color="#fff" />
          </TouchableOpacity>
          <Text style={ms.headerTitle}>Automatisations</Text>
          <View style={{ width: 36 }} />
        </View>

        {loading ? (
          <View style={ms.centered}><ActivityIndicator color="#3b82f6" size="large" /></View>
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ padding: 16, gap: 12 }}
            keyboardShouldPersistTaps="handled"
          >
            {automations.length === 0 ? (
              <View style={ms.empty}>
                <Ionicons name="flash-outline" size={48} color="#333" />
                <Text style={ms.emptyTxt}>Aucune automatisation</Text>
                <Text style={ms.emptyHint}>Configure tes automatisations depuis le dashboard web.</Text>
              </View>
            ) : (
              automations.map(a => {
                const isEditing = editing?.id === a.id;
                return (
                  <View key={a.id} style={ms.autoCard}>
                    <View style={ms.autoTop}>
                      <View style={ms.autoIconBox}>
                        <Ionicons name={autoIcon(a.name)} size={18} color="#3b82f6" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={ms.autoName}>{a.name || 'Automatisation'}</Text>
                        {a.trigger && <Text style={ms.autoTrigger}>{a.trigger}</Text>}
                      </View>
                      {saving === a.id
                        ? <ActivityIndicator color="#3b82f6" size="small" />
                        : <Switch
                            value={!!a.enabled}
                            onValueChange={() => toggleAuto(a)}
                            trackColor={{ false: '#2a2a2a', true: 'rgba(59,130,246,0.4)' }}
                            thumbColor={a.enabled ? '#3b82f6' : '#555'}
                          />
                      }
                    </View>

                    {/* Message éditable */}
                    {isEditing ? (
                      <View style={ms.editBox}>
                        <TextInput
                          style={[ms.input, ms.textarea, { minHeight: 80 }]}
                          value={editing.message}
                          onChangeText={msg => setEditing(e => ({ ...e, message: msg }))}
                          multiline
                          placeholder="Message automatique..."
                          placeholderTextColor="#444"
                        />
                        <View style={ms.editActions}>
                          <TouchableOpacity onPress={() => setEditing(null)} style={ms.cancelBtn}>
                            <Text style={ms.cancelBtnTxt}>Annuler</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => saveMessage(a.id, editing.message)}
                            style={ms.saveSmBtn}
                          >
                            <Text style={ms.saveSmBtnTxt}>Sauvegarder</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    ) : (
                      a.message ? (
                        <TouchableOpacity
                          onPress={() => setEditing({ id: a.id, message: a.message })}
                          style={ms.autoMsgBox}
                        >
                          <Text style={ms.autoMsg} numberOfLines={2}>{a.message}</Text>
                          <Ionicons name="pencil" size={13} color="#555" />
                        </TouchableOpacity>
                      ) : null
                    )}
                  </View>
                );
              })
            )}

            <View style={ms.infoBox}>
              <Ionicons name="information-circle" size={18} color="#3b82f6" />
              <Text style={ms.infoTxt}>
                Active ou désactive chaque automatisation d'un clic. Modifie les messages
                en appuyant dessus. Les nouvelles automatisations se créent depuis le dashboard web.
              </Text>
            </View>

            <View style={{ height: 30 }} />
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

// ─── Composants helper ────────────────────────────────────────────────────────
function MiniStat({ label, value, color }) {
  return (
    <View style={ms.miniStat}>
      <Text style={[ms.miniStatVal, { color }]}>{value}</Text>
      <Text style={ms.miniStatLbl}>{label}</Text>
    </View>
  );
}

// ─── Styles — écran principal ─────────────────────────────────────────────────
const ss = StyleSheet.create({
  root:        { flex: 1, backgroundColor: '#0d0d0d' },
  header:      { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 14 },
  headerTitle: { fontSize: 28, fontWeight: '800', color: '#fff', letterSpacing: -0.5 },
  grid:        { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingHorizontal: 16, marginBottom: 16 },
  card: {
    width: '47%',
    backgroundColor: '#1a1a1a',
    borderRadius: 18,
    padding: 18,
    gap: 8,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    position: 'relative',
  },
  cardIcon:    { width: 52, height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  cardLabel:   { color: '#fff', fontSize: 15, fontWeight: '700' },
  cardDesc:    { color: '#555', fontSize: 12, lineHeight: 16 },
  cardArrow:   { position: 'absolute', top: 16, right: 14 },
  proCard:     { marginHorizontal: 16, borderRadius: 18, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(168,85,247,0.25)' },
  proGradient: { flexDirection: 'row', alignItems: 'center', padding: 18, gap: 14 },
  proTitle:    { color: '#fff', fontSize: 15, fontWeight: '700' },
  proSub:      { color: '#666', fontSize: 12, marginTop: 2 },
  proActiveBadge: { backgroundColor: 'rgba(34,197,94,0.15)', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: 'rgba(34,197,94,0.3)' },
  proActiveTxt:   { color: '#22c55e', fontSize: 12, fontWeight: '700' },
});

// ─── Styles — Modals ──────────────────────────────────────────────────────────
const ms = StyleSheet.create({
  root:       { flex: 1, backgroundColor: '#0d0d0d' },
  handle:     { width: 40, height: 4, backgroundColor: '#333', borderRadius: 2, alignSelf: 'center', marginTop: 10 },
  header:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
  closeBtn:   { width: 36, height: 36, borderRadius: 18, backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center' },
  addBtn:     { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(236,72,153,0.12)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(236,72,153,0.3)' },
  headerTitle:{ color: '#fff', fontSize: 17, fontWeight: '700' },
  centered:   { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty:      { alignItems: 'center', gap: 10, paddingVertical: 48 },
  emptyTxt:   { color: '#fff', fontSize: 17, fontWeight: '700' },
  emptyHint:  { color: '#555', fontSize: 13, textAlign: 'center', paddingHorizontal: 24 },

  // Formulaire création campagne
  createForm: { backgroundColor: '#1a1a1a', borderRadius: 16, padding: 16, gap: 10, borderWidth: 1, borderColor: '#2a2a2a' },
  formTitle:  { color: '#fff', fontSize: 15, fontWeight: '700', marginBottom: 4 },
  formLabel:  { color: 'rgba(255,255,255,0.4)', fontSize: 12, fontWeight: '600' },
  formHint:   { color: '#555', fontSize: 11, marginTop: -6 },
  input:      { backgroundColor: '#111', borderRadius: 10, borderWidth: 1, borderColor: '#2a2a2a', paddingHorizontal: 14, paddingVertical: 11, color: '#fff', fontSize: 14 },
  textarea:   { minHeight: 90, textAlignVertical: 'top', paddingTop: 10 },
  channelRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  channelBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, backgroundColor: '#111', borderWidth: 1, borderColor: '#2a2a2a' },
  channelBtnActive: { backgroundColor: 'rgba(236,72,153,0.1)', borderColor: 'rgba(236,72,153,0.4)' },
  channelTxt: { color: '#555', fontSize: 13, fontWeight: '600' },
  channelTxtActive: { color: '#ec4899' },
  createBtn:  { backgroundColor: 'rgba(236,72,153,0.15)', borderRadius: 10, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(236,72,153,0.3)', marginTop: 4 },
  createBtnTxt: { color: '#ec4899', fontWeight: '700', fontSize: 14 },

  // Card campagne
  campaignCard: { backgroundColor: '#1a1a1a', borderRadius: 16, padding: 14, gap: 10, borderWidth: 1, borderColor: '#2a2a2a' },
  campaignTop:  { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  campaignName: { color: '#fff', fontSize: 15, fontWeight: '700' },
  campaignMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' },
  metaTag:      { backgroundColor: '#111', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  metaTagTxt:   { color: '#888', fontSize: 11 },
  sentCount:    { color: '#555', fontSize: 11 },
  statusBadge:  { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 },
  statusTxt:    { fontSize: 11, fontWeight: '700' },
  campaignMsg:  { color: '#555', fontSize: 13, lineHeight: 18 },
  campaignActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  sendBtn:     { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: 'rgba(236,72,153,0.1)', borderRadius: 10, paddingVertical: 10, borderWidth: 1, borderColor: 'rgba(236,72,153,0.25)' },
  sendBtnTxt:  { color: '#ec4899', fontWeight: '700', fontSize: 13 },
  deleteBtn:   { width: 38, height: 38, borderRadius: 10, backgroundColor: 'rgba(239,68,68,0.08)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(239,68,68,0.2)' },

  // Fidélité
  statsRow:   { flexDirection: 'row', justifyContent: 'space-around', backgroundColor: '#1a1a1a', borderRadius: 16, paddingVertical: 18, borderWidth: 1, borderColor: '#2a2a2a' },
  miniStat:   { alignItems: 'center', gap: 4 },
  miniStatVal:{ fontSize: 22, fontWeight: '800' },
  miniStatLbl:{ color: '#666', fontSize: 12 },
  sectionTitle:{ color: '#fff', fontSize: 15, fontWeight: '700' },
  loyaltyRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#1a1a1a', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: '#2a2a2a' },
  rank:       { fontSize: 18, width: 28, textAlign: 'center' },
  loyaltyAvatar:    { width: 38, height: 38, borderRadius: 19, backgroundColor: '#2a2a2a', alignItems: 'center', justifyContent: 'center' },
  loyaltyAvatarTxt: { color: '#fff', fontSize: 15, fontWeight: '700' },
  loyaltyName:{ color: '#fff', fontSize: 14, fontWeight: '600' },
  loyaltySub: { color: '#555', fontSize: 12, marginTop: 2 },
  pointsBadge:{ backgroundColor: 'rgba(245,158,11,0.12)', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: 'rgba(245,158,11,0.25)' },
  pointsTxt:  { color: '#f59e0b', fontSize: 12, fontWeight: '700' },

  // Automatisations
  autoCard:   { backgroundColor: '#1a1a1a', borderRadius: 16, padding: 14, gap: 10, borderWidth: 1, borderColor: '#2a2a2a' },
  autoTop:    { flexDirection: 'row', alignItems: 'center', gap: 12 },
  autoIconBox:{ width: 36, height: 36, borderRadius: 10, backgroundColor: 'rgba(59,130,246,0.12)', alignItems: 'center', justifyContent: 'center' },
  autoName:   { color: '#fff', fontSize: 14, fontWeight: '600' },
  autoTrigger:{ color: '#555', fontSize: 11, marginTop: 2 },
  autoMsgBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: '#111', borderRadius: 10, padding: 10, borderWidth: 1, borderColor: '#2a2a2a' },
  autoMsg:    { flex: 1, color: '#666', fontSize: 12, lineHeight: 17 },
  editBox:    { gap: 8 },
  editActions:{ flexDirection: 'row', gap: 8 },
  cancelBtn:  { flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: '#111', alignItems: 'center', borderWidth: 1, borderColor: '#2a2a2a' },
  cancelBtnTxt:{ color: '#666', fontWeight: '600', fontSize: 13 },
  saveSmBtn:  { flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: 'rgba(59,130,246,0.15)', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(59,130,246,0.3)' },
  saveSmBtnTxt:{ color: '#3b82f6', fontWeight: '700', fontSize: 13 },

  // Info box
  infoBox:    { flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: '#1a1a1a', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#2a2a2a' },
  infoTxt:    { flex: 1, color: '#555', fontSize: 12, lineHeight: 18 },
});
