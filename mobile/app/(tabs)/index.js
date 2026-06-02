/**
 * app/(tabs)/index.js — Messagerie
 *
 * Liste de toutes les conversations clients de l'artiste.
 * Polling toutes les 10s pour simuler le temps réel.
 * Tap sur une conversation → écran /chat/[id]
 */

import { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  RefreshControl, ActivityIndicator, SafeAreaView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../hooks/useAuth';
import { apiFetch, EP } from '../../constants/Api';

export default function MessagesScreen() {
  const { token, user }               = useAuth();
  const router                         = useRouter();
  const [convs,   setConvs]           = useState([]);
  const [loading, setLoading]         = useState(true);
  const [refresh, setRefresh]         = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res  = await apiFetch(EP.conversations, {}, token);
      const data = await res.json();
      if (Array.isArray(data)) setConvs(data);
    } catch (e) {
      console.warn('[Messages] load error:', e.message);
    } finally {
      setLoading(false);
      setRefresh(false);
    }
  }, [token]);

  useEffect(() => {
    load();
    // Polling toutes les 10s
    const interval = setInterval(() => load(true), 10_000);
    return () => clearInterval(interval);
  }, [load]);

  function openChat(conv) {
    router.push({
      pathname: `/chat/${conv.id}`,
      params: { clientName: conv.client_prenom || conv.client_name || 'Client' },
    });
  }

  function timeAgo(dateStr) {
    if (!dateStr) return '';
    const d   = new Date(dateStr);
    const now  = new Date();
    const diff = Math.floor((now - d) / 1000);
    if (diff < 60)   return 'à l\'instant';
    if (diff < 3600) return `${Math.floor(diff / 60)}min`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }

  function renderConv({ item }) {
    const unread  = item.unread_count > 0;
    const initial = (item.client_prenom || item.client_name || '?')[0].toUpperCase();

    return (
      <TouchableOpacity
        style={[styles.convRow, unread && styles.convRowUnread]}
        onPress={() => openChat(item)}
        activeOpacity={0.75}
      >
        {/* Avatar initiale */}
        <View style={[styles.avatar, unread && styles.avatarUnread]}>
          <Text style={styles.avatarText}>{initial}</Text>
        </View>

        {/* Infos */}
        <View style={styles.convInfo}>
          <View style={styles.convTop}>
            <Text style={[styles.convName, unread && styles.bold]}>
              {item.client_prenom || item.client_name || 'Client'}
            </Text>
            <Text style={styles.convTime}>{timeAgo(item.last_message_at)}</Text>
          </View>
          <Text
            style={[styles.convPreview, unread && styles.bold]}
            numberOfLines={1}
          >
            {item.last_message || item.sujet || 'Demande de tatouage'}
          </Text>
          {item.sujet && (
            <Text style={styles.convTag} numberOfLines={1}>
              📋 {item.sujet}
            </Text>
          )}
        </View>

        {/* Badge non lu */}
        {unread && (
          <View style={styles.unreadBadge}>
            <Text style={styles.unreadText}>{item.unread_count}</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Messages</Text>
        </View>
        <View style={styles.center}>
          <ActivityIndicator color="#a855f7" size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Messages</Text>
        {convs.length > 0 && (
          <View style={styles.countBadge}>
            <Text style={styles.countText}>{convs.length}</Text>
          </View>
        )}
      </View>

      {convs.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="chatbubbles-outline" size={56} color="#333" />
          <Text style={styles.emptyTitle}>Aucun message</Text>
          <Text style={styles.emptyText}>
            Les demandes de tes clients apparaîtront ici.
          </Text>
        </View>
      ) : (
        <FlatList
          data={convs}
          keyExtractor={item => String(item.id)}
          renderItem={renderConv}
          refreshControl={
            <RefreshControl
              refreshing={refresh}
              onRefresh={() => { setRefresh(true); load(); }}
              tintColor="#a855f7"
            />
          }
          contentContainerStyle={{ paddingBottom: 20 }}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0d0d0d' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
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
    flex: 1,
  },
  countBadge: {
    backgroundColor: '#a855f7',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  countText: { color: 'white', fontWeight: '700', fontSize: 13 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  emptyTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  emptyText: { color: '#555', fontSize: 14, textAlign: 'center', paddingHorizontal: 40 },
  sep: { height: 1, backgroundColor: '#1a1a1a' },
  convRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    gap: 14,
  },
  convRowUnread: { backgroundColor: 'rgba(168,85,247,0.05)' },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#2a2a2a',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  avatarUnread: { backgroundColor: 'rgba(168,85,247,0.2)' },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  convInfo: { flex: 1, gap: 3 },
  convTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  convName: { color: '#fff', fontSize: 16, fontWeight: '600' },
  convTime: { color: '#555', fontSize: 12 },
  convPreview: { color: '#777', fontSize: 14, lineHeight: 18 },
  convTag: { color: '#555', fontSize: 12, marginTop: 2 },
  bold: { color: '#fff', fontWeight: '700' },
  unreadBadge: {
    backgroundColor: '#a855f7',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  unreadText: { color: 'white', fontSize: 11, fontWeight: '800' },
});
