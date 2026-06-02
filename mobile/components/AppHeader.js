/**
 * components/AppHeader.js — Header partagé inkr Pro
 *
 * Affiche le logo "inkr" à gauche sur tous les écrans.
 * Props :
 *   title      — titre centré (optionnel)
 *   right      — élément React à droite (bouton +, badge, etc.)
 *   noBorder   — supprime la bordure bas
 */

import { View, Text, StyleSheet } from 'react-native';

export default function AppHeader({ title, right, noBorder = false }) {
  return (
    <View style={[ss.header, noBorder && { borderBottomWidth: 0 }]}>
      {/* Logo inkr — toujours à gauche */}
      <Text style={ss.logo}>inkr</Text>

      {/* Titre centré */}
      <View style={ss.mid}>
        {title ? <Text style={ss.title}>{title}</Text> : null}
      </View>

      {/* Slot droit : bouton +, pastille, etc. */}
      <View style={ss.right}>
        {right || <View style={{ width: 36 }} />}
      </View>
    </View>
  );
}

const ss = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1e1e1e',
  },
  logo: {
    fontSize: 22,
    fontWeight: '900',
    color: '#a855f7',
    letterSpacing: -1,
    width: 48,
  },
  mid: {
    flex: 1,
    alignItems: 'center',
  },
  title: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  right: {
    width: 48,
    alignItems: 'flex-end',
  },
});
