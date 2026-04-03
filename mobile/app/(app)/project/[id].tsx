import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
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
  costItemsApi,
  laborApi,
  Project,
  ExtraCost,
  ExtraCostStatus,
  CreateExtraCostData,
  CostItem,
  CostCategory,
  CreateCostItemData,
  LaborEntry,
  CreateLaborEntryData,
} from '../../../src/api/client';

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

// ─── Tab definitions ──────────────────────────────────────────────────────────
type TabKey = 'materials' | 'subcontractor' | 'labor' | 'extra';
const TABS: { key: TabKey; label: string; icon: keyof typeof Ionicons.glyphMap; color: string }[] = [
  { key: 'materials',    label: 'Materiał',   icon: 'cube-outline',        color: '#f59e0b' },
  { key: 'subcontractor',label: 'Podwykon.',  icon: 'construct-outline',   color: '#3b82f6' },
  { key: 'labor',        label: 'Robocizna',  icon: 'time-outline',        color: '#10b981' },
  { key: 'extra',        label: 'Dodatkowe',  icon: 'alert-circle-outline',color: '#6d28d9' },
];

// ─── Status labels / colors for ExtraCost ─────────────────────────────────────
const EXTRA_STATUS_COLOR: Record<ExtraCostStatus, string> = {
  pending:  '#f97316',
  sent:     '#3b82f6',
  approved: '#10b981',
  rejected: '#ef4444',
};
const EXTRA_STATUS_LABEL: Record<ExtraCostStatus, string> = {
  pending:  'Oczekujący',
  sent:     'Wysłany',
  approved: 'Zaakceptowany',
  rejected: 'Odrzucony',
};

const CATEGORY_LABEL: Record<CostCategory, string> = {
  materials:     'Materiał',
  subcontractor: 'Podwykonawca',
  other:         'Inne',
};

// ─── Types ────────────────────────────────────────────────────────────────────
interface AttachedFile {
  uri: string;
  name: string;
  type: 'photo' | 'document';
  mimeType: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL: Add/Edit ExtraCost (Koszty dodatkowe)
// ═══════════════════════════════════════════════════════════════════════════════
interface AddExtraCostModalProps {
  visible: boolean;
  onClose: () => void;
  onSave: (data: CreateExtraCostData, attachment: AttachedFile | null) => Promise<void>;
  editItem?: ExtraCost | null;
  isDark: boolean;
}

function AddExtraCostModal({ visible, onClose, onSave, editItem, isDark }: AddExtraCostModalProps) {
  const [form, setForm] = useState({
    description: '', quantity: '1', unit_price: '', date: today(),
    is_out_of_scope: false, notes: '', attachment: null as AttachedFile | null,
  });
  const [saving, setSaving] = useState(false);

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
      setForm({ description: '', quantity: '1', unit_price: '', date: today(), is_out_of_scope: false, notes: '', attachment: null });
    }
  }, [editItem, visible]);

  const total = useMemo(() => (parseFloat(form.quantity) || 0) * (parseFloat(form.unit_price) || 0), [form.quantity, form.unit_price]);

  const handlePickPhoto = async (useCamera: boolean) => {
    try {
      let result: ImagePicker.ImagePickerResult;
      if (useCamera) {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) { Alert.alert('Brak uprawnień', 'Zezwól na dostęp do aparatu.'); return; }
        result = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 });
      } else {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) { Alert.alert('Brak uprawnień', 'Zezwól na dostęp do galerii.'); return; }
        result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 });
      }
      if (!result.canceled && result.assets.length > 0) {
        const a = result.assets[0];
        const name = a.fileName ?? `photo_${Date.now()}.jpg`;
        setForm(f => ({ ...f, attachment: { uri: a.uri, name, type: 'photo', mimeType: a.mimeType ?? 'image/jpeg' } }));
      }
    } catch { Alert.alert('Błąd', 'Nie udało się wybrać zdjęcia.'); }
  };

  const handlePickDoc = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ['application/pdf', 'image/*'], copyToCacheDirectory: true });
      if (!result.canceled && result.assets.length > 0) {
        const a = result.assets[0];
        setForm(f => ({ ...f, attachment: { uri: a.uri, name: a.name, type: 'document', mimeType: a.mimeType ?? 'application/octet-stream' } }));
      }
    } catch { Alert.alert('Błąd', 'Nie udało się wybrać dokumentu.'); }
  };

  const handleSave = async () => {
    if (!form.description.trim()) { Alert.alert('Błąd', 'Opis jest wymagany.'); return; }
    const qty = parseFloat(form.quantity) || 1;
    const price = parseFloat(form.unit_price) || 0;
    setSaving(true);
    try {
      await onSave({ description: form.description.trim(), quantity: qty, unit_price: price, date: form.date, is_out_of_scope: form.is_out_of_scope, notes: form.notes.trim() || undefined }, form.attachment);
    } finally { setSaving(false); }
  };

  const c = { bg: isDark ? '#1f2937' : '#ffffff', text: isDark ? '#f9fafb' : '#111827', sub: isDark ? '#9ca3af' : '#6b7280', inputBg: isDark ? '#374151' : '#f3f4f6', border: isDark ? '#374151' : '#e5e7eb' };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#6d28d9' }} edges={['top']}>
        <View style={mStyles.modalHeader}>
          <TouchableOpacity style={mStyles.modalHeaderBtn} onPress={onClose}>
            <Text style={mStyles.modalHeaderBtnText}>Anuluj</Text>
          </TouchableOpacity>
          <Text style={mStyles.modalHeaderTitle}>{editItem ? 'Edytuj koszt' : 'Nowy koszt dodatkowy'}</Text>
          <TouchableOpacity style={mStyles.modalHeaderBtn} onPress={handleSave} disabled={saving}>
            <Text style={[mStyles.modalHeaderBtnText, mStyles.modalHeaderBtnBold]}>{saving ? '...' : 'Zapisz'}</Text>
          </TouchableOpacity>
        </View>
        <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={mStyles.scrollContent} keyboardShouldPersistTaps="handled">

            <Text style={[mStyles.sectionLabel, { color: c.sub }]}>OPIS *</Text>
            <TextInput style={[mStyles.textInput, { backgroundColor: c.inputBg, borderColor: c.border, color: c.text }]} value={form.description} onChangeText={v => setForm(f => ({ ...f, description: v }))} placeholder="Np. materiały do montażu..." placeholderTextColor={c.sub} multiline numberOfLines={2} />

            <View style={[mStyles.row, { gap: 10, marginTop: 14 }]}>
              <View style={{ flex: 1 }}>
                <Text style={[mStyles.sectionLabel, { color: c.sub }]}>ILOŚĆ</Text>
                <TextInput style={[mStyles.textInput, { backgroundColor: c.inputBg, borderColor: c.border, color: c.text }]} value={form.quantity} onChangeText={v => setForm(f => ({ ...f, quantity: v }))} keyboardType="decimal-pad" placeholder="1" placeholderTextColor={c.sub} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[mStyles.sectionLabel, { color: c.sub }]}>CENA JEDN. (PLN)</Text>
                <TextInput style={[mStyles.textInput, { backgroundColor: c.inputBg, borderColor: c.border, color: c.text }]} value={form.unit_price} onChangeText={v => setForm(f => ({ ...f, unit_price: v }))} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={c.sub} />
              </View>
            </View>

            <View style={[mStyles.totalPreview, { backgroundColor: '#6d28d9' + '10', borderColor: '#6d28d9' + '30', marginTop: 10 }]}>
              <Text style={[mStyles.totalLabel, { color: c.sub }]}>Razem</Text>
              <Text style={mStyles.totalValue}>{fmtPLN(total)}</Text>
            </View>

            <Text style={[mStyles.sectionLabel, { color: c.sub }]}>DATA</Text>
            <TextInput style={[mStyles.textInput, { backgroundColor: c.inputBg, borderColor: c.border, color: c.text }]} value={form.date} onChangeText={v => setForm(f => ({ ...f, date: v }))} placeholder="RRRR-MM-DD" placeholderTextColor={c.sub} />

            <View style={[mStyles.toggleRow, { backgroundColor: c.inputBg, borderColor: c.border, marginTop: 14 }]}>
              <View style={{ flex: 1 }}>
                <Text style={[mStyles.toggleTitle, { color: c.text }]}>Ponadprogramowy</Text>
                <Text style={[mStyles.toggleSub, { color: c.sub }]}>Koszt poza zakresem projektu</Text>
              </View>
              <Switch value={form.is_out_of_scope} onValueChange={v => setForm(f => ({ ...f, is_out_of_scope: v }))} trackColor={{ false: '#d1d5db', true: '#6d28d9' }} thumbColor="#ffffff" />
            </View>

            <Text style={[mStyles.sectionLabel, { color: c.sub, marginTop: 4 }]}>NOTATKI</Text>
            <TextInput style={[mStyles.textInput, mStyles.textArea, { backgroundColor: c.inputBg, borderColor: c.border, color: c.text }]} value={form.notes} onChangeText={v => setForm(f => ({ ...f, notes: v }))} placeholder="Opcjonalne notatki..." placeholderTextColor={c.sub} multiline numberOfLines={3} />

            <Text style={[mStyles.sectionLabel, { color: c.sub, marginTop: 14 }]}>ZAŁĄCZNIK</Text>
            {!form.attachment ? (
              <>
                <View style={[mStyles.attachRow, { gap: 8 }]}>
                  <TouchableOpacity style={[mStyles.attachBtn, { borderColor: c.border, backgroundColor: c.inputBg }]} onPress={() => handlePickPhoto(true)}>
                    <Ionicons name="camera-outline" size={18} color={c.sub} />
                    <Text style={[mStyles.attachBtnText, { color: c.sub }]}>Aparat</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[mStyles.attachBtn, { borderColor: c.border, backgroundColor: c.inputBg }]} onPress={() => handlePickPhoto(false)}>
                    <Ionicons name="image-outline" size={18} color={c.sub} />
                    <Text style={[mStyles.attachBtnText, { color: c.sub }]}>Galeria</Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity style={[mStyles.attachBtnFull, { borderColor: c.border, backgroundColor: c.inputBg }]} onPress={handlePickDoc}>
                  <Ionicons name="document-attach-outline" size={18} color={c.sub} />
                  <Text style={[mStyles.attachBtnText, { color: c.sub, marginLeft: 6 }]}>Dodaj dokument (PDF)</Text>
                </TouchableOpacity>
              </>
            ) : (
              <View style={[mStyles.attachPreview, { borderColor: c.border, backgroundColor: c.inputBg }]}>
                {form.attachment.type === 'photo' ? (
                  <View style={mStyles.photoPreviewRow}>
                    <Image source={{ uri: form.attachment.uri }} style={mStyles.photoThumb} />
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={[mStyles.attachName, { color: c.text }]} numberOfLines={2}>{form.attachment.name}</Text>
                      <TouchableOpacity onPress={() => setForm(f => ({ ...f, attachment: null }))}>
                        <Text style={{ color: '#ef4444', fontSize: 13, marginTop: 4 }}>Usuń</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Ionicons name="document-outline" size={32} color="#6d28d9" />
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={[mStyles.attachName, { color: c.text }]} numberOfLines={2}>{form.attachment.name}</Text>
                      <TouchableOpacity onPress={() => setForm(f => ({ ...f, attachment: null }))}>
                        <Text style={{ color: '#ef4444', fontSize: 13, marginTop: 4 }}>Usuń</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              </View>
            )}

            <TouchableOpacity style={[mStyles.saveBtn, { opacity: saving ? 0.7 : 1 }]} onPress={handleSave} disabled={saving}>
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={mStyles.saveBtnText}>{editItem ? 'Zapisz zmiany' : 'Dodaj koszt'}</Text>}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL: Add/Edit CostItem (Materiał / Podwykonawca)
// ═══════════════════════════════════════════════════════════════════════════════
interface AddCostItemModalProps {
  visible: boolean;
  onClose: () => void;
  onSave: (data: CreateCostItemData) => Promise<void>;
  editItem?: CostItem | null;
  category: CostCategory;
  isDark: boolean;
}

