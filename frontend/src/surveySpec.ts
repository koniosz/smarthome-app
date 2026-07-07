// Specyfikacja ankiety Smart Home (v4) — wspólna dla SurveyPage (publiczna ankieta)
// i SurveyPanel (podgląd odpowiedzi w projekcie). Klucze systemów są kanoniczne;
// wartości odpowiedzi przechowujemy jako polskie etykiety (samoopisujące się dane),
// liczby jako number (suwaki/selecty — łatwe do dalszego przetwarzania).

export interface SurveySystem { key: string; icon: string; label: string }
export interface SurveyCategory { key: string; icon: string; title: string; systems: SurveySystem[] }

export const SURVEY_CATEGORIES: SurveyCategory[] = [
  {
    key: 'komfort', icon: '🛋️', title: 'Komfort',
    systems: [
      { key: 'lighting', icon: '💡', label: 'Oświetlenie' },
      { key: 'heating', icon: '🔥', label: 'Ogrzewanie' },
      { key: 'cooling', icon: '❄️', label: 'Klimatyzacja' },
      { key: 'ventilation', icon: '🌬️', label: 'Rekuperacja / wentylacja' },
      { key: 'blinds', icon: '🪟', label: 'Rolety / żaluzje / markizy' },
      { key: 'pergola', icon: '⛱️', label: 'Pergole / zadaszenia tarasowe' },
    ],
  },
  {
    key: 'bezpieczenstwo', icon: '🔒', title: 'Bezpieczeństwo',
    systems: [
      { key: 'alarm', icon: '🚨', label: 'System alarmowy' },
      { key: 'gates', icon: '🚪', label: 'Bramy' },
      { key: 'intercom', icon: '📞', label: 'Wideodomofon' },
      { key: 'cctv', icon: '📷', label: 'Monitoring CCTV' },
    ],
  },
  {
    key: 'multimedia', icon: '🎬', title: 'Multimedia',
    systems: [
      { key: 'network', icon: '🌐', label: 'Sieć i WiFi' },
      { key: 'audio', icon: '🔊', label: 'Multiroom Audio' },
      { key: 'av', icon: '🎬', label: 'Kino domowe / AV' },
    ],
  },
  {
    key: 'energia', icon: '⚡', title: 'Energia',
    systems: [
      { key: 'pv', icon: '☀️', label: 'Fotowoltaika i zarządzanie energią' },
      { key: 'ev', icon: '🔌', label: 'Ładowarka EV' },
    ],
  },
  {
    key: 'zewnetrze', icon: '🌳', title: 'Zewnętrze',
    systems: [
      { key: 'garden', icon: '🌳', label: 'Instalacje ogrodowe' },
      { key: 'spa', icon: '🏊', label: 'Basen / SPA / sauna' },
    ],
  },
]

export const SYSTEM_LABELS: Record<string, string> = Object.fromEntries(
  SURVEY_CATEGORIES.flatMap(c => c.systems.map(s => [s.key, `${s.icon} ${s.label}`]))
)

// Etykiety pól pytań dedykowanych (krok 3) — do wyświetlania odpowiedzi w panelu
export const DETAIL_FIELD_LABELS: Record<string, Record<string, string>> = {
  lighting: { control_types: 'Rodzaj sterowania', circuits_count: 'Liczba obwodów/stref', daylight_automation: 'Automatyka wg słońca' },
  heating: { install_types: 'Typ instalacji', heat_source: 'Źródło ciepła', zones_count: 'Liczba stref grzewczych' },
  cooling: { unit_type: 'Typ', rooms_count: 'Liczba pomieszczeń', brand: 'Model/producent' },
  ventilation: { air_quality_sensors: 'Czujniki jakości powietrza', auto_control: 'Automatyczne sterowanie' },
  blinds: { types: 'Typ', openings_count: 'Liczba okien/otworów', weather_sensors: 'Czujniki wiatru/słońca' },
  pergola: { types: 'Typ', count_dimensions: 'Liczba sztuk i wymiary', rain_wind_sensor: 'Czujnik deszczu/wiatru', heat_light_integration: 'Integracja z oświetleniem/ogrzewaniem' },
  alarm: { project: 'Projekt systemu' },
  gates: { garage: 'Brama garażowa', entry: 'Brama wjazdowa' },
  intercom: { panels_count: 'Panele zewnętrzne', monitors_count: 'Monitory wewnętrzne', phone_integration: 'Integracja z telefonem', lock_integration: 'Integracja z zamkiem/bramą' },
  cctv: { project: 'Projekt systemu' },
  network: { project: 'Projekt systemu' },
  audio: { zones_count: 'Liczba stref audio', sources: 'Główne źródła', central_integration: 'Integracja z centralnym sterowaniem' },
  av: { room_type: 'Pomieszczenie', display: 'TV / Projektor', audio_config: 'Konfiguracja audio', universal_remote: 'Jeden uniwersalny pilot/panel' },
  garden: { garden_lighting: 'Oświetlenie ogrodowe', irrigation: 'Podlewanie — integracja', irrigation_brand: 'Sterownik/producent nawadniania' },
  pv: { smart_integration: 'Integracja ze smart home', energy_charts: 'Wykresy produkcji/zużycia' },
  ev: { smart_integration: 'Integracja ze smart home', energy_charts: 'Wykresy produkcji/zużycia' },
  spa: { types: 'Rodzaj', automation: 'Zakres automatyzacji' },
}

// Etykiety pól kroku 1 i 4 — do panelu odpowiedzi
export const SURVEY_FIELD_LABELS: Record<string, string> = {
  building_type: 'Typ budynku',
  building_state: 'Stan budynku',
  area_m2: 'Powierzchnia (m²)',
  floors_count: 'Liczba kondygnacji',
  rooms_count: 'Liczba pokoi / stref',
  location: 'Miasto / region',
  completion_date: 'Planowany termin realizacji',
  control_methods: 'Preferowany sposób sterowania',
  automation_level: 'Poziom automatyzacji',
  existing_systems: 'Istniejące systemy smart home',
  priorities: 'Na czym najbardziej zależy',
  phasing: 'Podejście do realizacji',
  timeline_urgency: 'Pilność realizacji',
  project_description: 'Opis projektu',
}
