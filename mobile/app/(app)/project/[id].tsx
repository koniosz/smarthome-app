import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Modal,
  TextInput,
  Switch,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Image,
  RefreshControl,
  useColorScheme,
  Animated,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as SMS from 'expo-sms';

import {
  projectsApi,
  extraCostsApi,
  Project,
  ExtraCost,
  ExtraCostStatus,
  CreateExtraCostData,
} from '../../../src/api/client';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2 }).format(n);
}

function fmtPLN(n: number | null | undefined): string {
  return fmt(n) + ' PLN';
}

function today(): string {
  return new Date().toISOString().split('T')[0];
}

const COST_STATUS_COLOR: Record<ExtraCostStatus, string> = {
  pending: '#f97316',
  sent: '#3b82f6',
  approved: '#10b981',
  rejected: '#ef4444',
};

const COST_STATUS_LABEL: Record<ExtraCostStatus, string> = {
  pending: 'Oczekujący',
  sent: 'Wysłany',
  approved: 'Zaakceptowany',
  rejected: 'Odrzucony',
};

// ─── Types ───────────────────────────────────────────────────────────────────
interface AttachedFile {
  uri: string;
  name: string;
  type: 'photo' | 'document';
  mimeType: string;
}

interface CostFormState {
  description: string;
  quantity: string;
  unit_price: string;
  date: string;
  is_out_of_scope: boolean;
  notes: string;
  attachment: AttachedFile | null;
}

// ─── AddEditCostModal ─────────────────────────────────────────────────────────
interface AddEditModalProps {
  visible: boolean;
  onClose: () => void;
  onSave: (data: CreateExtraCostData, attachment: AttachedFile | null) => Promise<void>;
  editItem?: ExtraCost | null;
  isDark: boolean;
}