function AddCostItemModal({ visible, onClose, onSave, editItem, category, isDark }: AddCostItemModalProps) {
  const [form, setForm] = useState({ description: '', supplier: '', invoice_number: '', quantity: '1', unit_price: '', date: today() });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editItem) {
      setForm({
        description: editItem.description,
        supplier: editItem.supplier ?? '',
        invoice_number: editItem.invoice_number ?? '',
        quantity: String(editItem.quantity),
        unit_price: String(editItem.unit_price),
        date: editItem.date.split('T')[0],
      });
    } else {
      setForm({ description: '', supplier: '', invoice_number: '', quantity: '1', unit_price: '', date: today() });
    }
  }, [editItem, visible]);

  const total = useMemo(() => (parseFloat(form.quantity) || 0) * (parseFloat(form.unit_price) || 0), [form.quantity, form.unit_price]);

  const tabInfo = TABS.find(t => t.key === category) ?? TABS[0];
  const accentColor = tabInfo.color;

  const handleSave = async () => {
    if (!form.description.trim()) { Alert.alert('Błąd', 'Opis jest wymagany.'); return; }
    setSaving(true);
    try {
      await onSave({
        category,
        description: form.description.trim(),
        quantity: parseFloat(form.quantity) || 1,
        unit_price: parseFloat(form.unit_price) || 0,
        supplier: form.supplier.trim() || undefined,
        invoice_number: form.invoice_number.trim() || undefined,
        date: form.date,
      });
    } finally { setSaving(false); }
  };

  const c = { bg: isDark ? '#1f2937' : '#ffffff', text: isDark ? '#f9fafb' : '#111827', sub: isDark ? '#9ca3af' : '#6b7280', inputBg: isDark ? '#374151' : '#f3f4f6', border: isDark ? '#374151' : '#e5e7eb' };
  const title = editItem ? `Edytuj ${CATEGORY_LABEL[category].toLowerCase()}` : `Nowy: ${CATEGORY_LABEL[category]}`;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: accentColor }} edges={['top']}>
        <View style={mStyles.modalHeader}>
          <TouchableOpacity style={mStyles.modalHeaderBtn} onPress={onClose}>
            <Text style={mStyles.modalHeaderBtnText}>Anuluj</Text>
          </TouchableOpacity>
          <Text style={mStyles.modalHeaderTitle}>{title}</Text>
          <TouchableOpacity style={mStyles.modalHeaderBtn} onPress={handleSave} disabled={saving}>
            <Text style={[mStyles.modalHeaderBtnText, mStyles.modalHeaderBtnBold]}>{saving ? '...' : 'Zapisz'}</Text>
          </TouchableOpacity>
        </View>
        <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={mStyles.scrollContent} keyboardShouldPersistTaps="handled">

            <Text style={[mStyles.sectionLabel, { color: c.sub }]}>OPIS *</Text>
            <TextInput style={[mStyles.textInput, { backgroundColor: c.inputBg, borderColor: c.border, color: c.text }]} value={form.description} onChangeText={v => setForm(f => ({ ...f, description: v }))} placeholder={category === 'materials' ? 'Np. kabel YDY 3x1.5mm...' : 'Np. montaż instalacji elektrycznej...'} placeholderTextColor={c.sub} multiline numberOfLines={2} />

            <Text style={[mStyles.sectionLabel, { color: c.sub, marginTop: 14 }]}>{category === 'subcontractor' ? 'FIRMA / WYKONAWCA' : 'DOSTAWCA / PRODUCENT'}</Text>
            <TextInput style={[mStyles.textInput, { backgroundColor: c.inputBg, borderColor: c.border, color: c.text }]} value={form.supplier} onChangeText={v => setForm(f => ({ ...f, supplier: v }))} placeholder="Opcjonalnie" placeholderTextColor={c.sub} />

            <Text style={[mStyles.sectionLabel, { color: c.sub, marginTop: 14 }]}>NR FAKTURY / DOKUMENTU</Text>
            <TextInput style={[mStyles.textInput, { backgroundColor: c.inputBg, borderColor: c.border, color: c.text }]} value={form.invoice_number} onChangeText={v => setForm(f => ({ ...f, invoice_number: v }))} placeholder="Np. FV/2024/01/123" placeholderTextColor={c.sub} />

            <View style={[mStyles.row, { gap: 10, marginTop: 14 }]}>
              <View style={{ flex: 1 }}>
                <Text style={[mStyles.sectionLabel, { color: c.sub }]}>ILOŚĆ</Text>
                <TextInput style={[mStyles.textInput, { backgroundColor: c.inputBg, borderColor: c.border, color: c.text }]} value={form.quantity} onChangeText={v => setForm(f => ({ ...f, quantity: v }))} keyboardType="decimal-pad" placeholder="1" placeholderTextColor={c.sub} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[mStyles.sectionLabel, { color: c.sub }]}>CENA JEDN. (PLN)</Text>
                <TextInput style={[mStyles.textInput, { backgroundColor: c.inputBg, borderColor: c.border, color: c.text }]} value={form.unit_price} onChangeText={v => setForm(f => ({ ...f, unit_price: v }))} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={c.sub} />
              </View>
            </View>

            <View style={[mStyles.totalPreview, { backgroundColor: accentColor + '15', borderColor: accentColor + '40', marginTop: 10 }]}>
              <Text style={[mStyles.totalLabel, { color: c.sub }]}>Razem</Text>
              <Text style={[mStyles.totalValue, { color: accentColor }]}>{fmtPLN(total)}</Text>
            </View>

            <Text style={[mStyles.sectionLabel, { color: c.sub }]}>DATA</Text>
            <TextInput style={[mStyles.textInput, { backgroundColor: c.inputBg, borderColor: c.border, color: c.text }]} value={form.date} onChangeText={v => setForm(f => ({ ...f, date: v }))} placeholder="RRRR-MM-DD" placeholderTextColor={c.sub} />

            <TouchableOpacity style={[mStyles.saveBtn, { backgroundColor: accentColor, opacity: saving ? 0.7 : 1, marginTop: 20 }]} onPress={handleSave} disabled={saving}>
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={mStyles.saveBtnText}>{editItem ? 'Zapisz zmiany' : `Dodaj ${CATEGORY_LABEL[category].toLowerCase()}`}</Text>}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL: Add/Edit LaborEntry (Robocizna)
// ═══════════════════════════════════════════════════════════════════════════════
interface AddLaborModalProps {
  visible: boolean;
  onClose: () => void;
  onSave: (data: CreateLaborEntryData) => Promise<void>;
  editItem?: LaborEntry | null;
  isDark: boolean;
}

