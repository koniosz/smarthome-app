#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  Smart Home Manager — Deploy na Mac mini (przez SSH)
#
#  WYMAGANIA na Mac mini (zrób raz przed użyciem):
#    1. Włącz Logowanie zdalne: Ustawienia → Ogólne → Udostępnianie → Remote Login
#    2. Zainstaluj Node.js:  https://nodejs.org  (wersja 20 LTS lub 22 LTS)
#    3. Wpisz poniżej adres IP Mac mini i nazwę użytkownika
#
#  UŻYCIE:
#    chmod +x deploy-to-mac-mini.sh
#    ./deploy-to-mac-mini.sh
# ═══════════════════════════════════════════════════════════════════

# ── KONFIGURACJA — wypełnij przed uruchomieniem ───────────────────
MAC_MINI_IP=""          # np. 192.168.1.100  (sprawdź: Ustawienia → Wi-Fi → Szczegóły)
MAC_MINI_USER=""        # np. konrad         (nazwa użytkownika na Mac mini)
REMOTE_DIR="/opt/smart-home-manager"   # katalog instalacji na Mac mini
PORT=4001
# ─────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'

echo ""
echo -e "${BOLD}🏠 Smart Home Manager — Deploy na Mac mini${NC}"
echo "═══════════════════════════════════════════"

# Sprawdź konfigurację
if [ -z "$MAC_MINI_IP" ] || [ -z "$MAC_MINI_USER" ]; then
  echo -e "${RED}❌ Uzupełnij MAC_MINI_IP i MAC_MINI_USER na górze skryptu!${NC}"
  echo ""
  echo "   Jak znaleźć IP Mac mini:"
  echo "   → Ustawienia systemowe → Wi-Fi → kliknij sieć → Szczegóły → adres IP"
  echo "   → lub: w Terminalu na Mac mini wpisz: ipconfig getifaddr en0"
  exit 1
fi

export PATH="/Users/konradsz/.nvm/versions/node/v24.13.0/bin:$PATH"
DIR="$(cd "$(dirname "$0")" && pwd)"

# ── 1. Budowanie frontendu lokalnie ──────────────────────────────
echo -e "${CYAN}🔨 Buduję frontend...${NC}"
cd "$DIR/frontend"
npm install --ignore-scripts --silent 2>&1 | tail -1
node node_modules/.bin/vite build 2>&1 | grep -E "built|✓|error" | tail -3
if [ ! -d "$DIR/frontend/dist" ]; then
  echo -e "${RED}❌ Błąd budowania frontendu!${NC}"; exit 1
fi
echo -e "${GREEN}✓ Frontend zbudowany${NC}"

# ── 2. Instalacja backendu na Mac mini ───────────────────────────
echo -e "${CYAN}📡 Łączę z Mac mini ($MAC_MINI_USER@$MAC_MINI_IP)...${NC}"

# Sprawdź połączenie SSH
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$MAC_MINI_USER@$MAC_MINI_IP" "echo ok" &>/dev/null; then
  echo -e "${YELLOW}⚠️  Brak klucza SSH — zostaniesz poproszony o hasło przy każdym kroku.${NC}"
  echo -e "   Tip: ssh-copy-id $MAC_MINI_USER@$MAC_MINI_IP  aby nie wpisywać hasła."
fi

echo -e "${CYAN}📦 Kopiuję pliki na Mac mini...${NC}"

# Utwórz katalog na Mac mini
ssh "$MAC_MINI_USER@$MAC_MINI_IP" "mkdir -p $REMOTE_DIR/frontend $REMOTE_DIR/backend"

# Kopiuj backend (bez node_modules i dist)
rsync -az --delete \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='data/attachments' \
  "$DIR/backend/" \
  "$MAC_MINI_USER@$MAC_MINI_IP:$REMOTE_DIR/backend/"

# Kopiuj zbudowany frontend
rsync -az --delete \
  "$DIR/frontend/dist/" \
  "$MAC_MINI_USER@$MAC_MINI_IP:$REMOTE_DIR/frontend/dist/"

# Kopiuj plik .env (z kluczem Anthropic)
if [ -f "$DIR/backend/.env" ]; then
  scp "$DIR/backend/.env" "$MAC_MINI_USER@$MAC_MINI_IP:$REMOTE_DIR/backend/.env"
fi

echo -e "${GREEN}✓ Pliki skopiowane${NC}"

# ── 3. Instalacja Node.js deps na Mac mini ────────────────────────
echo -e "${CYAN}📦 Instaluję zależności na Mac mini...${NC}"
ssh "$MAC_MINI_USER@$MAC_MINI_IP" "
  cd $REMOTE_DIR/backend
  npm install --ignore-scripts --omit=dev 2>&1 | tail -1
  echo 'Zależności zainstalowane'
"

# ── 4. Tworzenie skryptu startowego na Mac mini ───────────────────
echo -e "${CYAN}⚙️  Konfiguruję autostart...${NC}"
ssh "$MAC_MINI_USER@$MAC_MINI_IP" "cat > $REMOTE_DIR/start.sh << 'STARTSCRIPT'
#!/bin/bash
export PATH=\"\$HOME/.nvm/versions/node/\$(ls \$HOME/.nvm/versions/node/ 2>/dev/null | tail -1)/bin:/usr/local/bin:/opt/homebrew/bin:\$PATH\"
cd $REMOTE_DIR/backend
node node_modules/.bin/tsx src/index.ts
STARTSCRIPT
chmod +x $REMOTE_DIR/start.sh"

# Utwórz LaunchAgent do autostartowania przy logowaniu
PLIST_NAME="pl.smarthomemanager.app"
ssh "$MAC_MINI_USER@$MAC_MINI_IP" "
mkdir -p \$HOME/Library/LaunchAgents
cat > \$HOME/Library/LaunchAgents/${PLIST_NAME}.plist << PLISTEOF
<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>$REMOTE_DIR/start.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$REMOTE_DIR/app.log</string>
    <key>StandardErrorPath</key>
    <string>$REMOTE_DIR/app.log</string>
    <key>WorkingDirectory</key>
    <string>$REMOTE_DIR/backend</string>
</dict>
</plist>
PLISTEOF

# Zatrzymaj poprzednią instancję jeśli działa
launchctl unload \$HOME/Library/LaunchAgents/${PLIST_NAME}.plist 2>/dev/null || true
# Uruchom
launchctl load \$HOME/Library/LaunchAgents/${PLIST_NAME}.plist
echo 'LaunchAgent załadowany'
"

# ── 5. Podsumowanie ───────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}✅ Deploy zakończony!${NC}"
echo "═══════════════════════════════════════════"
echo -e "  ${BOLD}Adres dla zespołu:${NC}  ${YELLOW}http://${MAC_MINI_IP}:${PORT}${NC}"
echo ""
echo -e "  ${CYAN}Dane logowania:${NC}"
echo "    Login:  ks@smarthomecenter.pl"
echo "    Hasło:  admin123"
echo ""
echo -e "  ${CYAN}Przydatne komendy (SSH na Mac mini):${NC}"
echo "    Logi:      tail -f $REMOTE_DIR/app.log"
echo "    Restart:   launchctl kickstart -k gui/\$(id -u $MAC_MINI_USER)/${PLIST_NAME}"
echo "    Stop:      launchctl unload ~/Library/LaunchAgents/${PLIST_NAME}.plist"
echo ""
echo -e "  ${CYAN}Aby zaktualizować w przyszłości: uruchom ten skrypt ponownie${NC}"
echo "═══════════════════════════════════════════"
echo ""
