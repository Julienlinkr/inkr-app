/**
 * app/chat/[id].js — Écran de conversation
 *
 * Affiche les messages d'une conversation client ↔ artiste.
 * L'artiste peut répondre directement depuis l'app.
 * Polling toutes les 5s pour les nouveaux messages.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, FlatList, TextInput, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform, SafeAreaView,
  ActivityIndicator, Alert,
} from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../hooks/useAuth';
import { apiFetch, EP } from '../../constants/Api';

export default function ChatScreen() {
  const { id, clientName }              = useLocalSearchParams();
  const { token }                        = useAuth();
  const navigation                       = useNavigation();
  const [messages, setMessages]          = useState([]);
  const [convInfo, setConvInfo]          = useState(null);
  const [text, setText]                  = useState('');
  const [loading, setLoading]            = useState(true);
  const [sending, setSending]            = useState(false);
  const flatRef                          = useRef(null);

  // Titre de la page
  useEffect(() => {
    navigation.setOptions({
      title: clientName || 'Conversation',
      headerTitleStyle: { color: '#fff', fontWeight: '700' },
    });
  }, [clientName]);

  const loadMessages = useCallback(async (silent = false) => {
    try {
      const res  = await apiFetch(EP.conversation(id), {}, token);
      const data = await res.json();
      if (data.conversation) setConvInfo(data.conversation);
      if (Array.isArray(data.messages)) {
        setMessages(data.messages);
        if (!silent) setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 100);
      }
    } catch (e) {
      console.warn('[Chat] load error:', e.message);
    } finally {
      setLoading(false);
    }
  }, [id, token]);

  useEffect(() => {
    loadMessages();
    const interval = setInterval(() => loadMessages(true), 5_000);
    return () => clearInterval(interval);
  }, [loadMessages]);

  async function send() {
    const msg = text.trim();
    if (!msg || sending) return;
    setSending(true);
    setText('');
    try {
      const res = await apiFetch(EP.reply(id), {
        method: 'POST',
        body: JSON.stringify({ content: msg }),
      }, token);
      if (!res.ok) throw new Error('Envoi échoué');
      await loadMessages(true);
      setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (e) {
      Alert.alert('Erreur', e.message);
      setText(msg); // remet le texte si erreur
    } finally {
      setSending(false);
    }
  }

  function renderMessage({ item }) {
    const isArtist = item.sender === 'artist';
    return (
      <View style={[styles.msgRow, isArtist && styles.msgRowRight]}>
        <View style={[styles.bubble, isArtist ? styles.bubbleArtist : styles.bubbleClient]}>
          <Text style={styles.bubbleText}>{item.content}</Text>
          <Text style={styles.bubbleTime}>
            {new Date(item.created_at).toLocaleTimeString('fr-FR', {
              hour: '2-digit', minute: '2-digit',
            })}
          </Text>
        </View>
      </View>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.center}>
          <ActivityIndicator color="#a855f7" size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={90}
      >

        {/* Info demande */}
        {convInfo && (
          <View style={styles.convInfoBar}>
            <Text style={styles.convInfoText} numberOfLines={2}>
              📋 {convInfo.sujet || 'Demande de tatouage'}
              {convInfo.zone_corps ? `  ·  ${convInfo.zone_corps}` : ''}
            </Text>
          </View>
        )}

        {/* Messages */}
        <FlatList
          ref={flatRef}
          data={messages}
          keyExtractor={item => String(item.id)}
          renderItem={renderMessage}
          contentContainerStyle={styles.msgList}
          onLayout={() => flatRef.current?.scrollToEnd({ animated: false })}
        />

        {/* Input */}
        <View style={styles.inputBar}>
          <TextInput
            style={styles.textInput}
            placeholder="Répondre..."
            placeholderTextColor="#555"
            value={text}
            onChangeText={setText}
            multiline
            maxLength={1000}
          />
          <TouchableOpacity
            style={[styles.sendBtn, (!text.trim() || sending) && styles.sendBtnDisabled]}
            onPress={send}
            disabled={!text.trim() || sending}
          >
            {sending
              ? <ActivityIndicator color="#fff" size="small" />
              : <Ionicons name="send" size={18} color="#fff" />
            }
          </TouchableOpacity>
        </View>

      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root:    { flex: 1, backgroundColor: '#0d0d0d' },
  center:  { flex: 1, alignItems: 'center', justifyContent: 'center' },
  convInfoBar: {
    backgroundColor: '#1a1a1a',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2a',
  },
  convInfoText: { color: '#888', fontSize: 13, lineHeight: 18 },
  msgList: { padding: 16, gap: 8, paddingBottom: 8 },
  msgRow: { flexDirection: 'row', marginBottom: 6 },
  msgRowRight: { justifyContent: 'flex-end' },
  bubble: {
    maxWidth: '80%',
    borderRadius: 18,
    padding: 12,
    gap: 4,
  },
  bubbleClient: {
    backgroundColor: '#1e1e1e',
    borderBottomLeftRadius: 4,
  },
  bubbleArtist: {
    backgroundColor: '#a855f7',
    borderBottomRightRadius: 4,
  },
  bubbleText: { color: '#fff', fontSize: 15, lineHeight: 21 },
  bubbleTime: { color: 'rgba(255,255,255,0.5)', fontSize: 11, alignSelf: 'flex-end' },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: '#1e1e1e',
    backgroundColor: '#0d0d0d',
  },
  textInput: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: '#fff',
    fontSize: 15,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#a855f7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: '#333' },
});