function AddLaborModal({ visible, onClose, onSave, editItem, isDark }: AddLaborModalProps) {
  const [form, setForm] = useState({ worker_name: '', description: '', hours: '', hourly_rate: '', date: today() });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editItem) {
      setForm({
        worker_name: editItem.worker_name,
        description: editItem.description ?? '',
        hours: String(editItem.hours),
        hourly_rate: String(editItem.hourly_rate),
        date: editItem.date.split('T')[0],
      });
    } else {
      setForm({ worker_name: '', description: '', hours: '', hourly_rate: '', date: today() });
    }
  }, [editItem, visible]);

  const total = useMemo(() => (parseFloat(form.hours) || 0) * (parseFloat(form.hourly_rate) || 0), [form.hours, form.hourly_rate]);
  const accentColor = '#10b981';

  const handleSave = async () => {
    if (!form.worker_name.trim()) { Alert.alert('Błąd', 'Imię pracownika jest wymagane.'); return; }
    if (!form.hours || parseFloat(form.hours) <= 0) { Alert.alert('Błąd', 'Podaj liczbę godzin.'); return; }
    setSaving(true);
    try {
      await onSave({
        worker_name: form.worker_name.trim(),
        date: form.date,
        hours: parseFloat(form.hours) || 0,
        hourly_rate: parseFloat(form.hourly_rate) || 0,
        description: form.description.trim() || undefined,
      });
    } finally { setSaving(false); }
  };

  const c = { bg: isDark ? '#1f2937' : '#ffffff', text: isDark ? '#f9fafb' : '#111827', sub: isDark ? '#9ca3af' : '#6b7280', inputBg: isDark ? '#374151' : '#f3f4f6', border: isDark ? '#374151' : '#e5e7eb' };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: accentColor }} edges={['top']}>
        <View style={mStyles.modalHeader}>
          <TouchableOpacity style={mStyles.modalHeaderBtn} onPress={onClose}>
            <Text style={mStyles.modalHeaderBtnText}>Anuluj</Text>
          </TouchableOpacity>
          <Text style={mStyles.modalHeaderTitle}>{editItem ? 'Edytuj robociznę' : 'Nowa robocizna'}</Text>
          <TouchableOpacity style={mStyles.modalHeaderBtn} onPress={handleSave} disabled={saving}>
            <Text style={[mStyles.modalHeaderBtnText, mStyles.modalHeaderBtnBold]}>{saving ? '...' : 'Zapisz'}</Text>
          </TouchableOpacity>
        </View>
        <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={mStyles.scrollContent} keyboardShouldPersistTaps="handled">

            <Text style={[mStyles.sectionLabel, { color: c.sub }]}>PRACOWNIK *</Text>
            <TextInput style={[mStyles.textInput, { backgroundColor: c.inputBg, borderColor: c.border, color: c.text }]} value={form.worker_name} onChangeText={v => setForm(f => ({ ...f, worker_name: v }))} placeholder="Imię i nazwisko" placeholderTextColor={c.sub} />

            <Text style={[mStyles.sectionLabel, { color: c.sub, marginTop: 14 }]}>OPIS PRACY</Text>
            <TextInput style={[mStyles.textInput, mStyles.textArea, { backgroundColor: c.inputBg, borderColor: c.border, color: c.text }]} value={form.description} onChangeText={v => setForm(f => ({ ...f, description: v }))} placeholder="Np. montaż instalacji elektrycznej, prace wykończeniowe..." placeholderTextColor={c.sub} multiline numberOfLines={3} />

            <View style={[mStyles.row, { gap: 10, marginTop: 14 }]}>
              <View style={{ flex: 1 }}>
                <Text style={[mStyles.sectionLabel, { color: c.sub }]}>GODZINY</Text>
                <TextInput style={[mStyles.textInput, { backgroundColor: c.inputBg, borderColor: c.border, color: c.text }]} value={form.hours} onChangeText={v => setForm(f => ({ ...f, hours: v }))} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={c.sub} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[mStyles.sectionLabel, { color: c.sub }]}>STAWKA (PLN/h)</Text>
                <TextInput style={[mStyles.textInput, { backgroundColor: c.inputBg, borderColor: c.border, color: c.text }]} value={form.hourly_rate} onChangeText={v => setForm(f => ({ ...f, hourly_rate: v }))} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={c.sub} />
              </View>
            </View>

            <View style={[mStyles.totalPreview, { backgroundColor: accentColor + '15', borderColor: accentColor + '40', marginTop: 10 }]}>
              <View>
                <Text style={[mStyles.totalLabel, { color: c.sub }]}>Razem</Text>
                {parseFloat(form.hours) > 0 && parseFloat(form.hourly_rate) > 0 && (
                  <Text style={{ fontSize: 11, color: c.sub }}>{form.hours} h × {form.hourly_rate} PLN/h</Text>
                )}
              </View>
              <Text style={[mStyles.totalValue, { color: accentColor }]}>{fmtPLN(total)}</Text>
            </View>

            <Text style={[mStyles.sectionLabel, { color: c.sub }]}>DATA</Text>
            <TextInput style={[mStyles.textInput, { backgroundColor: c.inputBg, borderColor: c.border, color: c.text }]} value={form.date} onChangeText={v => setForm(f => ({ ...f, date: v }))} placeholder="RRRR-MM-DD" placeholderTextColor={c.sub} />

            <TouchableOpacity style={[mStyles.saveBtn, { backgroundColor: accentColor, opacity: saving ? 0.7 : 1, marginTop: 20 }]} onPress={handleSave} disabled={saving}>
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={mStyles.saveBtnText}>{editItem ? 'Zapisz zmiany' : 'Dodaj robociznę'}</Text>}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL: Send to Client (Koszty dodatkowe)
// ═══════════════════════════════════════════════════════════════════════════════
interface SendModalProps {
  visible: boolean;
  onClose: () => void;
  projectName: string;
  costs: ExtraCost[];
  projectId: string;
  onSent: () => void;
  isDark: boolean;
}

