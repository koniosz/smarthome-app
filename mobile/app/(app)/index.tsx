import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  RefreshControl,
  useColorScheme,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../src/contexts/AuthContext';
import { projectsApi, Project, ProjectStatus } from '../../src/api/client';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2 }).format(n) + ' PLN';
}

const STATUS_LABEL: Record<ProjectStatus, string> = {
  active: 'Aktywny',
  completed: 'Zakończony',
  archived: 'Archiwum',
  on_hold: 'Wstrzymany',
};

const STATUS_COLOR: Record<ProjectStatus, string> = {
  active: '#059669',
  completed: '#3b82f6',
  archived: '#9ca3af',
  on_hold: '#f97316',
};

type FilterTab = 'all' | 'active' | 'completed';

// ─── Project Card ─────────────────────────────────────────────────────────────
interface ProjectCardProps {
  project: Project;
  onPress: () => void;
  isDark: boolean;
}

function ProjectCard({ project, onPress, isDark }: ProjectCardProps) {
  const cardBg = isDark ? '#1f2937' : '#ffffff';
  const textColor = isDark ? '#f9fafb' : '#111827';
  const subColor = isDark ? '#9ca3af' : '#6b7280';

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: cardBg }]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      {/* Top row: name + status badge */}
      <View style={styles.cardHeader}>
        <Text style={[styles.cardName, { color: textColor }]} numberOfLines={2}>
          {project.name}
        </Text>
        <View
          style={[
            styles.statusBadge,
            { backgroundColor: STATUS_COLOR[project.status] + '22' },
          ]}
        >
          <View
            style={[
              styles.statusDot,
              { backgroundColor: STATUS_COLOR[project.status] },
            ]}
          />
          <Text
            style={[
              styles.statusBadgeText,
              { color: STATUS_COLOR[project.status] },
            ]}
          >
            {STATUS_LABEL[project.status]}
          </Text>
        </View>
      </View>

      {/* Client */}
      <View style={styles.cardRow}>
        <Ionicons name="person-outline" size={13} color={subColor} />
        <Text style={[styles.cardMeta, { color: subColor }]}>
          {' '}{project.client_name}
        </Text>
      </View>

      {/* Address */}
      {!!project.address && (
        <View style={styles.cardRow}>
          <Ionicons name="location-outline" size={13} color={subColor} />
          <Text
            style={[styles.cardMeta, { color: subColor }]}
            numberOfLines={1}
          >
            {' '}{project.address}
          </Text>
        </View>
      )}

      {/* Budget */}
      <View style={styles.cardFooter}>
        <View style={styles.cardRow}>
          <Ionicons name="cash-outline" size={13} color="#059669" />
          <Text style={[styles.cardBudget, { color: '#059669' }]}>
            {' '}{fmt(project.budget_amount)}
          </Text>
        </View>
        <View style={styles.cardRowRight}>
          <Text style={[styles.cardDate, { color: subColor }]}>
            {new Date(project.created_at).toLocaleDateString('pl-PL')}
          </Text>
          <Ionicons name="chevron-forward" size={16} color={subColor} style={{ marginLeft: 4 }} />
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ─── Skeleton ────────────────────────────────────────────────────────────────
function SkeletonCard({ isDark }: { isDark: boolean }) {
  const bg = isDark ? '#374151' : '#e5e7eb';
  const card = isDark ? '#1f2937' : '#ffffff';
  return (
    <View style={[styles.card, { backgroundColor: card }]}>
      <View style={[styles.skeletonLine, { backgroundColor: bg, width: '70%', height: 18, marginBottom: 10 }]} />
      <View style={[styles.skeletonLine, { backgroundColor: bg, width: '50%', height: 13, marginBottom: 6 }]} />
      <View style={[styles.skeletonLine, { backgroundColor: bg, width: '40%', height: 13 }]} />
    </View>
  );
}

