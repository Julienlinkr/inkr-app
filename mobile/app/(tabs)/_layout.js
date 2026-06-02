/**
 * app/(tabs)/_layout.js — Barre de navigation principale inkr Pro
 * 5 onglets : Accueil | Messages | Agenda | Clients | Plus
 */

import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { View, Text, StyleSheet } from 'react-native';

function TabIcon({ name, focused, badge }) {
  return (
    <View style={{ alignItems: 'center' }}>
      <Ionicons
        name={focused ? name : `${name}-outline`}
        size={24}
        color={focused ? '#a855f7' : '#555'}
      />
      {badge > 0 && (
        <View style={ss.badge}>
          <Text style={ss.badgeTxt}>{badge > 9 ? '9+' : badge}</Text>
        </View>
      )}
    </View>
  );
}

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#0d0d0d',
          borderTopColor: '#1e1e1e',
          borderTopWidth: 1,
          height: 84,
          paddingBottom: 26,
          paddingTop: 10,
        },
        tabBarActiveTintColor: '#a855f7',
        tabBarInactiveTintColor: '#555',
        tabBarLabelStyle: { fontSize: 10, fontWeight: '600', marginTop: 2 },
      }}
    >
      <Tabs.Screen name="index" options={{
        title: 'Accueil',
        tabBarIcon: ({ focused }) => <TabIcon name="home" focused={focused} />,
      }} />
      <Tabs.Screen name="messages" options={{
        title: 'Messages',
        tabBarIcon: ({ focused }) => <TabIcon name="chatbubbles" focused={focused} />,
      }} />
      <Tabs.Screen name="agenda" options={{
        title: 'Agenda',
        tabBarIcon: ({ focused }) => <TabIcon name="calendar" focused={focused} />,
      }} />
      <Tabs.Screen name="clients" options={{
        title: 'Clients',
        tabBarIcon: ({ focused }) => <TabIcon name="people" focused={focused} />,
      }} />
      <Tabs.Screen name="plus" options={{
        title: 'Plus',
        tabBarIcon: ({ focused }) => <TabIcon name="grid" focused={focused} />,
      }} />
    </Tabs>
  );
}

const ss = StyleSheet.create({
  badge: {
    position: 'absolute', top: -4, right: -8,
    backgroundColor: '#ec4899', borderRadius: 10,
    minWidth: 18, height: 18,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
  },
  badgeTxt: { color: 'white', fontSize: 10, fontWeight: '800' },
});