function SendToClientModal({ visible, onClose, projectName, costs, projectId, onSent, isDark }: SendModalProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [clientEmail, setClientEmail] = useState('');
  const [sendingEmail, setSendingEmail] = useState(false);

  useEffect(() => {
    if (visible) {
      setSelectedIds(new Set(costs.filter(c => c.status === 'pending').map(c => c.id)));
    }
  }, [visible, costs]);

  const toggleId = (id: string) => setSelectedIds(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const selectedCosts = costs.filter(c => selectedIds.has(c.id));
  const totalSelected = selectedCosts.reduce((s, c) => s + c.total_price, 0);

  const handleSendEmail = async () => {
    if (selectedIds.size === 0) { Alert.alert('Błąd', 'Wybierz co najmniej jeden koszt.'); return; }
    if (!clientEmail.trim() || !clientEmail.includes('@')) { Alert.alert('Błąd', 'Podaj poprawny adres email klienta.'); return; }
    setSendingEmail(true);
    try {
      await extraCostsApi.sendEmail(projectId, Array.from(selectedIds), clientEmail.trim());
      Alert.alert('Wysłano!', `Email z kosztami do akceptacji wysłany na ${clientEmail}.`);
      onSent(); onClose();
    } catch { Alert.alert('Błąd', 'Nie udało się wysłać emaila.'); }
    finally { setSendingEmail(false); }
  };

  const handleSendSMS = async () => {
    if (selectedIds.size === 0) { Alert.alert('Błąd', 'Wybierz co najmniej jeden koszt.'); return; }
    const available = await SMS.isAvailableAsync();
    if (!available) { Alert.alert('SMS niedostępny', 'Wysyłanie SMS nie jest dostępne na tym urządzeniu.'); return; }
    setSendingEmail(true);
    try {
      const { approveUrl } = await extraCostsApi.createSmsToken(projectId, Array.from(selectedIds));
      const costList = selectedCosts.map(c => `• ${c.description}: ${fmtPLN(c.total_price)}`).join('\n');
      const message = `Szanowny Kliencie,\n\nPrzesyłamy zestawienie kosztów dodatkowych do projektu "${projectName}":\n\n${costList}\n\nŁącznie: ${fmtPLN(totalSelected)}\n\nAby zaakceptować koszty, kliknij poniższy link:\n${approveUrl}\n\nJeśli nie akceptujesz dodatkowych kosztów, skontaktuj się z nadawcą tej wiadomości.\n\nLink jest ważny przez 14 dni.`;
      await SMS.sendSMSAsync([], message);
      onSent(); onClose();
    } catch { Alert.alert('Błąd', 'Nie udało się wygenerować linku akceptacji. Sprawdź połączenie.'); }
    finally { setSendingEmail(false); }
  };

  const c = { bg: isDark ? '#111827' : '#f9fafb', card: isDark ? '#1f2937' : '#ffffff', text: isDark ? '#f9fafb' : '#111827', sub: isDark ? '#9ca3af' : '#6b7280', border: isDark ? '#374151' : '#e5e7eb', inputBg: isDark ? '#374151' : '#f3f4f6' };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#6d28d9' }} edges={['top']}>
        <View style={sStyles.header}>
          <TouchableOpacity onPress={onClose}><Ionicons name="close" size={24} color="#ffffff" /></TouchableOpacity>
          <Text style={sStyles.headerTitle}>Wyślij do klienta</Text>
          <View style={{ width: 24 }} />
        </View>
        <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={sStyles.content} keyboardShouldPersistTaps="handled">

          {/* Email input */}
          <View style={{ backgroundColor: '#059669' + '15', borderWidth: 1, borderColor: '#059669' + '40', borderRadius: 12, padding: 14, marginBottom: 16 }}>
            <Text style={[sStyles.sectionTitle, { color: '#059669' }]}>EMAIL KLIENTA</Text>
            <TextInput style={[sStyles.emailInput, { backgroundColor: c.inputBg, borderColor: c.border, color: c.text }]} value={clientEmail} onChangeText={setClientEmail} placeholder="klient@firma.pl" placeholderTextColor={c.sub} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} />
            <TouchableOpacity style={[sStyles.channelBtn, { backgroundColor: '#059669', opacity: sendingEmail ? 0.7 : 1 }]} onPress={handleSendEmail} disabled={sendingEmail}>
              {sendingEmail ? <ActivityIndicator color="#fff" size="small" /> : <>
                <Ionicons name="mail-outline" size={18} color="#ffffff" style={{ marginRight: 6 }} />
                <Text style={sStyles.channelBtnText}>Wyślij email z linkiem akceptacji</Text>
              </>}
            </TouchableOpacity>
          </View>

          {/* OR divider */}
          <View style={sStyles.orRow}>
            <View style={[sStyles.orLine, { backgroundColor: c.border }]} />
            <Text style={[sStyles.orText, { color: c.sub }]}>LUB</Text>
            <View style={[sStyles.orLine, { backgroundColor: c.border }]} />
          </View>

          {/* SMS */}
          <View style={[sStyles.channelCard, { backgroundColor: c.card, borderColor: c.border, marginBottom: 16 }]}>
            <View style={sStyles.channelHeader}>
              <Ionicons name="chatbubble-outline" size={22} color="#3b82f6" />
              <Text style={[sStyles.channelTitle, { color: c.text }]}>SMS</Text>
            </View>
            <Text style={[sStyles.smsSub, { color: c.sub }]}>Wyślij SMS z linkiem do akceptacji. Kliknięcie linku przez klienta automatycznie zatwierdzi koszty.</Text>
            <TouchableOpacity style={[sStyles.channelBtn, { backgroundColor: '#3b82f6', opacity: sendingEmail ? 0.7 : 1 }]} onPress={handleSendSMS} disabled={sendingEmail}>
              {sendingEmail ? <ActivityIndicator color="#fff" size="small" /> : <>
                <Ionicons name="phone-portrait-outline" size={18} color="#ffffff" style={{ marginRight: 6 }} />
                <Text style={sStyles.channelBtnText}>Wyślij SMS</Text>
              </>}
            </TouchableOpacity>
          </View>

          {/* Cost selection */}
          <Text style={[sStyles.sectionTitle, { color: c.sub, marginBottom: 8 }]}>WYBIERZ KOSZTY ({selectedIds.size}/{costs.length})</Text>
          {costs.map(cost => {
            const selected = selectedIds.has(cost.id);
            return (
              <TouchableOpacity
                key={cost.id}
                style={[sStyles.costCheckRow, { borderColor: selected ? '#6d28d9' : c.border, backgroundColor: selected ? '#6d28d9' + '10' : c.card }]}
                onPress={() => toggleId(cost.id)}
              >
                <View style={[sStyles.checkbox, { borderColor: selected ? '#6d28d9' : c.border, backgroundColor: selected ? '#6d28d9' : 'transparent' }]}>
                  {selected && <Ionicons name="checkmark" size={14} color="#ffffff" />}
                </View>
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text style={[sStyles.costDesc, { color: c.text }]} numberOfLines={2}>{cost.description}</Text>
                  <Text style={[sStyles.costAmount, { color: EXTRA_STATUS_COLOR[cost.status] }]}>{fmtPLN(cost.total_price)}</Text>
                </View>
                <View style={[sStyles.statusPill, { backgroundColor: EXTRA_STATUS_COLOR[cost.status] + '22' }]}>
                  <Text style={[sStyles.statusPillText, { color: EXTRA_STATUS_COLOR[cost.status] }]}>{EXTRA_STATUS_LABEL[cost.status]}</Text>
                </View>
              </TouchableOpacity>
            );
          })}

          {selectedIds.size > 0 && (
            <View style={[sStyles.totalRow, { borderColor: c.border, backgroundColor: c.card }]}>
              <Text style={[sStyles.totalLabel, { color: c.sub }]}>Łącznie ({selectedIds.size} poz.)</Text>
              <Text style={sStyles.totalValue}>{fmtPLN(totalSelected)}</Text>
            </View>
          )}

          <TouchableOpacity style={[sStyles.cancelBtn, { borderColor: c.border }]} onPress={onClose}>
            <Text style={[sStyles.cancelBtnText, { color: c.sub }]}>Zamknij</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROW: ExtraCost
// ═══════════════════════════════════════════════════════════════════════════════
function ExtraCostRow({ cost, onEdit, onDelete, isDark }: { cost: ExtraCost; onEdit: () => void; onDelete: () => void; isDark: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const cardBg = isDark ? '#1f2937' : '#ffffff';
  const textColor = isDark ? '#f9fafb' : '#111827';
  const subColor = isDark ? '#9ca3af' : '#6b7280';
  const borderColor = isDark ? '#374151' : '#f3f4f6';

  return (
    <TouchableOpacity style={[rowStyles.card, { backgroundColor: cardBg }]} onPress={() => setExpanded(v => !v)} onLongPress={() => Alert.alert('Koszt dodatkowy', cost.description, [{ text: 'Edytuj', onPress: onEdit }, { text: 'Usuń', style: 'destructive', onPress: onDelete }, { text: 'Anuluj', style: 'cancel' }])} activeOpacity={0.8}>
      <View style={rowStyles.topRow}>
        <View style={{ flex: 1, marginRight: 8 }}>
          <Text style={[rowStyles.desc, { color: textColor }]} numberOfLines={expanded ? undefined : 2}>{cost.description}</Text>
          {cost.is_out_of_scope && <View style={rowStyles.outOfScopePill}><Text style={rowStyles.outOfScopePillText}>⚠️ Ponadprogramowy</Text></View>}
        </View>
        <View style={[rowStyles.statusBadge, { backgroundColor: EXTRA_STATUS_COLOR[cost.status] + '22' }]}>
          <Text style={[rowStyles.statusText, { color: EXTRA_STATUS_COLOR[cost.status] }]}>{EXTRA_STATUS_LABEL[cost.status]}</Text>
        </View>
      </View>
      <View style={[rowStyles.bottomRow, { borderTopColor: borderColor }]}>
        <Text style={[rowStyles.calcText, { color: subColor }]}>{fmt(cost.quantity)} × {fmt(cost.unit_price)} PLN</Text>
        <Text style={[rowStyles.totalText, { color: textColor }]}>{fmtPLN(cost.total_price)}</Text>
      </View>
      <View style={rowStyles.dateRow}>
        <Ionicons name="calendar-outline" size={11} color={subColor} />
        <Text style={[rowStyles.dateText, { color: subColor }]}>{' '}{new Date(cost.date).toLocaleDateString('pl-PL')}</Text>
      </View>
      {!!cost.notes && expanded && <Text style={[rowStyles.notes, { color: subColor }]}>{cost.notes}</Text>}
      <View style={[rowStyles.actionRow, { borderTopColor: borderColor }]}>
        <TouchableOpacity style={rowStyles.actionBtn} onPress={onEdit}><Ionicons name="pencil-outline" size={14} color="#6d28d9" /><Text style={[rowStyles.actionBtnText, { color: '#6d28d9' }]}>Edytuj</Text></TouchableOpacity>
        <TouchableOpacity style={rowStyles.actionBtn} onPress={onDelete}><Ionicons name="trash-outline" size={14} color="#ef4444" /><Text style={[rowStyles.actionBtnText, { color: '#ef4444' }]}>Usuń</Text></TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROW: CostItem (Materiał / Podwykonawca)
// ═══════════════════════════════════════════════════════════════════════════════
function CostItemRow({ item, onEdit, onDelete, isDark }: { item: CostItem; onEdit: () => void; onDelete: () => void; isDark: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const cardBg = isDark ? '#1f2937' : '#ffffff';
  const textColor = isDark ? '#f9fafb' : '#111827';
  const subColor = isDark ? '#9ca3af' : '#6b7280';
  const borderColor = isDark ? '#374151' : '#f3f4f6';
  const accentColor = item.category === 'subcontractor' ? '#3b82f6' : '#f59e0b';

  return (
    <TouchableOpacity style={[rowStyles.card, { backgroundColor: cardBg }]} onPress={() => setExpanded(v => !v)} onLongPress={() => Alert.alert(CATEGORY_LABEL[item.category], item.description, [{ text: 'Edytuj', onPress: onEdit }, { text: 'Usuń', style: 'destructive', onPress: onDelete }, { text: 'Anuluj', style: 'cancel' }])} activeOpacity={0.8}>
      <View style={rowStyles.topRow}>
        <View style={{ flex: 1, marginRight: 8 }}>
          <Text style={[rowStyles.desc, { color: textColor }]} numberOfLines={expanded ? undefined : 2}>{item.description}</Text>
          {!!item.supplier && <Text style={[rowStyles.subInfo, { color: subColor }]}><Ionicons name="business-outline" size={11} /> {item.supplier}</Text>}
        </View>
        <Text style={[rowStyles.totalText, { color: accentColor }]}>{fmtPLN(item.total_price)}</Text>
      </View>
      <View style={[rowStyles.bottomRow, { borderTopColor: borderColor }]}>
        <Text style={[rowStyles.calcText, { color: subColor }]}>{fmt(item.quantity)} × {fmt(item.unit_price)} PLN</Text>
        {!!item.invoice_number && <Text style={[rowStyles.calcText, { color: subColor }]}>FV: {item.invoice_number}</Text>}
      </View>
      <View style={rowStyles.dateRow}>
        <Ionicons name="calendar-outline" size={11} color={subColor} />
        <Text style={[rowStyles.dateText, { color: subColor }]}>{' '}{new Date(item.date).toLocaleDateString('pl-PL')}</Text>
      </View>
      <View style={[rowStyles.actionRow, { borderTopColor: borderColor }]}>
        <TouchableOpacity style={rowStyles.actionBtn} onPress={onEdit}><Ionicons name="pencil-outline" size={14} color={accentColor} /><Text style={[rowStyles.actionBtnText, { color: accentColor }]}>Edytuj</Text></TouchableOpacity>
        <TouchableOpacity style={rowStyles.actionBtn} onPress={onDelete}><Ionicons name="trash-outline" size={14} color="#ef4444" /><Text style={[rowStyles.actionBtnText, { color: '#ef4444' }]}>Usuń</Text></TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROW: LaborEntry (Robocizna)
// ═══════════════════════════════════════════════════════════════════════════════
function LaborRow({ entry, onEdit, onDelete, isDark }: { entry: LaborEntry; onEdit: () => void; onDelete: () => void; isDark: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const cardBg = isDark ? '#1f2937' : '#ffffff';
  const textColor = isDark ? '#f9fafb' : '#111827';
  const subColor = isDark ? '#9ca3af' : '#6b7280';
  const borderColor = isDark ? '#374151' : '#f3f4f6';
  const accentColor = '#10b981';
  const total = entry.hours * entry.hourly_rate;

  return (
    <TouchableOpacity style={[rowStyles.card, { backgroundColor: cardBg }]} onPress={() => setExpanded(v => !v)} onLongPress={() => Alert.alert('Robocizna', `${entry.worker_name}`, [{ text: 'Edytuj', onPress: onEdit }, { text: 'Usuń', style: 'destructive', onPress: onDelete }, { text: 'Anuluj', style: 'cancel' }])} activeOpacity={0.8}>
      <View style={rowStyles.topRow}>
        <View style={{ flex: 1, marginRight: 8 }}>
          <Text style={[rowStyles.desc, { color: textColor }]}>{entry.worker_name}</Text>
          {!!entry.description && (
            <Text style={[rowStyles.subInfo, { color: subColor }]} numberOfLines={expanded ? undefined : 1}>{entry.description}</Text>
          )}
        </View>
        <Text style={[rowStyles.totalText, { color: accentColor }]}>{fmtPLN(total)}</Text>
      </View>
      <View style={[rowStyles.bottomRow, { borderTopColor: borderColor }]}>
        <Text style={[rowStyles.calcText, { color: subColor }]}>{fmt(entry.hours)} h × {fmt(entry.hourly_rate)} PLN/h</Text>
      </View>
      <View style={rowStyles.dateRow}>
        <Ionicons name="calendar-outline" size={11} color={subColor} />
        <Text style={[rowStyles.dateText, { color: subColor }]}>{' '}{new Date(entry.date).toLocaleDateString('pl-PL')}</Text>
      </View>
      <View style={[rowStyles.actionRow, { borderTopColor: borderColor }]}>
        <TouchableOpacity style={rowStyles.actionBtn} onPress={onEdit}><Ionicons name="pencil-outline" size={14} color={accentColor} /><Text style={[rowStyles.actionBtnText, { color: accentColor }]}>Edytuj</Text></TouchableOpacity>
        <TouchableOpacity style={rowStyles.actionBtn} onPress={onDelete}><Ionicons name="trash-outline" size={14} color="#ef4444" /><Text style={[rowStyles.actionBtnText, { color: '#ef4444' }]}>Usuń</Text></TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN SCREEN: ProjectDetailScreen
// ═══════════════════════════════════════════════════════════════════════════════
export default function ProjectDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const navigation = useNavigation();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();

  // Data
  const [project, setProject] = useState<Project | null>(null);
  const [extraCosts, setExtraCosts] = useState<ExtraCost[]>([]);
  const [costItems, setCostItems] = useState<CostItem[]>([]);
  const [laborEntries, setLaborEntries] = useState<LaborEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Tab
  const [activeTab, setActiveTab] = useState<TabKey>('materials');

  // Modal state
  const [showAddExtra, setShowAddExtra] = useState(false);
  const [editingExtra, setEditingExtra] = useState<ExtraCost | null>(null);
  const [showAddCostItem, setShowAddCostItem] = useState(false);
  const [editingCostItem, setEditingCostItem] = useState<CostItem | null>(null);
  const [showAddLabor, setShowAddLabor] = useState(false);
  const [editingLabor, setEditingLabor] = useState<LaborEntry | null>(null);
  const [showSend, setShowSend] = useState(false);

  // Colors
  const bgColor = isDark ? '#111827' : '#f9fafb';
  const textColor = isDark ? '#f9fafb' : '#111827';
  const subColor = isDark ? '#9ca3af' : '#6b7280';
  const cardBg = isDark ? '#1f2937' : '#ffffff';
  const borderColor = isDark ? '#374151' : '#e5e7eb';

  // Fetch all data
  const fetchAll = useCallback(async () => {
    if (!id) return;
    try {
      const [proj, extra, items, labor] = await Promise.all([
        projectsApi.get(id),
        extraCostsApi.list(id),
        costItemsApi.list(id),
        laborApi.list(id),
      ]);
      setProject(proj);
      setExtraCosts(extra);
      setCostItems(items);
      setLaborEntries(labor);
      navigation.setOptions({ title: proj.name });
    } catch {
      Alert.alert('Błąd', 'Nie udało się pobrać danych projektu.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id, navigation]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ─── Handlers: ExtraCost ──────────────────────────────────────────────────
  const handleSaveExtra = async (data: CreateExtraCostData, _attachment: AttachedFile | null) => {
    if (!id) return;
    try {
      if (editingExtra) {
        const updated = await extraCostsApi.update(editingExtra.id, data);
        setExtraCosts(prev => prev.map(c => c.id === editingExtra.id ? updated : c));
      } else {
        const created = await extraCostsApi.create(id, data);
        setExtraCosts(prev => [created, ...prev]);
      }
      setShowAddExtra(false);
    } catch (err: any) {
      const msg = err?.response?.data?.error ?? 'Nie udało się zapisać kosztu.';
      Alert.alert('Błąd zapisu', msg);
      throw err;
    }
  };

  const handleDeleteExtra = (cost: ExtraCost) => {
    Alert.alert('Usuń koszt dodatkowy', `Czy usunąć "${cost.description}"?`, [
      { text: 'Anuluj', style: 'cancel' },
      { text: 'Usuń', style: 'destructive', onPress: async () => {
        try { await extraCostsApi.remove(cost.id); setExtraCosts(prev => prev.filter(c => c.id !== cost.id)); }
        catch { Alert.alert('Błąd', 'Nie udało się usunąć.'); }
      }},
    ]);
  };

  // ─── Handlers: CostItem ────────────────────────────────────────────────────
  const handleSaveCostItem = async (data: CreateCostItemData) => {
    if (!id) return;
    try {
      if (editingCostItem) {
        const updated = await costItemsApi.update(editingCostItem.id, data);
        setCostItems(prev => prev.map(c => c.id === editingCostItem.id ? updated : c));
      } else {
        const created = await costItemsApi.create(id, data);
        setCostItems(prev => [created, ...prev]);
      }
      setShowAddCostItem(false);
    } catch (err: any) {
      const msg = err?.response?.data?.error ?? 'Nie udało się zapisać.';
      Alert.alert('Błąd zapisu', msg);
      throw err;
    }
  };

  const handleDeleteCostItem = (item: CostItem) => {
    Alert.alert('Usuń pozycję', `Czy usunąć "${item.description}"?`, [
      { text: 'Anuluj', style: 'cancel' },
      { text: 'Usuń', style: 'destructive', onPress: async () => {
        try { await costItemsApi.remove(item.id); setCostItems(prev => prev.filter(c => c.id !== item.id)); }
        catch { Alert.alert('Błąd', 'Nie udało się usunąć.'); }
      }},
    ]);
  };

  // ─── Handlers: LaborEntry ─────────────────────────────────────────────────
  const handleSaveLabor = async (data: CreateLaborEntryData) => {
    if (!id) return;
    try {
      if (editingLabor) {
        const updated = await laborApi.update(editingLabor.id, data);
        setLaborEntries(prev => prev.map(e => e.id === editingLabor.id ? updated : e));
      } else {
        const created = await laborApi.create(id, data);
        setLaborEntries(prev => [created, ...prev]);
      }
      setShowAddLabor(false);
    } catch (err: any) {
      const msg = err?.response?.data?.error ?? 'Nie udało się zapisać.';
      Alert.alert('Błąd zapisu', msg);
      throw err;
    }
  };

  const handleDeleteLabor = (entry: LaborEntry) => {
    Alert.alert('Usuń robociznę', `Czy usunąć wpis: ${entry.worker_name}?`, [
      { text: 'Anuluj', style: 'cancel' },
      { text: 'Usuń', style: 'destructive', onPress: async () => {
        try { await laborApi.remove(entry.id); setLaborEntries(prev => prev.filter(e => e.id !== entry.id)); }
        catch { Alert.alert('Błąd', 'Nie udało się usunąć.'); }
      }},
    ]);
  };

  // ─── Tab data ─────────────────────────────────────────────────────────────
  const materials = useMemo(() => costItems.filter(i => i.category === 'materials'), [costItems]);
  const subcontractors = useMemo(() => costItems.filter(i => i.category === 'subcontractor'), [costItems]);

  const tabData = useMemo((): any[] => {
    switch (activeTab) {
      case 'materials':    return materials;
      case 'subcontractor': return subcontractors;
      case 'labor':        return laborEntries;
      case 'extra':        return extraCosts;
      default:             return [];
    }
  }, [activeTab, materials, subcontractors, laborEntries, extraCosts]);

  const tabTotal = useMemo(() => {
    switch (activeTab) {
      case 'materials':    return materials.reduce((s, i) => s + i.total_price, 0);
      case 'subcontractor': return subcontractors.reduce((s, i) => s + i.total_price, 0);
      case 'labor':        return laborEntries.reduce((s, e) => s + e.hours * e.hourly_rate, 0);
      case 'extra':        return extraCosts.reduce((s, c) => s + c.total_price, 0);
      default:             return 0;
    }
  }, [activeTab, materials, subcontractors, laborEntries, extraCosts]);

  const grandTotal = useMemo(() => {
    const mat = costItems.reduce((s, i) => s + i.total_price, 0);
    const lab = laborEntries.reduce((s, e) => s + e.hours * e.hourly_rate, 0);
    const ext = extraCosts.reduce((s, c) => s + c.total_price, 0);
    return mat + lab + ext;
  }, [costItems, laborEntries, extraCosts]);

  const handleAddPress = () => {
    switch (activeTab) {
      case 'materials':
      case 'subcontractor':
        setEditingCostItem(null);
        setShowAddCostItem(true);
        break;
      case 'labor':
        setEditingLabor(null);
        setShowAddLabor(true);
        break;
      case 'extra':
        setEditingExtra(null);
        setShowAddExtra(true);
        break;
    }
  };

  const currentTabInfo = TABS.find(t => t.key === activeTab)!;

  const PROJECT_STATUS_LABEL: Record<string, string> = { active: 'Aktywny', completed: 'Zakończony', archived: 'Archiwum', on_hold: 'Wstrzymany' };
  const PROJECT_STATUS_COLOR: Record<string, string> = { active: '#059669', completed: '#3b82f6', archived: '#9ca3af', on_hold: '#f97316' };

  const emptyMessages: Record<TabKey, { title: string; sub: string }> = {
    materials:     { title: 'Brak materiałów', sub: 'Dodaj pierwsze materiały użyte w projekcie.' },
    subcontractor: { title: 'Brak podwykonawców', sub: 'Dodaj koszty podwykonawców.' },
    labor:         { title: 'Brak wpisów robocizny', sub: 'Dodaj wpisy dotyczące pracy ekipy.' },
    extra:         { title: 'Brak kosztów dodatkowych', sub: 'Dodaj koszty wykraczające poza zakres projektu.' },
  };

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: bgColor }}>
        <ActivityIndicator color="#6d28d9" size="large" />
        <Text style={{ marginTop: 12, color: subColor }}>Ładowanie...</Text>
      </View>
    );
  }

  if (!project) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: bgColor }}>
        <Ionicons name="alert-circle-outline" size={48} color={subColor} />
        <Text style={{ marginTop: 12, color: textColor, fontSize: 16 }}>Nie znaleziono projektu</Text>
      </View>
    );
  }

  const statusColor = PROJECT_STATUS_COLOR[project.status] ?? '#9ca3af';
  const statusLabel = PROJECT_STATUS_LABEL[project.status] ?? project.status;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: bgColor }} edges={['bottom']}>
      <FlatList
        data={tabData}
        keyExtractor={(item: any) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchAll(); }} tintColor="#6d28d9" colors={['#6d28d9']} />}
        contentContainerStyle={{ paddingBottom: 120 }}
        ListHeaderComponent={
          <>
            {/* Project header */}
            <View style={[pStyles.projectHeader, { backgroundColor: cardBg }]}>
              <View style={pStyles.projectHeaderTop}>
                <View style={{ flex: 1 }}>
                  <Text style={[pStyles.projectName, { color: textColor }]}>{project.name}</Text>
                  <View style={pStyles.projectMetaRow}>
                    <Ionicons name="person-outline" size={13} color={subColor} />
                    <Text style={[pStyles.projectMeta, { color: subColor }]}>{' '}{project.client_name}</Text>
                  </View>
                  {!!project.address && (
                    <View style={pStyles.projectMetaRow}>
                      <Ionicons name="location-outline" size={13} color={subColor} />
                      <Text style={[pStyles.projectMeta, { color: subColor }]}>{' '}{project.address}</Text>
                    </View>
                  )}
                </View>
                <View style={[pStyles.statusBadge, { backgroundColor: statusColor + '22' }]}>
                  <View style={[pStyles.statusDot, { backgroundColor: statusColor }]} />
                  <Text style={[pStyles.statusLabel, { color: statusColor }]}>{statusLabel}</Text>
                </View>
              </View>
              <View style={[pStyles.budgetRow, { backgroundColor: '#059669' + '10', borderColor: '#059669' + '30' }]}>
                <Ionicons name="cash-outline" size={16} color="#059669" />
                <Text style={[pStyles.budgetLabel, { color: subColor }]}>{' '}Budżet:{'  '}</Text>
                <Text style={pStyles.budgetValue}>{fmtPLN(project.budget_amount)}</Text>
                <View style={{ flex: 1 }} />
                <Text style={[pStyles.budgetLabel, { color: subColor }]}>Koszty łącznie:{'  '}</Text>
                <Text style={[pStyles.budgetValue, { color: grandTotal > (project.budget_amount ?? 0) ? '#ef4444' : '#059669' }]}>{fmtPLN(grandTotal)}</Text>
              </View>
            </View>

            {/* Tab bar */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ paddingHorizontal: 12, marginBottom: 8 }} contentContainerStyle={{ gap: 6, paddingHorizontal: 4 }}>
              {TABS.map(tab => {
                const isActive = tab.key === activeTab;
                const count = tab.key === 'materials' ? materials.length : tab.key === 'subcontractor' ? subcontractors.length : tab.key === 'labor' ? laborEntries.length : extraCosts.length;
                return (
                  <TouchableOpacity
                    key={tab.key}
                    style={[pStyles.tabBtn, { backgroundColor: isActive ? tab.color : cardBg, borderColor: isActive ? tab.color : borderColor }]}
                    onPress={() => setActiveTab(tab.key)}
                  >
                    <Ionicons name={tab.icon} size={15} color={isActive ? '#ffffff' : tab.color} />
                    <Text style={[pStyles.tabBtnLabel, { color: isActive ? '#ffffff' : textColor }]}>{tab.label}</Text>
                    <View style={[pStyles.tabCount, { backgroundColor: isActive ? 'rgba(255,255,255,0.25)' : tab.color + '20' }]}>
                      <Text style={[pStyles.tabCountText, { color: isActive ? '#ffffff' : tab.color }]}>{count}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            {/* Section header */}
            <View style={[pStyles.sectionHeader, { borderBottomColor: borderColor }]}>
              <View>
                <Text style={[pStyles.sectionTitle, { color: textColor }]}>{currentTabInfo.label}</Text>
                <Text style={[pStyles.sectionSub, { color: subColor }]}>Łącznie: {fmtPLN(tabTotal)}</Text>
              </View>
              <TouchableOpacity style={[pStyles.addBtn, { backgroundColor: currentTabInfo.color }]} onPress={handleAddPress}>
                <Ionicons name="add" size={16} color="#ffffff" />
                <Text style={pStyles.addBtnText}>Dodaj</Text>
              </TouchableOpacity>
            </View>
          </>
        }
        renderItem={({ item }: { item: any }) => (
          <View style={{ paddingHorizontal: 16, marginBottom: 10 }}>
            {activeTab === 'extra' && (
              <ExtraCostRow
                cost={item as ExtraCost}
                onEdit={() => { setEditingExtra(item); setShowAddExtra(true); }}
                onDelete={() => handleDeleteExtra(item)}
                isDark={isDark}
              />
            )}
            {(activeTab === 'materials' || activeTab === 'subcontractor') && (
              <CostItemRow
                item={item as CostItem}
                onEdit={() => { setEditingCostItem(item); setShowAddCostItem(true); }}
                onDelete={() => handleDeleteCostItem(item)}
                isDark={isDark}
              />
            )}
            {activeTab === 'labor' && (
              <LaborRow
                entry={item as LaborEntry}
                onEdit={() => { setEditingLabor(item); setShowAddLabor(true); }}
                onDelete={() => handleDeleteLabor(item)}
                isDark={isDark}
              />
            )}
          </View>
        )}
        ListEmptyComponent={
          <View style={pStyles.emptyState}>
            <Ionicons name={currentTabInfo.icon} size={48} color={subColor} />
            <Text style={[pStyles.emptyTitle, { color: textColor }]}>{emptyMessages[activeTab].title}</Text>
            <Text style={[pStyles.emptySub, { color: subColor }]}>{emptyMessages[activeTab].sub}</Text>
            <TouchableOpacity style={[pStyles.emptyAddBtn, { borderColor: currentTabInfo.color }]} onPress={handleAddPress}>
              <Ionicons name="add-circle-outline" size={18} color={currentTabInfo.color} style={{ marginRight: 6 }} />
              <Text style={{ color: currentTabInfo.color, fontWeight: '600' }}>Dodaj teraz</Text>
            </TouchableOpacity>
          </View>
        }
        showsVerticalScrollIndicator={false}
      />

      {/* Bottom bar */}
      <View style={[pStyles.bottomBar, { bottom: insets.bottom + 8, backgroundColor: cardBg, borderColor: borderColor }]}>
        <TouchableOpacity style={[pStyles.addFab, { backgroundColor: currentTabInfo.color }]} onPress={handleAddPress}>
          <Ionicons name="add" size={20} color="#ffffff" />
          <Text style={pStyles.addFabText}>Dodaj {currentTabInfo.label}</Text>
        </TouchableOpacity>
        {activeTab === 'extra' && extraCosts.length > 0 && (
          <TouchableOpacity style={pStyles.sendFab} onPress={() => setShowSend(true)}>
            <Ionicons name="mail-outline" size={18} color="#ffffff" />
            <Text style={pStyles.sendFabText}>Wyślij</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Modals */}
      <AddExtraCostModal
        visible={showAddExtra}
        onClose={() => { setShowAddExtra(false); setEditingExtra(null); }}
        onSave={handleSaveExtra}
        editItem={editingExtra}
        isDark={isDark}
      />
      <AddCostItemModal
        visible={showAddCostItem}
        onClose={() => { setShowAddCostItem(false); setEditingCostItem(null); }}
        onSave={handleSaveCostItem}
        editItem={editingCostItem}
        category={activeTab === 'subcontractor' ? 'subcontractor' : 'materials'}
        isDark={isDark}
      />
      <AddLaborModal
        visible={showAddLabor}
        onClose={() => { setShowAddLabor(false); setEditingLabor(null); }}
        onSave={handleSaveLabor}
        editItem={editingLabor}
        isDark={isDark}
      />
      {project && (
        <SendToClientModal
          visible={showSend}
          onClose={() => setShowSend(false)}
          projectName={project.name}
          costs={extraCosts}
          projectId={project.id}
          onSent={fetchAll}
          isDark={isDark}
        />
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const mStyles = StyleSheet.create({
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14 },
  modalHeaderTitle: { color: '#ffffff', fontSize: 17, fontWeight: '700' },
  modalHeaderBtn: { minWidth: 60, alignItems: 'center' },
  modalHeaderBtnText: { color: 'rgba(255,255,255,0.85)', fontSize: 15 },
  modalHeaderBtnBold: { fontWeight: '700', color: '#ffffff' },
  scrollContent: { padding: 16, paddingBottom: 40 },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginBottom: 6 },
  row: { flexDirection: 'row' },
  textInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, minHeight: 44 },
  textArea: { minHeight: 80, paddingTop: 10 },
  totalPreview: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 12, marginBottom: 16 },
  totalLabel: { fontSize: 14 },
  totalValue: { fontSize: 18, fontWeight: '700', color: '#6d28d9' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 16 },
  toggleTitle: { fontSize: 15, fontWeight: '600', marginBottom: 2 },
  toggleSub: { fontSize: 12 },
  attachRow: { flexDirection: 'row', marginBottom: 8 },
  attachBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderRadius: 8, paddingVertical: 10, gap: 4 },
  attachBtnFull: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 8, paddingVertical: 10, marginBottom: 8 },
  attachBtnText: { fontSize: 13, fontWeight: '600' },
  attachPreview: { borderWidth: 1, borderRadius: 8, padding: 10, marginTop: 4 },
  photoPreviewRow: { flexDirection: 'row', alignItems: 'center' },
  photoThumb: { width: 56, height: 56, borderRadius: 6, backgroundColor: '#e5e7eb' },
  attachName: { fontSize: 13, fontWeight: '500' },
  saveBtn: { backgroundColor: '#6d28d9', borderRadius: 10, height: 50, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  saveBtnText: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
});

const sStyles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14 },
  headerTitle: { color: '#ffffff', fontSize: 17, fontWeight: '700' },
  content: { padding: 16, paddingBottom: 48 },
  sectionTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, marginBottom: 8 },
  costCheckRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 8 },
  checkbox: { width: 22, height: 22, borderRadius: 5, borderWidth: 2, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  costDesc: { fontSize: 14, fontWeight: '500', marginBottom: 2 },
  costAmount: { fontSize: 13, fontWeight: '700' },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20 },
  statusPillText: { fontSize: 10, fontWeight: '600' },
  totalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderRadius: 10, padding: 14, marginTop: 4, marginBottom: 20 },
  totalLabel: { fontSize: 14 },
  totalValue: { fontSize: 18, fontWeight: '700', color: '#059669' },
  divider: { height: 1, backgroundColor: '#e5e7eb', marginVertical: 16 },
  channelCard: { borderWidth: 1, borderRadius: 12, padding: 16, marginBottom: 12 },
  channelHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  channelTitle: { fontSize: 16, fontWeight: '700', marginLeft: 8 },
  emailInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, marginBottom: 10 },
  channelBtn: { borderRadius: 8, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', flexDirection: 'row' },
  channelBtnText: { color: '#ffffff', fontSize: 15, fontWeight: '700' },
  smsSub: { fontSize: 13, lineHeight: 18, marginBottom: 12 },
  orRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 8, marginBottom: 16 },
  orLine: { flex: 1, height: 1 },
  orText: { marginHorizontal: 12, fontSize: 13, fontWeight: '500' },
  cancelBtn: { borderWidth: 1, borderRadius: 10, paddingVertical: 13, alignItems: 'center', marginTop: 8 },
  cancelBtnText: { fontSize: 15, fontWeight: '600' },
});