// ─── Main Screen ─────────────────────────────────────────────────────────────
export default function ProjectsScreen() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<FilterTab>('all');

  const bgColor = isDark ? '#111827' : '#f9fafb';
  const textColor = isDark ? '#f9fafb' : '#111827';
  const subColor = isDark ? '#9ca3af' : '#6b7280';
  const inputBg = isDark ? '#1f2937' : '#ffffff';
  const borderColor = isDark ? '#374151' : '#e5e7eb';

  const fetchProjects = useCallback(async () => {
    try {
      const data = await projectsApi.list();
      setProjects(data);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { status?: number } };
      if (axiosErr.response?.status === 401) {
        Alert.alert('Sesja wygasła', 'Zaloguj się ponownie.', [
          { text: 'OK', onPress: logout },
        ]);
      } else {
        Alert.alert('Błąd', 'Nie udało się pobrać projektów. Sprawdź połączenie z internetem.');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [logout]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchProjects();
  }, [fetchProjects]);

  const filtered = useMemo(() => {
    let result = projects;

    // Tab filter
    if (activeTab === 'active') {
      result = result.filter((p) => p.status === 'active');
    } else if (activeTab === 'completed') {
      result = result.filter((p) => p.status === 'completed' || p.status === 'archived');
    }

    // Search filter
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.client_name.toLowerCase().includes(q) ||
          (p.address ?? '').toLowerCase().includes(q)
      );
    }

    return result;
  }, [projects, search, activeTab]);

  const tabs: { key: FilterTab; label: string }[] = [
    { key: 'all', label: 'Wszystkie' },
    { key: 'active', label: 'Aktywne' },
    { key: 'completed', label: 'Zakończone' },
  ];

  const handleLogout = () => {
    Alert.alert('Wyloguj się', 'Czy na pewno chcesz się wylogować?', [
      { text: 'Anuluj', style: 'cancel' },
      { text: 'Wyloguj', style: 'destructive', onPress: logout },
    ]);
  };

  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: bgColor }]}
      edges={['bottom']}
    >
      {/* Custom header */}
      <View style={styles.headerBar}>
        <View>
          <Text style={styles.headerTitle}>Projekty</Text>
          <Text style={styles.headerSub}>
            Witaj, {user?.display_name ?? user?.email ?? 'użytkowniku'}
          </Text>
        </View>
        <TouchableOpacity
          onPress={handleLogout}
          style={styles.avatarBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {(user?.display_name ?? user?.email ?? 'U')[0].toUpperCase()}
            </Text>
          </View>
        </TouchableOpacity>
      </View>

      {/* Search */}
      <View style={styles.searchContainer}>
        <View
          style={[
            styles.searchRow,
            { backgroundColor: inputBg, borderColor },
          ]}
        >
          <Ionicons
            name="search-outline"
            size={18}
            color={subColor}
            style={{ marginRight: 8 }}
          />
          <TextInput
            style={[styles.searchInput, { color: textColor }]}
            placeholder="Szukaj projektu lub klienta..."
            placeholderTextColor={subColor}
            value={search}
            onChangeText={setSearch}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
        </View>
      </View>

      {/* Filter tabs */}
      <View style={styles.tabRow}>
        {tabs.map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[
              styles.tab,
              activeTab === tab.key && styles.tabActive,
            ]}
            onPress={() => setActiveTab(tab.key)}
          >
            <Text
              style={[
                styles.tabText,
                { color: activeTab === tab.key ? '#6d28d9' : subColor },
              ]}
            >
              {tab.label}
            </Text>
            {activeTab === tab.key && (
              <View style={styles.tabIndicator} />
            )}
          </TouchableOpacity>
        ))}
      </View>

      {/* List */}
      {loading ? (
        <View style={{ padding: 16 }}>
          {[0, 1, 2].map((i) => (
            <SkeletonCard key={i} isDark={isDark} />
          ))}
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <ProjectCard
              project={item}
              onPress={() => router.push(`/(app)/project/${item.id}`)}
              isDark={isDark}
            />
          )}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="#6d28d9"
              colors={['#6d28d9']}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name="folder-open-outline" size={52} color={subColor} />
              <Text style={[styles.emptyTitle, { color: textColor }]}>
                {search ? 'Brak wyników' : 'Brak projektów'}
              </Text>
              <Text style={[styles.emptySubtitle, { color: subColor }]}>
                {search
                  ? 'Spróbuj zmienić frazy wyszukiwania'
                  : 'Projekty pojawią się tutaj po dodaniu ich w panelu webowym'}
              </Text>
            </View>
          }
          showsVerticalScrollIndicator={false}
        />
      )}
    </SafeAreaView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  safe: { flex: 1 },
  headerBar: {
    backgroundColor: '#6d28d9',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: '#ffffff',
  },
  headerSub: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.75)',
    marginTop: 2,
  },
  avatarBtn: {},
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
  searchContainer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 44,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    height: '100%',
  },
  tabRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
  },
  tab: {
    marginRight: 20,
    paddingBottom: 8,
    position: 'relative',
  },
  tabActive: {},
  tabText: {
    fontSize: 14,
    fontWeight: '600',
  },
  tabIndicator: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: '#6d28d9',
    borderRadius: 1,
  },
  listContent: {
    padding: 16,
    paddingBottom: 40,
  },
  card: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 8,
    gap: 8,
  },
  cardName: {
    fontSize: 16,
    fontWeight: '700',
    flex: 1,
    lineHeight: 22,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
    flexShrink: 0,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 4,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 3,
  },
  cardMeta: {
    fontSize: 13,
  },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
  },
  cardBudget: {
    fontSize: 14,
    fontWeight: '600',
  },
  cardRowRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardDate: {
    fontSize: 12,
  },
  skeletonLine: {
    borderRadius: 4,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 60,
    paddingHorizontal: 40,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginTop: 16,
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
});