function AddEditCostModal({
  visible,
  onClose,
  onSave,
  editItem,
  isDark,
}: AddEditModalProps) {
  const [form, setForm] = useState<CostFormState>({
    description: '',
    quantity: '1',
    unit_price: '',
    date: today(),
    is_out_of_scope: false,
    notes: '',
    attachment: null,
  });
  const [saving, setSaving] = useState(false);

  // Populate form when editing
  useEffect(() => {
    if (editItem) {
      setForm({
        description: editItem.description,
        quantity: String(editItem.quantity),
        unit_price: String(editItem.unit_price),
        date: editItem.date.split('T')[0],
        is_out_of_scope: editItem.is_out_of_scope,
        notes: editItem.notes ?? '',
        attachment: null,
      });
    } else {
      setForm({
        description: '',
        quantity: '1',
        unit_price: '',
        date: today(),
        is_out_of_scope: false,
        notes: '',
        attachment: null,
      });
    }
  }, [editItem, visible]);

  const total = useMemo(() => {
    const q = parseFloat(form.quantity) || 0;
    const u = parseFloat(form.unit_price) || 0;
    return q * u;
  }, [form.quantity, form.unit_price]);

  const handlePickPhoto = async (useCamera: boolean) => {
    try {
      let result: ImagePicker.ImagePickerResult;
      if (useCamera) {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          Alert.alert('Brak uprawnień', 'Zezwól na dostęp do aparatu w Ustawieniach.');
          return;
        }
        result = await ImagePicker.launchCameraAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          quality: 0.8,
          allowsEditing: false,
        });
      } else {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          Alert.alert('Brak uprawnień', 'Zezwól na dostęp do galerii w Ustawieniach.');
          return;
        }
        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          quality: 0.8,
          allowsEditing: false,
        });
      }

      if (!result.canceled && result.assets.length > 0) {
        const asset = result.assets[0];
        const name =
          asset.fileName ??
          `photo_${Date.now()}.${asset.uri.split('.').pop() ?? 'jpg'}`;
        setForm((f) => ({
          ...f,
          attachment: {
            uri: asset.uri,
            name,
            type: 'photo',
            mimeType: asset.mimeType ?? 'image/jpeg',
          },
        }));
      }
    } catch {
      Alert.alert('Błąd', 'Nie udało się wybrać zdjęcia.');
    }
  };

  const handlePickDocument = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', '*/*'],
        copyToCacheDirectory: true,
      });
      if (!result.canceled && result.assets.length > 0) {
        const asset = result.assets[0];
        setForm((f) => ({
          ...f,
          attachment: {
            uri: asset.uri,
            name: asset.name,
            type: 'document',
            mimeType: asset.mimeType ?? 'application/octet-stream',
          },
        }));
      }
    } catch {
      Alert.alert('Błąd', 'Nie udało się wybrać dokumentu.');
    }
  };

  const handleSave = async () => {
    if (!form.description.trim()) {
      Alert.alert('Błąd', 'Opis jest wymagany.');
      return;
    }
    const q = parseFloat(form.quantity);
    const u = parseFloat(form.unit_price);
    if (isNaN(q) || q <= 0) {
      Alert.alert('Błąd', 'Podaj prawidłową ilość.');
      return;
    }
    if (isNaN(u) || u < 0) {
      Alert.alert('Błąd', 'Podaj prawidłową cenę.');
      return;
    }

    setSaving(true);
    try {
      await onSave(
        {
          description: form.description.trim(),
          quantity: q,
          unit_price: u,
          date: form.date || today(),
          is_out_of_scope: form.is_out_of_scope,
          notes: form.notes.trim() || undefined,
        },
        form.attachment
      );
    } finally {
      setSaving(false);
    }
  };

  const colors = {
    bg: isDark ? '#111827' : '#f9fafb',
    card: isDark ? '#1f2937' : '#ffffff',
    text: isDark ? '#f9fafb' : '#111827',
    sub: isDark ? '#9ca3af' : '#6b7280',
    inputBg: isDark ? '#374151' : '#f3f4f6',
    border: isDark ? '#4b5563' : '#e5e7eb',
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        {/* Modal header */}
        <View style={[mStyles.modalHeader, { backgroundColor: '#6d28d9' }]}>
          <TouchableOpacity onPress={onClose} style={mStyles.modalHeaderBtn}>
            <Text style={mStyles.modalHeaderBtnText}>Anuluj</Text>
          </TouchableOpacity>
          <Text style={mStyles.modalHeaderTitle}>
            {editItem ? 'Edytuj koszt' : 'Nowy koszt'}
          </Text>
          <TouchableOpacity
            onPress={handleSave}
            style={mStyles.modalHeaderBtn}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator color="#ffffff" size="small" />
            ) : (
              <Text style={[mStyles.modalHeaderBtnText, mStyles.modalHeaderBtnBold]}>
                Zapisz
              </Text>
            )}
          </TouchableOpacity>
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={0}
        >
          <ScrollView
            contentContainerStyle={mStyles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* Description */}
            <View style={mStyles.section}>
              <Text style={[mStyles.sectionLabel, { color: colors.sub }]}>
                OPIS *
              </Text>
              <TextInput
                style={[
                  mStyles.textInput,
                  mStyles.textArea,
                  { backgroundColor: colors.inputBg, color: colors.text, borderColor: colors.border },
                ]}
                placeholder="Opis kosztu dodatkowego..."
                placeholderTextColor={colors.sub}
                value={form.description}
                onChangeText={(t) => setForm((f) => ({ ...f, description: t }))}
                multiline
                numberOfLines={3}
                textAlignVertical="top"
              />
            </View>

            {/* Quantity + Unit price */}
            <View style={mStyles.row}>
              <View style={[mStyles.section, { flex: 1, marginRight: 8 }]}>
                <Text style={[mStyles.sectionLabel, { color: colors.sub }]}>
                  ILOŚĆ
                </Text>
                <TextInput
                  style={[
                    mStyles.textInput,
                    { backgroundColor: colors.inputBg, color: colors.text, borderColor: colors.border },
                  ]}
                  placeholder="1"
                  placeholderTextColor={colors.sub}
                  value={form.quantity}
                  onChangeText={(t) => setForm((f) => ({ ...f, quantity: t }))}
                  keyboardType="decimal-pad"
                />
              </View>
              <View style={[mStyles.section, { flex: 1 }]}>
                <Text style={[mStyles.sectionLabel, { color: colors.sub }]}>
                  CENA NETTO (PLN)
                </Text>
                <TextInput
                  style={[
                    mStyles.textInput,
                    { backgroundColor: colors.inputBg, color: colors.text, borderColor: colors.border },
                  ]}
                  placeholder="0.00"
                  placeholderTextColor={colors.sub}
                  value={form.unit_price}
                  onChangeText={(t) => setForm((f) => ({ ...f, unit_price: t }))}
                  keyboardType="decimal-pad"
                />
              </View>
            </View>

            {/* Total preview */}
            <View style={[mStyles.totalPreview, { backgroundColor: '#6d28d9' + '15', borderColor: '#6d28d9' + '40' }]}>
              <Text style={[mStyles.totalLabel, { color: colors.sub }]}>
                Łącznie netto:
              </Text>
              <Text style={mStyles.totalValue}>{fmtPLN(total)}</Text>
            </View>

            {/* Date */}
            <View style={mStyles.section}>
              <Text style={[mStyles.sectionLabel, { color: colors.sub }]}>
                DATA (RRRR-MM-DD)
              </Text>
              <TextInput
                style={[
                  mStyles.textInput,
                  { backgroundColor: colors.inputBg, color: colors.text, borderColor: colors.border },
                ]}
                placeholder="2024-01-15"
                placeholderTextColor={colors.sub}
                value={form.date}
                onChangeText={(t) => setForm((f) => ({ ...f, date: t }))}
                keyboardType="numbers-and-punctuation"
              />
            </View>

            {/* Out of scope toggle */}
            <View
              style={[
                mStyles.toggleRow,
                { backgroundColor: form.is_out_of_scope ? '#f97316' + '15' : colors.inputBg, borderColor: colors.border },
              ]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[mStyles.toggleTitle, { color: colors.text }]}>
                  ⚠️  Koszt ponadprogramowy
                </Text>
                <Text style={[mStyles.toggleSub, { color: colors.sub }]}>
                  Koszt wykracza poza pierwotny zakres projektu
                </Text>
              </View>
              <Switch
                value={form.is_out_of_scope}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, is_out_of_scope: v }))
                }
                trackColor={{ false: colors.border, true: '#f97316' }}
                thumbColor={form.is_out_of_scope ? '#ffffff' : '#ffffff'}
              />
            </View>

            {/* Notes */}
            <View style={mStyles.section}>
              <Text style={[mStyles.sectionLabel, { color: colors.sub }]}>
                UWAGI
              </Text>
              <TextInput
                style={[
                  mStyles.textInput,
                  mStyles.textArea,
                  { backgroundColor: colors.inputBg, color: colors.text, borderColor: colors.border },
                ]}
                placeholder="Dodatkowe informacje..."
                placeholderTextColor={colors.sub}
                value={form.notes}
                onChangeText={(t) => setForm((f) => ({ ...f, notes: t }))}
                multiline
                numberOfLines={3}
                textAlignVertical="top"
              />
            </View>

            {/* Photo/Attachment section */}
            <View style={mStyles.section}>
              <Text style={[mStyles.sectionLabel, { color: colors.sub }]}>
                ZAŁĄCZNIKI
              </Text>
              <View style={mStyles.attachRow}>
                <TouchableOpacity
                  style={[mStyles.attachBtn, { borderColor: '#6d28d9' }]}
                  onPress={() => handlePickPhoto(true)}
                >
                  <Ionicons name="camera-outline" size={18} color="#6d28d9" />
                  <Text style={[mStyles.attachBtnText, { color: '#6d28d9' }]}>
                    Zrób zdjęcie
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[mStyles.attachBtn, { borderColor: '#6d28d9', marginLeft: 8 }]}
                  onPress={() => handlePickPhoto(false)}
                >
                  <Ionicons name="images-outline" size={18} color="#6d28d9" />
                  <Text style={[mStyles.attachBtnText, { color: '#6d28d9' }]}>
                    Z galerii
                  </Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                style={[mStyles.attachBtnFull, { borderColor: colors.border, backgroundColor: colors.inputBg }]}
                onPress={handlePickDocument}
              >
                <Ionicons name="document-attach-outline" size={18} color={colors.sub} />
                <Text style={[mStyles.attachBtnText, { color: colors.sub, marginLeft: 6 }]}>
                  Załącz dokument (PDF)
                </Text>
              </TouchableOpacity>

              {/* Preview */}
              {form.attachment && (
                <View style={[mStyles.attachPreview, { backgroundColor: colors.inputBg, borderColor: colors.border }]}>
                  {form.attachment.type === 'photo' ? (
                    <View style={mStyles.photoPreviewRow}>
                      <Image
                        source={{ uri: form.attachment.uri }}
                        style={mStyles.photoThumb}
                        resizeMode="cover"
                      />
                      <View style={{ flex: 1, marginLeft: 10 }}>
                        <Text style={[mStyles.attachName, { color: colors.text }]} numberOfLines={2}>
                          {form.attachment.name}
                        </Text>
                        <Text style={[{ color: colors.sub, fontSize: 12 }]}>Zdjęcie</Text>
                      </View>
                      <TouchableOpacity
                        onPress={() => setForm((f) => ({ ...f, attachment: null }))}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Ionicons name="close-circle" size={22} color="#ef4444" />
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <View style={mStyles.photoPreviewRow}>
                      <Ionicons name="document-text-outline" size={32} color="#6d28d9" />
                      <View style={{ flex: 1, marginLeft: 10 }}>
                        <Text style={[mStyles.attachName, { color: colors.text }]} numberOfLines={2}>
                          {form.attachment.name}
                        </Text>
                        <Text style={[{ color: colors.sub, fontSize: 12 }]}>Dokument</Text>
                      </View>
                      <TouchableOpacity
                        onPress={() => setForm((f) => ({ ...f, attachment: null }))}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Ionicons name="close-circle" size={22} color="#ef4444" />
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              )}
            </View>

            {/* Bottom save button (duplicate for scrolled state) */}
            <TouchableOpacity
              style={[mStyles.saveBtn, saving && { opacity: 0.6 }]}
              onPress={handleSave}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={mStyles.saveBtnText}>Zapisz koszt</Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

// ─── SendToClientModal ────────────────────────────────────────────────────────
interface SendModalProps {
  visible: boolean;
  onClose: () => void;
  projectName: string;
  costs: ExtraCost[];
  projectId: string;
  onSent: () => void;
  isDark: boolean;
}

function SendToClientModal({
  visible,
  onClose,
  projectName,
  costs,
  projectId,
  onSent,
  isDark,
}: SendModalProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [clientEmail, setClientEmail] = useState('');
  const [sendingEmail, setSendingEmail] = useState(false);

  // Pre-select pending items when modal opens
  useEffect(() => {
    if (visible) {
      const pendingIds = new Set(
        costs.filter((c) => c.status === 'pending').map((c) => c.id)
      );
      setSelectedIds(pendingIds);
    }
  }, [visible, costs]);

  const toggleId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectedCosts = costs.filter((c) => selectedIds.has(c.id));
  const totalSelected = selectedCosts.reduce((sum, c) => sum + c.total_price, 0);

  const handleSendEmail = async () => {
    if (!clientEmail.trim()) {
      Alert.alert('Błąd', 'Podaj adres e-mail klienta.');
      return;
    }
    if (selectedIds.size === 0) {
      Alert.alert('Błąd', 'Wybierz co najmniej jeden koszt do wysłania.');
      return;
    }

    setSendingEmail(true);
    try {
      await extraCostsApi.sendEmail(
        projectId,
        Array.from(selectedIds),
        clientEmail.trim().toLowerCase()
      );
      Alert.alert('Sukces', `Email z kosztami wysłany na adres ${clientEmail}`);
      onSent();
      onClose();
    } catch {
      Alert.alert('Błąd', 'Nie udało się wysłać emaila. Spróbuj ponownie.');
    } finally {
      setSendingEmail(false);
    }
  };

  const handleSendSMS = async () => {
    if (selectedIds.size === 0) {
      Alert.alert('Błąd', 'Wybierz co najmniej jeden koszt do wysłania.');
      return;
    }
    const available = await SMS.isAvailableAsync();
    if (!available) {
      Alert.alert('SMS niedostępny', 'Wysyłanie SMS nie jest dostępne na tym urządzeniu.');
      return;
    }
    setSendingEmail(true);
    try {
      // Generuj unikalny link akceptacji na backendzie
      const { approveUrl } = await extraCostsApi.createSmsToken(
        projectId,
        Array.from(selectedIds)
      );
      const costList = selectedCosts
        .map((c) => `• ${c.description}: ${fmtPLN(c.total_price)}`)
        .join('\n');
      const message =
        `Szanowny Kliencie,\n\n` +
        `Przesyłamy zestawienie kosztów dodatkowych do projektu "${projectName}":\n\n` +
        `${costList}\n\n` +
        `Łącznie: ${fmtPLN(totalSelected)}\n\n` +
        `W celu akceptacji kliknij poniższy link lub odpowiedz "Akceptuję":\n` +
        `${approveUrl}`;
      await SMS.sendSMSAsync([], message);
      onSent();
      onClose();
    } catch {
      Alert.alert('Błąd', 'Nie udało się wygenerować linku akceptacji. Sprawdź połączenie.');
    } finally {
      setSendingEmail(false);
    }
  };

  const colors = {
    bg: isDark ? '#111827' : '#f9fafb',
    card: isDark ? '#1f2937' : '#ffffff',
    text: isDark ? '#f9fafb' : '#111827',
    sub: isDark ? '#9ca3af' : '#6b7280',
    border: isDark ? '#374151' : '#e5e7eb',
    inputBg: isDark ? '#374151' : '#f3f4f6',
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        {/* Header */}
        <View style={[sStyles.header, { backgroundColor: '#6d28d9' }]}>
          <TouchableOpacity onPress={onClose}>
            <Ionicons name="close" size={24} color="#ffffff" />
          </TouchableOpacity>
          <Text style={sStyles.headerTitle}>Wyślij do akceptacji</Text>
          <View style={{ width: 24 }} />
        </View>

        <ScrollView
          contentContainerStyle={sStyles.content}
          showsVerticalScrollIndicator={false}
        >
          {/* Cost selection */}
          <Text style={[sStyles.sectionTitle, { color: colors.text }]}>
            Wybierz koszty do wysłania
          </Text>

          {costs.length === 0 ? (
            <Text style={[{ color: colors.sub, marginBottom: 16, fontSize: 14 }]}>
              Brak kosztów do wysłania.
            </Text>
          ) : (
            costs.map((cost) => (
              <TouchableOpacity
                key={cost.id}
                style={[
                  sStyles.costCheckRow,
                  {
                    backgroundColor: selectedIds.has(cost.id)
                      ? '#6d28d9' + '12'
                      : colors.card,
                    borderColor: selectedIds.has(cost.id)
                      ? '#6d28d9'
                      : colors.border,
                  },
                ]}
                onPress={() => toggleId(cost.id)}
              >
                <View
                  style={[
                    sStyles.checkbox,
                    {
                      backgroundColor: selectedIds.has(cost.id)
                        ? '#6d28d9'
                        : 'transparent',
                      borderColor: selectedIds.has(cost.id)
                        ? '#6d28d9'
                        : colors.border,
                    },
                  ]}
                >
                  {selectedIds.has(cost.id) && (
                    <Ionicons name="checkmark" size={14} color="#ffffff" />
                  )}
                </View>
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text style={[sStyles.costDesc, { color: colors.text }]} numberOfLines={2}>
                    {cost.description}
                  </Text>
                  <Text style={[sStyles.costAmount, { color: '#059669' }]}>
                    {fmtPLN(cost.total_price)}
                  </Text>
                </View>
                <View
                  style={[
                    sStyles.statusPill,
                    { backgroundColor: COST_STATUS_COLOR[cost.status] + '22' },
                  ]}
                >
                  <Text
                    style={[sStyles.statusPillText, { color: COST_STATUS_COLOR[cost.status] }]}
                  >
                    {COST_STATUS_LABEL[cost.status]}
                  </Text>
                </View>
              </TouchableOpacity>
            ))
          )}

          {/* Total */}
          <View style={[sStyles.totalRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[sStyles.totalLabel, { color: colors.sub }]}>
              Łącznie ({selectedIds.size} poz.):
            </Text>
            <Text style={sStyles.totalValue}>{fmtPLN(totalSelected)}</Text>
          </View>

          <View style={sStyles.divider} />

          {/* Email section */}
          <View style={[sStyles.channelCard, { backgroundColor: '#059669' + '12', borderColor: '#059669' + '40' }]}>
            <View style={sStyles.channelHeader}>
              <Ionicons name="mail" size={20} color="#059669" />
              <Text style={[sStyles.channelTitle, { color: '#059669' }]}>
                Email klienta
              </Text>
            </View>
            <TextInput
              style={[
                sStyles.emailInput,
                { backgroundColor: colors.inputBg, color: colors.text, borderColor: colors.border },
              ]}
              placeholder="klient@email.com"
              placeholderTextColor={colors.sub}
              value={clientEmail}
              onChangeText={setClientEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity
              style={[sStyles.channelBtn, { backgroundColor: '#059669' }]}
              onPress={handleSendEmail}
              disabled={sendingEmail}
            >
              {sendingEmail ? (
                <ActivityIndicator color="#ffffff" size="small" />
              ) : (
                <>
                  <Ionicons name="send-outline" size={16} color="#ffffff" style={{ marginRight: 6 }} />
                  <Text style={sStyles.channelBtnText}>Wyślij email</Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          {/* Divider OR */}
          <View style={sStyles.orRow}>
            <View style={[sStyles.orLine, { backgroundColor: colors.border }]} />
            <Text style={[sStyles.orText, { color: colors.sub }]}>lub</Text>
            <View style={[sStyles.orLine, { backgroundColor: colors.border }]} />
          </View>

          {/* SMS section */}
          <View style={[sStyles.channelCard, { backgroundColor: '#3b82f6' + '12', borderColor: '#3b82f6' + '40' }]}>
            <View style={sStyles.channelHeader}>
              <Ionicons name="chatbubble-ellipses" size={20} color="#3b82f6" />
              <Text style={[sStyles.channelTitle, { color: '#3b82f6' }]}>
                SMS
              </Text>
            </View>
            <Text style={[sStyles.smsSub, { color: colors.sub }]}>
              Wyślij wiadomość SMS z zestawieniem kosztów. Zostaniesz przeniesiony do aplikacji Wiadomości.
            </Text>
            <TouchableOpacity
              style={[sStyles.channelBtn, { backgroundColor: '#3b82f6' }]}
              onPress={handleSendSMS}
            >
              <Ionicons name="chatbubble-outline" size={16} color="#ffffff" style={{ marginRight: 6 }} />
              <Text style={sStyles.channelBtnText}>Wyślij SMS</Text>
            </TouchableOpacity>
          </View>

          {/* Cancel */}
          <TouchableOpacity
            style={[sStyles.cancelBtn, { borderColor: colors.border }]}
            onPress={onClose}
          >
            <Text style={[sStyles.cancelBtnText, { color: colors.sub }]}>Anuluj</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Cost Item Row ────────────────────────────────────────────────────────────
interface CostItemProps {
  cost: ExtraCost;
  onEdit: () => void;
  onDelete: () => void;
  isDark: boolean;
}

function CostItem({ cost, onEdit, onDelete, isDark }: CostItemProps) {
  const [expanded, setExpanded] = useState(false);

  const cardBg = isDark ? '#1f2937' : '#ffffff';
  const textColor = isDark ? '#f9fafb' : '#111827';
  const subColor = isDark ? '#9ca3af' : '#6b7280';
  const borderColor = isDark ? '#374151' : '#f3f4f6';

  const handleLongPress = () => {
    Alert.alert('Koszt dodatkowy', cost.description, [
      { text: 'Edytuj', onPress: onEdit },
      { text: 'Usuń', style: 'destructive', onPress: onDelete },
      { text: 'Anuluj', style: 'cancel' },
    ]);
  };

  return (
    <TouchableOpacity
      style={[cStyles.card, { backgroundColor: cardBg }]}
      onPress={() => setExpanded((v) => !v)}
      onLongPress={handleLongPress}
      activeOpacity={0.8}
    >
      {/* Row 1: description + status */}
      <View style={cStyles.topRow}>
        <View style={{ flex: 1, marginRight: 8 }}>
          <Text style={[cStyles.desc, { color: textColor }]} numberOfLines={expanded ? undefined : 2}>
            {cost.description}
          </Text>
          {cost.is_out_of_scope && (
            <View style={cStyles.outOfScopePill}>
              <Text style={cStyles.outOfScopePillText}>⚠️ Ponadprogramowy</Text>
            </View>
          )}
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <View
            style={[
              cStyles.statusBadge,
              { backgroundColor: COST_STATUS_COLOR[cost.status] + '22' },
            ]}
          >
            <Text
              style={[cStyles.statusText, { color: COST_STATUS_COLOR[cost.status] }]}
            >
              {COST_STATUS_LABEL[cost.status]}
            </Text>
          </View>
        </View>
      </View>

      {/* Row 2: qty × price = total + date */}
      <View style={[cStyles.bottomRow, { borderTopColor: borderColor }]}>
        <Text style={[cStyles.calcText, { color: subColor }]}>
          {fmt(cost.quantity)} × {fmt(cost.unit_price)} PLN
        </Text>
        <Text style={[cStyles.totalText, { color: textColor }]}>
          {fmtPLN(cost.total_price)}
        </Text>
      </View>

      {/* Date */}
      <View style={cStyles.dateRow}>
        <Ionicons name="calendar-outline" size={11} color={subColor} />
        <Text style={[cStyles.dateText, { color: subColor }]}>
          {' '}{new Date(cost.date).toLocaleDateString('pl-PL')}
        </Text>
      </View>

      {/* Notes (if expanded or if short) */}
      {!!cost.notes && expanded && (
        <Text style={[cStyles.notes, { color: subColor }]}>{cost.notes}</Text>
      )}

      {/* Action row */}
      <View style={[cStyles.actionRow, { borderTopColor: borderColor }]}>
        <TouchableOpacity style={cStyles.actionBtn} onPress={onEdit}>
          <Ionicons name="pencil-outline" size={14} color="#6d28d9" />
          <Text style={[cStyles.actionBtnText, { color: '#6d28d9' }]}>Edytuj</Text>
        </TouchableOpacity>
        <TouchableOpacity style={cStyles.actionBtn} onPress={onDelete}>
          <Ionicons name="trash-outline" size={14} color="#ef4444" />
          <Text style={[cStyles.actionBtnText, { color: '#ef4444' }]}>Usuń</Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

// ─── Main Project Detail Screen ───────────────────────────────────────────────
export default function ProjectDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const navigation = useNavigation();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();

  const [project, setProject] = useState<Project | null>(null);
  const [costs, setCosts] = useState<ExtraCost[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [showAddEdit, setShowAddEdit] = useState(false);
  const [editingCost, setEditingCost] = useState<ExtraCost | null>(null);
  const [showSend, setShowSend] = useState(false);

  const bgColor = isDark ? '#111827' : '#f9fafb';
  const textColor = isDark ? '#f9fafb' : '#111827';
  const subColor = isDark ? '#9ca3af' : '#6b7280';
  const cardBg = isDark ? '#1f2937' : '#ffffff';
  const borderColor = isDark ? '#374151' : '#e5e7eb';

  const fetchAll = useCallback(async () => {
    if (!id) return;
    try {
      const [proj, costList] = await Promise.all([
        projectsApi.get(id),
        extraCostsApi.list(id),
      ]);
      setProject(proj);
      setCosts(costList);

      // Update screen title
      navigation.setOptions({ title: proj.name });
    } catch {
      Alert.alert('Błąd', 'Nie udało się pobrać danych projektu.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id, navigation]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchAll();
  };

  const handleAddCost = () => {
    setEditingCost(null);
    setShowAddEdit(true);
  };

  const handleEditCost = (cost: ExtraCost) => {
    setEditingCost(cost);
    setShowAddEdit(true);
  };

  const handleDeleteCost = (cost: ExtraCost) => {
    Alert.alert(
      'Usuń koszt',
      `Czy na pewno chcesz usunąć "${cost.description}"?`,
      [
        { text: 'Anuluj', style: 'cancel' },
        {
          text: 'Usuń',
          style: 'destructive',
          onPress: async () => {
            try {
              await extraCostsApi.remove(cost.id);
              setCosts((prev) => prev.filter((c) => c.id !== cost.id));
            } catch {
              Alert.alert('Błąd', 'Nie udało się usunąć kosztu.');
            }
          },
        },
      ]
    );
  };

  const handleSaveCost = async (
    data: CreateExtraCostData,
    _attachment: AttachedFile | null
  ) => {
    if (!id) return;
    try {
      if (editingCost) {
        const updated = await extraCostsApi.update(editingCost.id, data);
        setCosts((prev) =>
          prev.map((c) => (c.id === editingCost.id ? updated : c))
        );
      } else {
        const created = await extraCostsApi.create(id, data);
        setCosts((prev) => [created, ...prev]);
      }
      setShowAddEdit(false);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string }; status?: number } };
      const msg = axiosErr?.response?.data?.error
        ?? (axiosErr?.response?.status === 401 ? 'Sesja wygasła — zaloguj się ponownie.' : null)
        ?? 'Nie udało się zapisać kosztu. Sprawdź połączenie z internetem.';
      Alert.alert('Błąd zapisu', msg);
      throw err;
    }
  };

  // Summary stats
  const stats = useMemo(() => {
    const total = costs.reduce((sum, c) => sum + c.total_price, 0);
    const pending = costs.filter((c) => c.status === 'pending').length;
    const sent = costs.filter((c) => c.status === 'sent').length;
    const approved = costs.filter((c) => c.status === 'approved').length;
    return { total, pending, sent, approved };
  }, [costs]);

  const PROJECT_STATUS_LABEL: Record<string, string> = {
    active: 'Aktywny',
    completed: 'Zakończony',
    archived: 'Archiwum',
    on_hold: 'Wstrzymany',
  };
  const PROJECT_STATUS_COLOR: Record<string, string> = {
    active: '#059669',
    completed: '#3b82f6',
    archived: '#9ca3af',
    on_hold: '#f97316',
  };

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: bgColor }}>
        <ActivityIndicator color="#6d28d9" size="large" />
        <Text style={[{ marginTop: 12, color: subColor }]}>Ładowanie...</Text>
      </View>
    );
  }

  if (!project) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: bgColor }}>
        <Ionicons name="alert-circle-outline" size={48} color={subColor} />
        <Text style={[{ marginTop: 12, color: textColor, fontSize: 16 }]}>
          Nie znaleziono projektu
        </Text>
      </View>
    );
  }

  const statusColor = PROJECT_STATUS_COLOR[project.status] ?? '#9ca3af';
  const statusLabel = PROJECT_STATUS_LABEL[project.status] ?? project.status;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: bgColor }} edges={['bottom']}>
      <FlatList
        data={costs}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#6d28d9"
            colors={['#6d28d9']}
          />
        }
        contentContainerStyle={{ paddingBottom: costs.length > 0 ? 120 : 40 }}
        ListHeaderComponent={
          <>
            {/* Project info header */}
            <View style={[pStyles.projectHeader, { backgroundColor: cardBg }]}>
              <View style={pStyles.projectHeaderTop}>
                <View style={{ flex: 1 }}>
                  <Text style={[pStyles.projectName, { color: textColor }]}>
                    {project.name}
                  </Text>
                  <View style={pStyles.projectMetaRow}>
                    <Ionicons name="person-outline" size={13} color={subColor} />
                    <Text style={[pStyles.projectMeta, { color: subColor }]}>
                      {' '}{project.client_name}
                    </Text>
                  </View>
                  {!!project.address && (
                    <View style={pStyles.projectMetaRow}>
                      <Ionicons name="location-outline" size={13} color={subColor} />
                      <Text style={[pStyles.projectMeta, { color: subColor }]}>
                        {' '}{project.address}
                      </Text>
                    </View>
                  )}
                </View>
                <View
                  style={[
                    pStyles.statusBadge,
                    { backgroundColor: statusColor + '22' },
                  ]}
                >
                  <View style={[pStyles.statusDot, { backgroundColor: statusColor }]} />
                  <Text style={[pStyles.statusLabel, { color: statusColor }]}>
                    {statusLabel}
                  </Text>
                </View>
              </View>

              {/* Budget */}
              <View
                style={[pStyles.budgetRow, { backgroundColor: '#059669' + '10', borderColor: '#059669' + '30' }]}
              >
                <Ionicons name="cash-outline" size={16} color="#059669" />
                <Text style={[pStyles.budgetLabel, { color: subColor }]}>
                  {' '}Budżet:{'  '}
                </Text>
                <Text style={pStyles.budgetValue}>{fmtPLN(project.budget_amount)}</Text>
              </View>
            </View>

            {/* Summary cards */}
            <View style={pStyles.summaryRow}>
              <View style={[pStyles.summaryCard, { backgroundColor: cardBg }]}>
                <Text style={[pStyles.summaryNum, { color: '#6d28d9' }]}>
                  {costs.length}
                </Text>
                <Text style={[pStyles.summaryLabel, { color: subColor }]}>Kosztów</Text>
              </View>
              <View style={[pStyles.summaryCard, { backgroundColor: cardBg }]}>
                <Text style={[pStyles.summaryNum, { color: '#f97316' }]}>
                  {stats.pending}
                </Text>
                <Text style={[pStyles.summaryLabel, { color: subColor }]}>Oczekuje</Text>
              </View>
              <View style={[pStyles.summaryCard, { backgroundColor: cardBg }]}>
                <Text style={[pStyles.summaryNum, { color: '#10b981' }]}>
                  {stats.approved}
                </Text>
                <Text style={[pStyles.summaryLabel, { color: subColor }]}>Zaakceptowane</Text>
              </View>
              <View style={[pStyles.summaryCard, { backgroundColor: cardBg }]}>
                <Text style={[pStyles.summaryNum, { color: '#059669', fontSize: 13 }]}>
                  {fmt(stats.total)}
                </Text>
                <Text style={[pStyles.summaryLabel, { color: subColor }]}>PLN łącznie</Text>
              </View>
            </View>

            {/* Section header */}
            <View style={[pStyles.sectionHeader, { borderBottomColor: borderColor }]}>
              <Text style={[pStyles.sectionTitle, { color: textColor }]}>
                Koszty dodatkowe
              </Text>
              <TouchableOpacity
                style={pStyles.addBtn}
                onPress={handleAddCost}
              >
                <Ionicons name="add" size={16} color="#ffffff" />
                <Text style={pStyles.addBtnText}>Dodaj</Text>
              </TouchableOpacity>
            </View>
          </>
        }
        renderItem={({ item }) => (
          <View style={{ paddingHorizontal: 16, marginBottom: 10 }}>
            <CostItem
              cost={item}
              onEdit={() => handleEditCost(item)}
              onDelete={() => handleDeleteCost(item)}
              isDark={isDark}
            />
          </View>
        )}
        ListEmptyComponent={
          <View style={pStyles.emptyState}>
            <Ionicons name="receipt-outline" size={48} color={subColor} />
            <Text style={[pStyles.emptyTitle, { color: textColor }]}>
              Brak kosztów dodatkowych
            </Text>
            <Text style={[pStyles.emptySub, { color: subColor }]}>
              Dodaj pierwszy koszt dodatkowy używając przycisku powyżej.
            </Text>
            <TouchableOpacity
              style={pStyles.emptyAddBtn}
              onPress={handleAddCost}
            >
              <Ionicons name="add-circle-outline" size={18} color="#6d28d9" style={{ marginRight: 6 }} />
              <Text style={{ color: '#6d28d9', fontWeight: '600' }}>
                Dodaj koszt dodatkowy
              </Text>
            </TouchableOpacity>
          </View>
        }
        showsVerticalScrollIndicator={false}
      />

      {/* FAB / Send button at bottom */}
      {costs.length > 0 && (
        <View style={[pStyles.bottomBar, { bottom: insets.bottom + 16, backgroundColor: cardBg, borderColor: borderColor }]}>
          <TouchableOpacity
            style={pStyles.sendBtn}
            onPress={() => setShowSend(true)}
          >
            <Ionicons name="mail-outline" size={18} color="#ffffff" style={{ marginRight: 6 }} />
            <Text style={pStyles.sendBtnText}>Wyślij do klienta</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Modals */}
      <AddEditCostModal
        visible={showAddEdit}
        onClose={() => setShowAddEdit(false)}
        onSave={handleSaveCost}
        editItem={editingCost}
        isDark={isDark}
      />

      {project && (
        <SendToClientModal
          visible={showSend}
          onClose={() => setShowSend(false)}
          projectName={project.name}
          costs={costs}
          projectId={project.id}
          onSent={fetchAll}
          isDark={isDark}
        />
      )}
    </SafeAreaView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

// Modal styles
const mStyles = StyleSheet.create({
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  modalHeaderTitle: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '700',
  },
  modalHeaderBtn: {
    minWidth: 60,
    alignItems: 'center',
  },
  modalHeaderBtnText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 15,
  },
  modalHeaderBtnBold: {
    fontWeight: '700',
    color: '#ffffff',
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  section: {
    marginBottom: 16,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  row: {
    flexDirection: 'row',
    marginBottom: 0,
  },
  textInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    minHeight: 44,
  },
  textArea: {
    minHeight: 80,
    paddingTop: 10,
  },
  totalPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 16,
  },
  totalLabel: {
    fontSize: 14,
  },
  totalValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#6d28d9',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
  },
  toggleTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  toggleSub: {
    fontSize: 12,
  },
  attachRow: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  attachBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderRadius: 8,
    paddingVertical: 10,
    gap: 4,
  },
  attachBtnFull: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    marginBottom: 8,
  },
  attachBtnText: {
    fontSize: 13,
    fontWeight: '600',
  },
  attachPreview: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginTop: 4,
  },
  photoPreviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  photoThumb: {
    width: 56,
    height: 56,
    borderRadius: 6,
    backgroundColor: '#e5e7eb',
  },
  attachName: {
    fontSize: 13,
    fontWeight: '500',
  },
  saveBtn: {
    backgroundColor: '#6d28d9',
    borderRadius: 10,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  saveBtnText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
});