const rowStyles = StyleSheet.create({
  card: { borderRadius: 12, padding: 14, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 6, elevation: 1 },
  topRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8 },
  desc: { fontSize: 15, fontWeight: '600', lineHeight: 20 },
  subInfo: { fontSize: 12, marginTop: 3, lineHeight: 16 },
  outOfScopePill: { marginTop: 4, alignSelf: 'flex-start', backgroundColor: '#f97316' + '20', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 20 },
  outOfScopePillText: { fontSize: 11, color: '#f97316', fontWeight: '600' },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, flexShrink: 0 },
  statusText: { fontSize: 11, fontWeight: '600' },
  bottomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, borderTopWidth: 1 },
  calcText: { fontSize: 12 },
  totalText: { fontSize: 15, fontWeight: '700' },
  dateRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  dateText: { fontSize: 11 },
  notes: { fontSize: 12, lineHeight: 16, marginTop: 6, fontStyle: 'italic' },
  actionRow: { flexDirection: 'row', borderTopWidth: 1, marginTop: 10, paddingTop: 8, gap: 16 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  actionBtnText: { fontSize: 12, fontWeight: '600' },
});

const pStyles = StyleSheet.create({
  projectHeader: { margin: 16, marginBottom: 12, borderRadius: 14, padding: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2 },
  projectHeaderTop: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 },
  projectName: { fontSize: 20, fontWeight: '800', marginBottom: 6, lineHeight: 26 },
  projectMetaRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 3 },
  projectMeta: { fontSize: 13 },
  statusBadge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, flexShrink: 0, marginLeft: 8 },
  statusDot: { width: 7, height: 7, borderRadius: 3.5, marginRight: 5 },
  statusLabel: { fontSize: 12, fontWeight: '600' },
  budgetRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, flexWrap: 'wrap', gap: 2 },
  budgetLabel: { fontSize: 13 },
  budgetValue: { fontSize: 15, fontWeight: '700', color: '#059669' },
  tabBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, borderWidth: 1.5, gap: 6 },
  tabBtnLabel: { fontSize: 13, fontWeight: '600' },
  tabCount: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 10 },
  tabCountText: { fontSize: 11, fontWeight: '700' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, marginBottom: 4 },
  sectionTitle: { fontSize: 17, fontWeight: '700' },
  sectionSub: { fontSize: 12, marginTop: 1 },
  addBtn: { flexDirection: 'row', alignItems: 'center', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, gap: 2 },
  addBtnText: { color: '#ffffff', fontSize: 14, fontWeight: '600' },
  emptyState: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 40 },
  emptyTitle: { fontSize: 17, fontWeight: '700', marginTop: 14, marginBottom: 6 },
  emptySub: { fontSize: 13, textAlign: 'center', lineHeight: 18, marginBottom: 20 },
  emptyAddBtn: { flexDirection: 'row', alignItems: 'center', borderWidth: 1.5, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10 },
  bottomBar: { position: 'absolute', left: 16, right: 16, borderRadius: 14, borderWidth: 1, padding: 8, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 12, elevation: 6, flexDirection: 'row', gap: 8 },
  addFab: { flex: 1, borderRadius: 10, paddingVertical: 13, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  addFabText: { color: '#ffffff', fontSize: 15, fontWeight: '700' },
  sendFab: { backgroundColor: '#6d28d9', borderRadius: 10, paddingVertical: 13, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  sendFabText: { color: '#ffffff', fontSize: 15, fontWeight: '700' },
});
