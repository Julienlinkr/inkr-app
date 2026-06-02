/**
 * app/(tabs)/profil.js — Mon profil artiste inkr Pro
 *
 * Affiche et édite le profil (même champs que le dashboard web).
 */

import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, SafeAreaView, Alert, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useAuth } from '../../hooks/useAuth';
import { apiFetch, EP } from '../../constants/Api';
import AppHeader from '../../components/AppHeader';

const ALL_STYLES = [
  'Japonais', 'Fine Line', 'Réalisme', 'Géométrique',
  'Tribal', 'Old School', 'Aquarelle', 'Animaux',
  'Flash', 'Blackwork', 'Lettering', 'Chicano', 'Dotwork',
];

export default function ProfilScreen() {
  const { user, token, logout } = useAuth();

  const [nom,           setNom]           = useState(user?.name        || '');
  const [prenom,        setPrenom]        = useState(user?.prenom       || '');
  const [studio,        setStudio]        = useState(user?.studio_name  || '');
  const [ville,         setVille]         = useState(user?.city         || '');
  const [instagram,     setInstagram]     = useState(user?.instagram    || '');
  const [bio,           setBio]           = useState(user?.bio          || '');
  const [autoReply,     setAutoReply]     = useState(user?.auto_reply   || '');
  const [selectedStyles, setSelectedStyles] = useState(() => {
    try { return JSON.parse(user?.styles || '[]'); } catch { return []; }
  });
  const [saving,        setSaving]        = useState(false);
  const [section,       setSection]       = useState('infos');

  function toggleStyle(s) {
    setSelectedStyles(prev =>
      prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]
    );
  }

  async function save() {
    if (!nom.trim()) { Alert.alert('Requis', 'Le nom est requis.'); return; }
    setSaving(true);
    try {
      const res = await apiFetch(EP.profile, {
        method: 'PUT',
        body: JSON.stringify({
          name: nom, prenom, studio_name: studio,
          city: ville, instagram, bio,
          auto_reply: autoReply, styles: selectedStyles,
        }),
      }, token);
      const data = await res.json();
      if (data.success) Alert.alert('✓ Sauvegardé', 'Profil mis à jour.');
      else throw new Error(data.error || 'Erreur');
    } catch (e) {
      Alert.alert('Erreur', e.message);
    } finally {
      setSaving(false);
    }
  }

  function confirmLogout() {
    Alert.alert(
      'Déconnexion',
      'Tu vas être déconnecté.',
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Se déconnecter', style: 'destructive', onPress: logout },
      ]
    );
  }

  return (
    <SafeAreaView style={ss.root}>
      <AppHeader title="Mon profil" />
      <ScrollView showsVerticalScrollIndicator={false}>

        {/* Avatar + infos rapides */}
        <View style={ss.profileHeader}>
          <View style={ss.avatarBig}>
            <Text style={ss.avatarBigText}>{(user?.name || '?')[0].toUpperCase()}</Text>
          </View>
          <Text style={ss.profileName}>{user?.name}</Text>
          {user?.studio_name ? <Text style={ss.profileStudio}>{user.studio_name}</Text> : null}
          {user?.city ? (
            <Text style={ss.profileCity}>📍 {user.city}</Text>
          ) : null}
        </View>

        {/* Onglets */}
        <View style={ss.sectionTabs}>
          {[
            { key: 'infos',    label: 'Infos' },
            { key: 'styles',   label: 'Styles' },
            { key: 'messages', label: 'Auto-réponse' },
          ].map(t => (
            <TouchableOpacity
              key={t.key}
              style={[ss.sectionTab, section === t.key && ss.sectionTabActive]}
              onPress={() => setSection(t.key)}
            >
              <Text style={[ss.sectionTabTxt, section === t.key && ss.sectionTabTxtActive]}>
                {t.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={ss.form}>

          {/* ─── Infos ─── */}
          {section === 'infos' && <>
            <Field label="Prénom"       value={prenom}    onChange={setPrenom}    ph="Ton prénom" />
            <Field label="Nom / Pseudo" value={nom}       onChange={setNom}       ph="Nom affiché" />
            <Field label="Studio"       value={studio}    onChange={setStudio}    ph="Nom du studio" />
            <Field label="Ville"        value={ville}     onChange={setVille}     ph="Paris, Lyon..." />
            <Field label="Instagram"    value={instagram} onChange={setInstagram} ph="@ton_handle" autoCapitalize="none" />
            <View style={ss.fieldWrap}>
              <Text style={ss.label}>Bio</Text>
              <TextInput
                style={[ss.input, ss.textarea]}
                placeholder="Présente-toi en quelques mots..."
                placeholderTextColor="#444"
                value={bio}
                onChangeText={setBio}
                multiline
              />
            </View>
          </>}

          {/* ─── Styles ─── */}
          {section === 'styles' && (
            <View style={ss.stylesGrid}>
              {ALL_STYLES.map(s => {
                const active = selectedStyles.includes(s);
                return (
                  <TouchableOpacity key={s} onPress={() => toggleStyle(s)}>
                    <View style={[ss.chip, active && ss.chipActive]}>
                      {active && <Ionicons name="checkmark" size={12} color="#a855f7" style={{ marginRight: 4 }} />}
                      <Text style={[ss.chipTxt, active && ss.chipTxtActive]}>{s}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {/* ─── Auto-réponse ─── */}
          {section === 'messages' && <>
            <Text style={ss.hint}>
              Ce message est envoyé automatiquement quand un client te contacte pour la première fois.
            </Text>
            <TextInput
              style={[ss.input, ss.textarea, { minHeight: 140 }]}
              placeholder={'Bonjour ! Merci pour ta demande 🎨\nJe reviens vers toi dans les 48h...'}
              placeholderTextColor="#444"
              value={autoReply}
              onChangeText={setAutoReply}
              multiline
            />
          </>}

          {/* Sauvegarde */}
          <TouchableOpacity onPress={save} disabled={saving} activeOpacity={0.85}>
            <LinearGradient
              colors={['#667eea', '#a855f7']}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
              style={ss.saveBtn}
            >
              {saving
                ? <ActivityIndicator color="#fff" />
                : <Text style={ss.saveBtnTxt}>Sauvegarder</Text>
              }
            </LinearGradient>
          </TouchableOpacity>

          {/* Déconnexion */}
          <TouchableOpacity style={ss.logoutBtn} onPress={confirmLogout}>
            <Ionicons name="log-out-outline" size={18} color="#ef4444" />
            <Text style={ss.logoutTxt}>Se déconnecter</Text>
          </TouchableOpacity>

        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Field({ label, value, onChange, ph, ...rest }) {
  return (
    <View style={ss.fieldWrap}>
      <Text style={ss.label}>{label}</Text>
      <TextInput
        style={ss.input}
        placeholder={ph}
        placeholderTextColor="#444"
        value={value}
        onChangeText={onChange}
        {...rest}
      />
    </View>
  );
}

const ss = StyleSheet.create({
  root:           { flex: 1, backgroundColor: '#0d0d0d' },
  profileHeader:  { alignItems: 'center', paddingVertical: 28, gap: 5, borderBottomWidth: 1, borderBottomColor: '#1e1e1e' },
  avatarBig:      { width: 78, height: 78, borderRadius: 39, backgroundColor: '#a855f7', alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  avatarBigText:  { color: '#fff', fontSize: 32, fontWeight: '800' },
  profileName:    { color: '#fff', fontSize: 20, fontWeight: '800' },
  profileStudio:  { color: '#888', fontSize: 14 },
  profileCity:    { color: '#555', fontSize: 13 },
  sectionTabs:    { flexDirection: 'row', padding: 16, gap: 8 },
  sectionTab:     { flex: 1, paddingVertical: 9, borderRadius: 10, backgroundColor: '#1a1a1a', alignItems: 'center', borderWidth: 1, borderColor: '#2a2a2a' },
  sectionTabActive:   { backgroundColor: 'rgba(168,85,247,0.15)', borderColor: '#a855f7' },
  sectionTabTxt:      { color: '#666', fontSize: 13, fontWeight: '600' },
  sectionTabTxtActive:{ color: '#a855f7' },
  form:       { padding: 16, gap: 14 },
  fieldWrap:  { gap: 7 },
  label:      { color: 'rgba(255,255,255,0.45)', fontSize: 12, fontWeight: '600', letterSpacing: 0.3 },
  input:      { backgroundColor: '#1a1a1a', borderRadius: 12, borderWidth: 1, borderColor: '#2a2a2a', paddingHorizontal: 14, paddingVertical: 13, color: '#fff', fontSize: 15 },
  textarea:   { minHeight: 100, textAlignVertical: 'top', paddingTop: 12 },
  hint:       { color: '#666', fontSize: 13, lineHeight: 18, backgroundColor: '#1a1a1a', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: '#2a2a2a' },
  stylesGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip:       { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#2a2a2a', flexDirection: 'row', alignItems: 'center' },
  chipActive: { backgroundColor: 'rgba(168,85,247,0.12)', borderColor: '#a855f7' },
  chipTxt:    { color: '#666', fontSize: 13, fontWeight: '600' },
  chipTxtActive: { color: '#a855f7' },
  saveBtn:    { borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 4 },
  saveBtnTxt: { color: '#fff', fontSize: 16, fontWeight: '700' },
  logoutBtn:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: 14, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#2a2a2a', marginBottom: 20 },
  logoutTxt:  { color: '#ef4444', fontSize: 15, fontWeight: '600' },
});