// Send modal styles
const sStyles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  headerTitle: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '700',
  },
  content: {
    padding: 16,
    paddingBottom: 48,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  costCheckRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 5,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  costDesc: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 2,
  },
  costAmount: {
    fontSize: 13,
    fontWeight: '700',
  },
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
  },
  statusPillText: {
    fontSize: 10,
    fontWeight: '600',
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginTop: 4,
    marginBottom: 20,
  },
  totalLabel: {
    fontSize: 14,
  },
  totalValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#059669',
  },
  divider: {
    height: 1,
    backgroundColor: '#e5e7eb',
    marginVertical: 16,
  },
  channelCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  channelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  channelTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginLeft: 8,
  },
  emailInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    marginBottom: 10,
  },
  channelBtn: {
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  channelBtnText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  smsSub: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
  },
  orRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 4,
    marginBottom: 12,
  },
  orLine: {
    flex: 1,
    height: 1,
  },
  orText: {
    marginHorizontal: 12,
    fontSize: 13,
    fontWeight: '500',
  },
  cancelBtn: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 8,
  },
  cancelBtnText: {
    fontSize: 15,
    fontWeight: '600',
  },
});

// Cost item styles
const cStyles = StyleSheet.create({
  card: {
    borderRadius: 12,
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 1,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  desc: {
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 20,
  },
  outOfScopePill: {
    marginTop: 4,
    alignSelf: 'flex-start',
    backgroundColor: '#f97316' + '20',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 20,
  },
  outOfScopePillText: {
    fontSize: 11,
    color: '#f97316',
    fontWeight: '600',
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '600',
  },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 8,
    borderTopWidth: 1,
  },
  calcText: {
    fontSize: 12,
  },
  totalText: {
    fontSize: 15,
    fontWeight: '700',
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  dateText: {
    fontSize: 11,
  },
  notes: {
    fontSize: 12,
    lineHeight: 16,
    marginTop: 6,
    fontStyle: 'italic',
  },
  actionRow: {
    flexDirection: 'row',
    borderTopWidth: 1,
    marginTop: 10,
    paddingTop: 8,
    gap: 16,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  actionBtnText: {
    fontSize: 12,
    fontWeight: '600',
  },
});

// Project detail styles
const pStyles = StyleSheet.create({
  projectHeader: {
    margin: 16,
    marginBottom: 12,
    borderRadius: 14,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  projectHeaderTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  projectName: {
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 6,
    lineHeight: 26,
  },
  projectMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 3,
  },
  projectMeta: {
    fontSize: 13,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    flexShrink: 0,
    marginLeft: 8,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    marginRight: 5,
  },
  statusLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  budgetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  budgetLabel: {
    fontSize: 13,
  },
  budgetValue: {
    fontSize: 15,
    fontWeight: '700',
    color: '#059669',
  },
  summaryRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    marginBottom: 12,
    gap: 8,
  },
  summaryCard: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 4,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  summaryNum: {
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 2,
  },
  summaryLabel: {
    fontSize: 9,
    textAlign: 'center',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    fontWeight: '600',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    marginBottom: 4,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#6d28d9',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 2,
  },
  addBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 48,
    paddingHorizontal: 40,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '700',
    marginTop: 14,
    marginBottom: 6,
  },
  emptySub: {
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 20,
  },
  emptyAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#6d28d9',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  bottomBar: {
    position: 'absolute',
    left: 16,
    right: 16,
    backgroundColor: '#ffffff',
    borderRadius: 14,
    borderWidth: 1,
    padding: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 6,
  },
  sendBtn: {
    backgroundColor: '#6d28d9',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  sendBtnText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
});
